import AppKit
import Darwin
import Foundation

func sanitizedPanelProcessEnvironment(
  inheriting inherited: [String: String],
  pathValue: String,
  dataDirectory: String,
  panelPort: Int,
  codexExecutablePath: String
) -> [String: String] {
  let blockedKeys = Set([
    "NODE_OPTIONS",
    "NODE_PATH",
    "NPM_CONFIG_NODE_OPTIONS",
    "BASH_ENV",
    "ENV",
    "ZDOTDIR",
    "CODEX_TASKBOARD_PORT",
  ])
  var environment = inherited.filter { key, _ in
    !blockedKeys.contains(key)
      && !key.hasPrefix("DYLD_")
      && !key.hasPrefix("LD_")
  }
  environment["PATH"] = pathValue
  environment["CODEX_PANEL_HOST"] = "127.0.0.1"
  environment["CODEX_PANEL_DATA_DIR"] = dataDirectory
  environment["CODEX_PANEL_PORT"] = String(panelPort)
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
  private var didActivate = false
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

  func activate() async {
    guard !didActivate else { return }
    didActivate = true
    startMonitoring()
    guard configuration != nil else {
      await refreshStatuses()
      return
    }

    desiredRunning = true
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
      try await startPanelService()
      if autoConnect {
        let shouldOpen = defaultedPreference(
          forKey: PreferenceKey.autoOpenPanel,
          defaultValue: true
        )
        try await startIntegration(openPanel: shouldOpen)
      }
      lastError = nil
    } catch {
      lastError = error.localizedDescription
    }
    await refreshStatuses()
  }

  func startAll(openPanel: Bool = true) async {
    guard !isBusy else { return }
    desiredRunning = true
    isBusy = true
    defer { isBusy = false }
    do {
      if integrationProcess?.isRunning != true {
        let port = try await prepareIntegrationPort()
        try await retireExistingInjectors(port: port)
      }
      try await startPanelService()
      try await startIntegration(openPanel: openPanel)
      lastError = nil
    } catch {
      lastError = error.localizedDescription
    }
    await refreshStatuses()
  }

  func stopAll() async {
    guard !isBusy else { return }
    desiredRunning = false
    isBusy = true
    defer { isBusy = false }
    await terminateManagedProcesses()
    lastError = nil
    await refreshStatuses()
  }

  func restartAll() async {
    guard !isBusy else { return }
    desiredRunning = false
    isBusy = true
    defer { isBusy = false }
    await terminateManagedProcesses()
    desiredRunning = true
    do {
      let port = try await prepareIntegrationPort()
      try await retireExistingInjectors(port: port)
      try await startPanelService()
      try await startIntegration(openPanel: false)
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
      guard let port = activeCDPPort, let startupToken = integrationStartupToken else {
        throw ManagerError.integrationUnavailable
      }
      _ = try await runOneShotInjector([
        "--open-existing",
        "--port", String(port),
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

  func shutdown() async {
    guard !isShuttingDown else { return }
    isShuttingDown = true
    desiredRunning = false
    monitoringTask?.cancel()
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
    _ = try await runOneShotInjector([
      "--stop-residents", "--port", String(port),
    ])
  }

  private func startPanelService() async throws {
    guard let configuration else {
      throw ManagerError.configuration(configurationError ?? "配置不可用")
    }
    if await endpointIsReachable(configuration.panelHealthURL) { return }
    if panelProcess?.isRunning == true { return }

    let (process, logHandle) = try configuredProcess(
      arguments: [configuration.serverPath]
    )
    panelProcess = process
    panelLogHandle = logHandle
    process.terminationHandler = { [weak self] endedProcess in
      Task { @MainActor in
        guard let self, self.panelProcess === endedProcess else { return }
        self.panelProcess = nil
        self.panelLogHandle?.closeFile()
        self.panelLogHandle = nil
        if self.desiredRunning && !self.isShuttingDown {
          try? await Task.sleep(nanoseconds: 1_500_000_000)
          try? await self.startPanelService()
        }
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

    try await waitUntilReachable(configuration.panelHealthURL, timeoutSeconds: 10)
  }

  private func startIntegration(openPanel: Bool) async throws {
    guard let configuration else {
      throw ManagerError.configuration(configurationError ?? "配置不可用")
    }
    if integrationProcess?.isRunning == true {
      if openPanel { await openEmbeddedPanel() }
      return
    }

    let port: Int
    if let activeCDPPort {
      port = activeCDPPort
    } else {
      port = try await prepareIntegrationPort()
    }
    let cdpReachable = await endpointIsReachable(configuration.cdpVersionURL(port: port))
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
        await self.refreshStatuses()
      }
    }
    do {
      try process.run()
    } catch {
      integrationProcess = nil
      integrationStartupToken = nil
      integrationLogHandle?.closeFile()
      integrationLogHandle = nil
      throw error
    }

    do {
      try await waitUntilIntegrationReady(port: port, timeoutSeconds: 30)
    } catch {
      process.terminate()
      await waitUntilStopped(process)
      if integrationProcess === process {
        integrationProcess = nil
        integrationStartupToken = nil
      }
      throw error
    }
  }

  private func terminateManagedProcesses() async {
    let integration = integrationProcess
    let panel = panelProcess
    integration?.terminate()
    await waitUntilStopped(integration)
    panel?.terminate()
    await waitUntilStopped(panel)
    integrationStartupToken = nil
    activeCDPPort = nil
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
    let output = Pipe()
    process.standardOutput = output
    process.standardError = output

    return try await withCheckedThrowingContinuation { continuation in
      process.terminationHandler = { finishedProcess in
        let data = output.fileHandleForReading.readDataToEndOfFile()
        let text = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        if finishedProcess.terminationStatus == 0 {
          continuation.resume(returning: text)
        } else {
          continuation.resume(throwing: ManagerError.commandFailed(
            text.isEmpty ? "命令退出码 \(finishedProcess.terminationStatus)" : text
          ))
        }
      }
      do {
        try process.run()
      } catch {
        continuation.resume(throwing: error)
      }
    }
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
      codexExecutablePath: codexURL.path
    )
    return process
  }

  private func assertIntegrationReady(port: Int) async throws {
    guard let startupToken = integrationStartupToken else {
      throw ManagerError.integrationUnavailable
    }
    _ = try await runOneShotInjector([
      "--status",
      "--port", String(port),
      "--startup-token", startupToken,
    ])
  }

  private func waitUntilIntegrationReady(port: Int, timeoutSeconds: Int) async throws {
    for _ in 0..<(timeoutSeconds * 4) {
      guard integrationProcess?.isRunning == true else {
        throw ManagerError.integrationUnavailable
      }
      do {
        try await assertIntegrationReady(port: port)
        return
      } catch ManagerError.commandFailed(_) {
        try? await Task.sleep(nanoseconds: 250_000_000)
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

  private func waitUntilReachable(_ url: URL, timeoutSeconds: Int) async throws {
    for _ in 0..<(timeoutSeconds * 4) {
      if await endpointIsReachable(url) { return }
      try? await Task.sleep(nanoseconds: 250_000_000)
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
