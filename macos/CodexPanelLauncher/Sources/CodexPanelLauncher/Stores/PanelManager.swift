import AppKit
import Darwin
import Foundation

func installedPanelVersion(from infoDictionary: [String: Any]?) -> String {
  for key in ["CodexPanelVersion", "CFBundleShortVersionString"] {
    if let value = infoDictionary?[key] as? String {
      let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
      if !trimmed.isEmpty { return trimmed }
    }
  }
  return "development"
}

func sanitizedPanelProcessEnvironment(
  inheriting inherited: [String: String],
  pathValue: String,
  dataDirectory: String,
  panelPort: Int,
  codexExecutablePath: String,
  runtimeFilePath: String
) -> [String: String] {
  let blockedKeys = Set([
    "NODE_OPTIONS",
    "NODE_PATH",
    "NPM_CONFIG_NODE_OPTIONS",
    "BASH_ENV",
    "ENV",
    "ZDOTDIR",
    "CODEX_TASKBOARD_PORT",
    "CODEX_TASKBOARD_RUNTIME_FILE",
  ])
  var environment = inherited.filter { key, _ in
    !blockedKeys.contains(key)
      && !key.hasPrefix("CODEX_PANEL_")
      && !key.hasPrefix("CODEX_TASKBOARD_")
      && !key.hasPrefix("DYLD_")
      && !key.hasPrefix("LD_")
  }
  environment["PATH"] = pathValue
  environment["CODEX_PANEL_HOST"] = "127.0.0.1"
  environment["CODEX_PANEL_DATA_DIR"] = dataDirectory
  environment["CODEX_PANEL_PORT"] = String(panelPort)
  environment["CODEX_PANEL_RUNTIME_FILE"] = runtimeFilePath
  environment["CODEX_EXECUTABLE"] = codexExecutablePath
  return environment
}

@MainActor
final class PanelManager: ObservableObject {
  @Published private(set) var panelStatus = ComponentStatus(
    title: "Panel 服务",
    detail: "正在检查",
    systemImage: "server.rack",
    level: .working
  )
  @Published private(set) var codexStatus = ComponentStatus(
    title: "Codex",
    detail: "正在检查",
    systemImage: "terminal",
    level: .working
  )
  @Published private(set) var integrationStatus = ComponentStatus(
    title: "内嵌集成",
    detail: "正在检查",
    systemImage: "rectangle.split.3x1",
    level: .working
  )
  @Published private(set) var isBusy = false
  @Published private(set) var isCheckingForUpdates = false
  @Published private(set) var updateMessage = "尚未检查更新"
  @Published private(set) var availableReleaseVersion: String?
  @Published var lastError: String?

  private let configuration: LauncherConfiguration?
  private var configurationError: String?
  private var panelProcess: Process?
  private var integrationProcess: Process?
  private var panelLogHandle: FileHandle?
  private var integrationLogHandle: FileHandle?
  private var monitoringTask: Task<Void, Never>?
  private var activeCDPPort: Int?
  private var integrationStartupToken: String?
  private var availableReleaseURL: URL?
  private var recoveryPolicy = IntegrationRecoveryPolicy()
  private var recoveryTask: Task<Void, Never>?
  private var recoveryGeneration = 0
  private var lifecycleGeneration = 0
  private var panelGeneration = 0
  private var integrationGeneration = 0
  private var didActivate = false
  private var didCheckForUpdates = false
  private var desiredRunning = false
  private var isShuttingDown = false

  init(configurationResult: Result<LauncherConfiguration, Error>) {
    switch configurationResult {
    case .success(let configuration):
      self.configuration = configuration
    case .failure(let error):
      configuration = nil
      configurationError = error.localizedDescription
      lastError = error.localizedDescription
    }
  }

  var isRunning: Bool {
    panelStatus.level == .healthy && integrationStatus.level == .healthy
  }

  var currentVersion: String {
    installedPanelVersion(from: Bundle.main.infoDictionary)
  }

  func activate() async {
    guard !didActivate else { return }
    didActivate = true
    startMonitoring()
    Task { [weak self] in
      await self?.checkForUpdates(startup: true)
    }
    guard configuration != nil else {
      await refreshStatuses()
      return
    }

    desiredRunning = true
    let lifecycleGeneration = self.lifecycleGeneration
    isBusy = true
    defer { isBusy = false }
    do {
      let autoConnect = defaultedPreference(
        forKey: PreferenceKey.autoConnectCodex,
        defaultValue: true
      )
      if autoConnect {
        let port = try await prepareIntegrationPort()
        try await retireExistingInjectors(port: port)
      }
      try await startPanelService(lifecycleGeneration: lifecycleGeneration)
      if autoConnect {
        let shouldOpen = defaultedPreference(
          forKey: PreferenceKey.autoOpenPanel,
          defaultValue: true
        )
        try await startIntegration(
          openPanel: shouldOpen,
          lifecycleGeneration: lifecycleGeneration
        )
      }
      lastError = nil
    } catch {
      let message = error.localizedDescription
      lastError = message
      NSLog("Codex Panel activation failed: %@", message)
    }
    await refreshStatuses()
  }

  func startAll(openPanel: Bool = true) async {
    guard !isBusy else { return }
    desiredRunning = true
    recoveryPolicy.reset()
    cancelIntegrationRecovery()
    let lifecycleGeneration = self.lifecycleGeneration
    isBusy = true
    defer { isBusy = false }
    do {
      if integrationProcess?.isRunning != true {
        let port = try await prepareIntegrationPort()
        try await retireExistingInjectors(port: port)
      }
      try await startPanelService(lifecycleGeneration: lifecycleGeneration)
      try await startIntegration(
        openPanel: openPanel,
        lifecycleGeneration: lifecycleGeneration
      )
      lastError = nil
    } catch {
      lastError = error.localizedDescription
    }
    await refreshStatuses()
  }

  func stopAll() async {
    guard !isBusy else { return }
    desiredRunning = false
    cancelIntegrationRecovery()
    isBusy = true
    defer { isBusy = false }
    await terminateManagedProcesses()
    lastError = nil
    await refreshStatuses()
  }

  func restartAll() async {
    guard !isBusy else { return }
    desiredRunning = false
    cancelIntegrationRecovery()
    isBusy = true
    defer { isBusy = false }
    await terminateManagedProcesses()
    desiredRunning = true
    recoveryPolicy.reset()
    let lifecycleGeneration = self.lifecycleGeneration
    do {
      let port = try await prepareIntegrationPort()
      try await retireExistingInjectors(port: port)
      try await startPanelService(lifecycleGeneration: lifecycleGeneration)
      try await startIntegration(
        openPanel: false,
        lifecycleGeneration: lifecycleGeneration
      )
      lastError = nil
    } catch {
      lastError = error.localizedDescription
    }
    await refreshStatuses()
  }

  func openEmbeddedPanel() async {
    guard let configuration else {
      lastError = configurationError
      return
    }
    if integrationProcess?.isRunning != true {
      await startAll(openPanel: true)
      return
    }

    isBusy = true
    defer { isBusy = false }
    do {
      guard let startupToken = integrationStartupToken else {
        throw ManagerError.integrationUnavailable
      }
      _ = try await runOneShotInjector([
        "--control", "open",
        "--startup-token", startupToken,
      ])
      _ = try await NSWorkspace.shared.openApplication(
        at: URL(fileURLWithPath: configuration.codexAppPath),
        configuration: NSWorkspace.OpenConfiguration()
      )
      lastError = nil
    } catch {
      lastError = error.localizedDescription
    }
    await refreshStatuses()
  }

  func openBrowserPanel() {
    guard let configuration else {
      lastError = configurationError
      return
    }
    NSWorkspace.shared.open(configuration.panelURL)
  }

  func openLog() {
    guard let configuration else {
      lastError = configurationError
      return
    }
    ensureLogFile(configuration.logURL)
    NSWorkspace.shared.open(configuration.logURL)
  }

  func revealDataDirectory() {
    guard let configuration else {
      lastError = configurationError
      return
    }
    try? FileManager.default.createDirectory(
      at: configuration.dataURL,
      withIntermediateDirectories: true
    )
    NSWorkspace.shared.activateFileViewerSelecting([configuration.dataURL])
  }

  func refresh() async {
    await refreshStatuses()
  }

  func checkForUpdates(startup: Bool = false) async {
    if startup {
      guard !didCheckForUpdates else { return }
      didCheckForUpdates = true
    }
    guard !isCheckingForUpdates else { return }
    isCheckingForUpdates = true
    if !startup { updateMessage = "正在检查更新..." }
    defer { isCheckingForUpdates = false }

    do {
      switch try await ReleaseUpdateChecker().check(currentVersion: currentVersion) {
      case .noPublishedRelease:
        availableReleaseVersion = nil
        availableReleaseURL = nil
        updateMessage = "Fork 暂无已发布版本"
      case .current:
        availableReleaseVersion = nil
        availableReleaseURL = nil
        updateMessage = "当前已是最新版本"
      case .available(let version, let url):
        availableReleaseVersion = version
        availableReleaseURL = url
        updateMessage = "发现新版本 \(version)"
      }
    } catch {
      availableReleaseVersion = nil
      availableReleaseURL = nil
      updateMessage = startup ? "自动检查更新失败" : error.localizedDescription
    }
  }

  func openAvailableRelease() {
    guard let availableReleaseURL else { return }
    NSWorkspace.shared.open(availableReleaseURL)
  }

  func shutdown() async {
    guard !isShuttingDown else { return }
    isShuttingDown = true
    desiredRunning = false
    monitoringTask?.cancel()
    cancelIntegrationRecovery()
    await terminateManagedProcesses()
    integrationLogHandle?.closeFile()
    panelLogHandle?.closeFile()
  }

  private func startMonitoring() {
    guard monitoringTask == nil else { return }
    monitoringTask = Task { [weak self] in
      while !Task.isCancelled {
        await self?.refreshStatuses()
        try? await Task.sleep(nanoseconds: 2_000_000_000)
      }
    }
  }

  private func refreshStatuses() async {
    guard let configuration else {
      let detail = configurationError ?? "配置不可用"
      panelStatus = ComponentStatus(
        title: "Panel 服务",
        detail: detail,
        systemImage: "exclamationmark.triangle",
        level: .failed
      )
      codexStatus = ComponentStatus(
        title: "Codex",
        detail: "状态不可用",
        systemImage: "terminal",
        level: .idle
      )
      integrationStatus = ComponentStatus(
        title: "内嵌集成",
        detail: "状态不可用",
        systemImage: "rectangle.split.3x1",
        level: .idle
      )
      return
    }

    let port = activeCDPPort ?? configuration.cdpPort
    async let panelReachable = endpointIsReachable(configuration.panelHealthURL)
    async let cdpReachable = endpointIsReachable(configuration.cdpVersionURL(port: port))
    let codexRunning = processIsRunning(named: "ChatGPT")
    let (panelIsReachable, cdpIsReachable) = await (panelReachable, cdpReachable)
    let integrationIsReady: Bool
    if integrationProcess?.isRunning == true {
      integrationIsReady = (try? await assertIntegrationReady(port: port)) != nil
    } else {
      integrationIsReady = false
    }

    panelStatus = panelIsReachable
      ? ComponentStatus(
        title: "Panel 服务",
        detail: panelProcess?.isRunning == true ? "运行中" : "运行中（外部）",
        systemImage: "server.rack",
        level: .healthy
      )
      : ComponentStatus(
        title: "Panel 服务",
        detail: panelProcess?.isRunning == true ? "正在启动" : "已停止",
        systemImage: "server.rack",
        level: panelProcess?.isRunning == true ? .working : .idle
      )

    if cdpIsReachable {
      codexStatus = ComponentStatus(
        title: "Codex",
        detail: "CDP 已连接",
        systemImage: "terminal",
        level: .healthy
      )
    } else if codexRunning {
      codexStatus = ComponentStatus(
        title: "Codex",
        detail: "需要完全退出后重启",
        systemImage: "exclamationmark.arrow.triangle.2.circlepath",
        level: .warning
      )
    } else {
      codexStatus = ComponentStatus(
        title: "Codex",
        detail: integrationProcess?.isRunning == true ? "正在启动" : "未运行",
        systemImage: "terminal",
        level: integrationProcess?.isRunning == true ? .working : .idle
      )
    }

    if integrationIsReady && panelIsReachable {
      integrationStatus = ComponentStatus(
        title: "内嵌集成",
        detail: "已连接",
        systemImage: "rectangle.split.3x1",
        level: .healthy
      )
    } else if integrationProcess?.isRunning == true {
      integrationStatus = ComponentStatus(
        title: "内嵌集成",
        detail: "正在连接",
        systemImage: "rectangle.split.3x1",
        level: .working
      )
    } else {
      integrationStatus = ComponentStatus(
        title: "内嵌集成",
        detail: cdpIsReachable && panelIsReachable ? "由外部进程管理" : "已停止",
        systemImage: "rectangle.split.3x1",
        level: cdpIsReachable && panelIsReachable ? .warning : .idle
      )
    }
  }

  private func prepareIntegrationPort() async throws -> Int {
    guard let configuration else {
      throw ManagerError.configuration(configurationError ?? "配置不可用")
    }
    if let discovered = await discoverActiveCDPPort() {
      activeCDPPort = discovered
      return discovered
    }
    if processIsRunning(named: "ChatGPT") {
      throw ManagerError.codexNeedsRestart
    }
    activeCDPPort = configuration.cdpPort
    return configuration.cdpPort
  }

  private func discoverActiveCDPPort() async -> Int? {
    guard
      let output = try? await runOneShotInjector(["--discover-port"]),
      let data = output.data(using: .utf8),
      let response = try? JSONDecoder().decode(DiscoveredPort.self, from: data)
    else { return nil }
    return response.port
  }

  private func retireExistingInjectors(port: Int) async throws {
    _ = try await runOneShotInjector(["--stop-managed"])
    _ = try await runOneShotInjector([
      "--stop-residents", "--port", String(port),
    ])
  }

  private func startPanelService(
    lifecycleGeneration expectedLifecycleGeneration: Int,
    recoveryGeneration expectedRecoveryGeneration: Int? = nil,
    panelRestartGeneration expectedPanelGeneration: Int? = nil
  ) async throws {
    guard let configuration else {
      throw ManagerError.configuration(configurationError ?? "配置不可用")
    }
    try assertStartTransaction(
      lifecycleGeneration: expectedLifecycleGeneration,
      recoveryGeneration: expectedRecoveryGeneration,
      panelGeneration: expectedPanelGeneration
    )
    let panelIsReachable = await endpointIsReachable(configuration.panelHealthURL)
    try assertStartTransaction(
      lifecycleGeneration: expectedLifecycleGeneration,
      recoveryGeneration: expectedRecoveryGeneration,
      panelGeneration: expectedPanelGeneration
    )
    if panelIsReachable { return }
    if panelProcess?.isRunning == true { return }

    let (process, logHandle) = try configuredProcess(
      arguments: [configuration.serverPath]
    )
    panelGeneration += 1
    let generation = panelGeneration
    panelProcess = process
    panelLogHandle = logHandle
    process.terminationHandler = { [weak self] endedProcess in
      Task { @MainActor in
        guard let self, self.panelProcess === endedProcess else { return }
        self.panelProcess = nil
        self.panelLogHandle?.closeFile()
        self.panelLogHandle = nil
        guard
          generation == self.panelGeneration,
          self.desiredRunning,
          !self.isShuttingDown
        else { return }
        let lifecycleGeneration = self.lifecycleGeneration
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        guard
          generation == self.panelGeneration,
          self.desiredRunning,
          !self.isShuttingDown
        else { return }
        try? await self.startPanelService(
          lifecycleGeneration: lifecycleGeneration,
          panelRestartGeneration: generation
        )
      }
    }
    do {
      try process.run()
    } catch {
      panelProcess = nil
      panelLogHandle?.closeFile()
      panelLogHandle = nil
      throw error
    }

    do {
      try await waitUntilReachable(
        configuration.panelHealthURL,
        timeoutSeconds: 10,
        lifecycleGeneration: expectedLifecycleGeneration,
        recoveryGeneration: expectedRecoveryGeneration
      )
    } catch {
      panelGeneration += 1
      process.terminate()
      await waitUntilStopped(process)
      if panelProcess === process {
        panelProcess = nil
        panelLogHandle?.closeFile()
        panelLogHandle = nil
      }
      throw error
    }
    guard
      generation == panelGeneration,
      panelProcess === process,
      desiredRunning,
      !isShuttingDown
    else { throw CancellationError() }
  }

  private func startIntegration(
    openPanel: Bool,
    lifecycleGeneration expectedLifecycleGeneration: Int,
    recoveryGeneration expectedRecoveryGeneration: Int? = nil
  ) async throws {
    guard let configuration else {
      throw ManagerError.configuration(configurationError ?? "配置不可用")
    }
    try assertStartTransaction(
      lifecycleGeneration: expectedLifecycleGeneration,
      recoveryGeneration: expectedRecoveryGeneration
    )
    if integrationProcess?.isRunning == true {
      if openPanel { await openEmbeddedPanel() }
      return
    }

    let port: Int
    if let activeCDPPort {
      port = activeCDPPort
    } else {
      port = try await prepareIntegrationPort()
      try assertStartTransaction(
        lifecycleGeneration: expectedLifecycleGeneration,
        recoveryGeneration: expectedRecoveryGeneration
      )
    }
    let cdpReachable = await endpointIsReachable(configuration.cdpVersionURL(port: port))
    try assertStartTransaction(
      lifecycleGeneration: expectedLifecycleGeneration,
      recoveryGeneration: expectedRecoveryGeneration
    )
    let startupToken = UUID().uuidString.lowercased()

    let codexAppExecutable = try configuration.validatedCodexAppExecutableURL()
    var arguments = [
      configuration.injectorPath,
      "--app-executable", codexAppExecutable.path,
    ]
    if cdpReachable {
      arguments.append(contentsOf: ["--watch", "--attach-existing"])
    } else {
      arguments.append(contentsOf: ["--launch", "--watch"])
    }
    if openPanel { arguments.append("--open") }
    arguments.append(contentsOf: [
      "--port", String(port),
      "--startup-token", startupToken,
    ])

    let (process, logHandle) = try configuredProcess(
      arguments: arguments
    )
    integrationGeneration += 1
    let generation = integrationGeneration
    integrationProcess = process
    integrationStartupToken = startupToken
    integrationLogHandle = logHandle
    process.terminationHandler = { [weak self] endedProcess in
      Task { @MainActor in
        guard let self, self.integrationProcess === endedProcess else { return }
        self.integrationProcess = nil
        self.integrationStartupToken = nil
        self.integrationLogHandle?.closeFile()
        self.integrationLogHandle = nil
        guard
          generation == self.integrationGeneration,
          self.desiredRunning,
          !self.isShuttingDown
        else {
          await self.refreshStatuses()
          return
        }
        self.scheduleIntegrationRecovery()
        await self.refreshStatuses()
      }
    }
    do {
      try process.run()
    } catch {
      integrationGeneration += 1
      integrationProcess = nil
      integrationStartupToken = nil
      integrationLogHandle?.closeFile()
      integrationLogHandle = nil
      throw error
    }

    do {
      try await waitUntilIntegrationReady(
        port: port,
        timeoutSeconds: 30,
        lifecycleGeneration: expectedLifecycleGeneration,
        recoveryGeneration: expectedRecoveryGeneration
      )
    } catch {
      integrationGeneration += 1
      process.terminate()
      await waitUntilStopped(process)
      if integrationProcess === process {
        integrationProcess = nil
        integrationStartupToken = nil
        integrationLogHandle?.closeFile()
        integrationLogHandle = nil
      }
      throw error
    }
    guard
      generation == integrationGeneration,
      integrationProcess === process,
      desiredRunning,
      !isShuttingDown
    else { throw CancellationError() }
  }

  private func terminateManagedProcesses() async {
    panelGeneration += 1
    integrationGeneration += 1
    cancelIntegrationRecovery()
    let integration = integrationProcess
    let panel = panelProcess
    integration?.terminate()
    await waitUntilStopped(integration)
    if integrationProcess === integration {
      integrationProcess = nil
      integrationStartupToken = nil
      integrationLogHandle?.closeFile()
      integrationLogHandle = nil
    }
    panel?.terminate()
    await waitUntilStopped(panel)
    if panelProcess === panel {
      panelProcess = nil
      panelLogHandle?.closeFile()
      panelLogHandle = nil
    }
    activeCDPPort = nil
  }

  private func scheduleIntegrationRecovery() {
    guard recoveryTask == nil else { return }
    guard let delay = recoveryPolicy.recordUnexpectedExit() else {
      lastError = "内嵌集成在 60 秒内连续退出，已停止自动恢复；请查看运行日志"
      return
    }
    integrationStatus = ComponentStatus(
      title: "内嵌集成",
      detail: "将在 \(Int(delay)) 秒后恢复",
      systemImage: "arrow.triangle.2.circlepath",
      level: .warning
    )
    recoveryGeneration += 1
    let generation = recoveryGeneration
    let lifecycleGeneration = self.lifecycleGeneration
    recoveryTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
      guard let self, self.shouldContinueRecovery(generation: generation) else { return }
      do {
        let port = try await self.prepareIntegrationPort()
        guard self.shouldContinueRecovery(generation: generation) else { return }
        try await self.retireExistingInjectors(port: port)
        guard self.shouldContinueRecovery(generation: generation) else { return }
        try await self.startPanelService(
          lifecycleGeneration: lifecycleGeneration,
          recoveryGeneration: generation
        )
        guard self.shouldContinueRecovery(generation: generation) else { return }
        try await self.startIntegration(
          openPanel: false,
          lifecycleGeneration: lifecycleGeneration,
          recoveryGeneration: generation
        )
        guard self.shouldContinueRecovery(generation: generation) else { return }
        self.lastError = nil
      } catch {
        guard self.shouldContinueRecovery(generation: generation) else { return }
        self.lastError = "内嵌集成自动恢复失败：\(error.localizedDescription)"
        self.recoveryTask = nil
        self.scheduleIntegrationRecovery()
        return
      }
      guard self.recoveryGeneration == generation else { return }
      self.recoveryTask = nil
      await self.refreshStatuses()
    }
  }

  private func cancelIntegrationRecovery() {
    lifecycleGeneration += 1
    recoveryGeneration += 1
    recoveryTask?.cancel()
    recoveryTask = nil
  }

  private func shouldContinueRecovery(generation: Int) -> Bool {
    !Task.isCancelled
      && recoveryGeneration == generation
      && desiredRunning
      && !isShuttingDown
  }

  private func assertStartTransaction(
    lifecycleGeneration expectedLifecycleGeneration: Int,
    recoveryGeneration expectedRecoveryGeneration: Int? = nil,
    panelGeneration expectedPanelGeneration: Int? = nil
  ) throws {
    guard
      !Task.isCancelled,
      lifecycleGeneration == expectedLifecycleGeneration,
      desiredRunning,
      !isShuttingDown
    else {
      throw CancellationError()
    }
    if let expectedRecoveryGeneration {
      guard recoveryGeneration == expectedRecoveryGeneration else { throw CancellationError() }
    }
    if let expectedPanelGeneration {
      guard panelGeneration == expectedPanelGeneration else { throw CancellationError() }
    }
  }

  private func waitUntilStopped(_ process: Process?) async {
    guard let process else { return }
    for _ in 0..<100 where process.isRunning {
      try? await Task.sleep(nanoseconds: 100_000_000)
    }
    if process.isRunning {
      kill(process.processIdentifier, SIGKILL)
      for _ in 0..<20 where process.isRunning {
        try? await Task.sleep(nanoseconds: 100_000_000)
      }
    }
  }

  private func configuredProcess(arguments: [String]) throws -> (Process, FileHandle) {
    guard let configuration else {
      throw ManagerError.configuration(configurationError ?? "配置不可用")
    }
    let process = try configuredNodeProcess(arguments: arguments)
    let logHandle = try appendLogHandle(configuration.logURL)
    process.standardOutput = logHandle
    process.standardError = logHandle
    return (process, logHandle)
  }

  private func runOneShotInjector(_ arguments: [String]) async throws -> String {
    guard let configuration else {
      throw ManagerError.configuration(configurationError ?? "配置不可用")
    }
    let process = try configuredNodeProcess(
      arguments: [configuration.injectorPath] + arguments
    )
    let output = try await runOneShotCommand(process, timeoutSeconds: 10)
    if output.terminationStatus == 0 {
      return output.standardOutput
    }
    let message = [output.standardError, output.standardOutput]
      .filter { !$0.isEmpty }
      .joined(separator: "\n")
    throw ManagerError.commandFailed(
      message.isEmpty ? "命令退出码 \(output.terminationStatus)" : message
    )
  }

  private func configuredNodeProcess(arguments: [String]) throws -> Process {
    guard let configuration else {
      throw ManagerError.configuration(configurationError ?? "配置不可用")
    }
    let runtimeURL = try configuration.validatedRuntimeURL()
    let nodeURL = try configuration.validatedNodeURL()
    let codexURL = try configuration.validatedCodexExecutableURL()
    let process = Process()
    process.executableURL = nodeURL
    process.arguments = arguments
    process.currentDirectoryURL = runtimeURL
    process.environment = sanitizedPanelProcessEnvironment(
      inheriting: ProcessInfo.processInfo.environment,
      pathValue: configuration.pathValue,
      dataDirectory: configuration.dataDirectory,
      panelPort: configuration.panelPort,
      codexExecutablePath: codexURL.path,
      runtimeFilePath: configuration.runtimeFileURL.path
    )
    return process
  }

  private func assertIntegrationReady(port _: Int) async throws {
    guard let startupToken = integrationStartupToken else {
      throw ManagerError.integrationUnavailable
    }
    _ = try await runOneShotInjector([
      "--control", "status",
      "--startup-token", startupToken,
    ])
  }

  private func waitUntilIntegrationReady(
    port: Int,
    timeoutSeconds: Int,
    lifecycleGeneration expectedLifecycleGeneration: Int,
    recoveryGeneration expectedRecoveryGeneration: Int? = nil
  ) async throws {
    for _ in 0..<(timeoutSeconds * 4) {
      try assertStartTransaction(
        lifecycleGeneration: expectedLifecycleGeneration,
        recoveryGeneration: expectedRecoveryGeneration
      )
      guard integrationProcess?.isRunning == true else {
        throw ManagerError.integrationUnavailable
      }
      do {
        try await assertIntegrationReady(port: port)
        try assertStartTransaction(
          lifecycleGeneration: expectedLifecycleGeneration,
          recoveryGeneration: expectedRecoveryGeneration
        )
        return
      } catch ManagerError.commandFailed(_) {
        try await Task.sleep(nanoseconds: 250_000_000)
      }
    }
    throw ManagerError.timeout("Codex renderer injection")
  }

  private func endpointIsReachable(_ url: URL) async -> Bool {
    var request = URLRequest(url: url)
    request.timeoutInterval = 1
    do {
      let (_, response) = try await URLSession.shared.data(for: request)
      return (response as? HTTPURLResponse)?.statusCode == 200
    } catch {
      return false
    }
  }

  private func waitUntilReachable(
    _ url: URL,
    timeoutSeconds: Int,
    lifecycleGeneration expectedLifecycleGeneration: Int,
    recoveryGeneration expectedRecoveryGeneration: Int? = nil
  ) async throws {
    for _ in 0..<(timeoutSeconds * 4) {
      try assertStartTransaction(
        lifecycleGeneration: expectedLifecycleGeneration,
        recoveryGeneration: expectedRecoveryGeneration
      )
      let isReachable = await endpointIsReachable(url)
      try assertStartTransaction(
        lifecycleGeneration: expectedLifecycleGeneration,
        recoveryGeneration: expectedRecoveryGeneration
      )
      if isReachable { return }
      try await Task.sleep(nanoseconds: 250_000_000)
    }
    throw ManagerError.timeout(url.absoluteString)
  }

  private func processIsRunning(named name: String) -> Bool {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
    process.arguments = ["-x", name]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    do {
      try process.run()
      process.waitUntilExit()
      return process.terminationStatus == 0
    } catch {
      return false
    }
  }

  private func appendLogHandle(_ url: URL) throws -> FileHandle {
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    ensureLogFile(url)
    let handle = try FileHandle(forWritingTo: url)
    try handle.seekToEnd()
    let timestamp = ISO8601DateFormatter().string(from: Date())
    try handle.write(contentsOf: Data("\n[\(timestamp)] Codex Panel manager\n".utf8))
    return handle
  }

  private func ensureLogFile(_ url: URL) {
    if !FileManager.default.fileExists(atPath: url.path) {
      FileManager.default.createFile(atPath: url.path, contents: nil)
    }
  }

  private func defaultedPreference(forKey key: String, defaultValue: Bool) -> Bool {
    let defaults = UserDefaults.standard
    guard defaults.object(forKey: key) != nil else { return defaultValue }
    return defaults.bool(forKey: key)
  }
}

enum PreferenceKey {
  static let autoConnectCodex = "autoConnectCodex"
  static let autoOpenPanel = "autoOpenPanel"
}

private struct DiscoveredPort: Decodable {
  let port: Int
}

enum ManagerError: LocalizedError {
  case configuration(String)
  case codexNeedsRestart
  case commandFailed(String)
  case integrationUnavailable
  case timeout(String)

  var errorDescription: String? {
    switch self {
    case .configuration(let message):
      return message
    case .codexNeedsRestart:
      return "Codex 正在运行但未启用 CDP，请完全退出 Codex 后重新启动服务"
    case .commandFailed(let message):
      return message
    case .integrationUnavailable:
      return "Panel 内嵌集成未就绪，请重启服务"
    case .timeout(let target):
      return "等待服务超时：\(target)"
    }
  }
}
