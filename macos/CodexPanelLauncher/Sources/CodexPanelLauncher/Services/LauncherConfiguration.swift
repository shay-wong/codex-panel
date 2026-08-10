import CryptoKit
import Darwin
import Foundation
import Security

struct LauncherConfiguration: Decodable {
  private struct ExecutableIdentity: Equatable {
    let device: UInt64
    let inode: UInt64
    let size: Int64
    let modifiedSeconds: Int
    let modifiedNanoseconds: Int
    let changedSeconds: Int
    let changedNanoseconds: Int
  }

  private struct ValidatedExecutable {
    let expectedSha256: String
    let identity: ExecutableIdentity
  }

  private static let executableValidationLock = NSLock()
  private static var validatedExecutables: [String: ValidatedExecutable] = [:]

  let version: Int
  let runtimeRelativePath: String
  let dataDirectory: String
  let logPath: String
  let nodePath: String
  let nodeSha256: String
  let pathValue: String
  let codexAppPath: String
  let codexAppDesignatedRequirement: String
  let codexAppExecutablePath: String
  let codexExecutablePath: String
  let codexExecutableDesignatedRequirement: String
  let panelPort: Int
  let cdpPort: Int
  private var resourcesDirectory: String? = nil

  private enum CodingKeys: String, CodingKey {
    case version
    case runtimeRelativePath
    case dataDirectory
    case logPath
    case nodePath
    case nodeSha256
    case pathValue
    case codexAppPath
    case codexAppDesignatedRequirement
    case codexAppExecutablePath
    case codexExecutablePath
    case codexExecutableDesignatedRequirement
    case panelPort
    case cdpPort
  }

  var runtimeURL: URL {
    let resourcesURL = resourcesDirectory.map {
      URL(fileURLWithPath: $0, isDirectory: true)
    } ?? Bundle.main.resourceURL!
    return resourcesURL.appendingPathComponent(runtimeRelativePath, isDirectory: true)
  }

  var dataURL: URL {
    URL(fileURLWithPath: dataDirectory, isDirectory: true)
  }

  var logURL: URL {
    URL(fileURLWithPath: logPath)
  }

  var runtimeFileURL: URL {
    dataURL.appendingPathComponent("launcher-runtime.json")
  }

  var injectorPath: String {
    runtimeURL.appendingPathComponent("scripts/codex-injector.mjs").path
  }

  var serverPath: String {
    runtimeURL.appendingPathComponent("server/index.mjs").path
  }

  var panelURL: URL {
    URL(string: "http://127.0.0.1:\(panelPort)/")!
  }

  var panelHealthURL: URL {
    panelURL.appendingPathComponent("health")
  }

  func cdpVersionURL(port: Int) -> URL {
    URL(string: "http://127.0.0.1:\(port)/json/version")!
  }

  func validatedNodeURL() throws -> URL {
    try validatedExecutableURL(
      path: nodePath,
      expectedSha256: nodeSha256,
      label: "Node.js"
    )
  }

  func validatedCodexExecutableURL() throws -> URL {
    let appURL = URL(fileURLWithPath: codexAppPath, isDirectory: true)
    try validateCodeSignature(
      at: appURL,
      designatedRequirement: codexAppDesignatedRequirement,
      label: "ChatGPT/Codex"
    )
    let executableURL = try validatedBundledExecutableURL(
      path: codexExecutablePath,
      within: appURL,
      label: "Codex CLI"
    )
    try validateCodeSignature(
      at: executableURL,
      designatedRequirement: codexExecutableDesignatedRequirement,
      label: "Codex CLI"
    )
    return executableURL
  }

  func validatedCodexAppExecutableURL() throws -> URL {
    let appURL = URL(fileURLWithPath: codexAppPath, isDirectory: true)
    try validateCodeSignature(
      at: appURL,
      designatedRequirement: codexAppDesignatedRequirement,
      label: "ChatGPT/Codex"
    )
    return try validatedBundledExecutableURL(
      path: codexAppExecutablePath,
      within: appURL,
      label: "ChatGPT/Codex 主程序"
    )
  }

  func validatedRuntimeURL(bundle: Bundle = .main) throws -> URL {
    try validateBundleSignature(bundle: bundle)
    let resourcesURL = resourcesDirectory.map {
      URL(fileURLWithPath: $0, isDirectory: true)
    } ?? bundle.resourceURL!
    let standardizedResources = resourcesURL.standardizedFileURL
    let standardizedRuntime = runtimeURL.standardizedFileURL
    guard
      !runtimeRelativePath.hasPrefix("/"),
      !runtimeRelativePath.split(separator: "/").contains(".."),
      standardizedRuntime.path.hasPrefix(standardizedResources.path + "/"),
      standardizedRuntime.resolvingSymlinksInPath() == standardizedRuntime
    else {
      throw ConfigurationError.untrustedRuntime("runtime 路径不在签名 App 资源内")
    }

    let requiredPaths = [injectorPath, serverPath]
    for requiredPath in requiredPaths where !FileManager.default.fileExists(atPath: requiredPath) {
      throw ConfigurationError.untrustedRuntime("缺少运行文件：\(requiredPath)")
    }

    guard let enumerator = FileManager.default.enumerator(
      at: standardizedRuntime,
      includingPropertiesForKeys: [.isSymbolicLinkKey],
      options: [.skipsHiddenFiles]
    ) else {
      throw ConfigurationError.untrustedRuntime("无法读取签名 runtime")
    }
    for case let entry as URL in enumerator {
      if try entry.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink == true {
        throw ConfigurationError.untrustedRuntime("runtime 包含符号链接：\(entry.path)")
      }
    }
    return standardizedRuntime
  }

  static func load(bundle: Bundle = .main) throws -> LauncherConfiguration {
    guard let url = bundle.url(
      forResource: "launcher-config",
      withExtension: "json"
    ) else {
      throw ConfigurationError.missingResource
    }
    var configuration = try JSONDecoder().decode(
      LauncherConfiguration.self,
      from: Data(contentsOf: url)
    )
    guard configuration.version == 4, let resourceURL = bundle.resourceURL else {
      throw ConfigurationError.unsupportedVersion
    }
    configuration.resourcesDirectory = resourceURL.path
    _ = try configuration.validatedRuntimeURL(bundle: bundle)
    _ = try configuration.validatedNodeURL()
    _ = try configuration.validatedCodexAppExecutableURL()
    _ = try configuration.validatedCodexExecutableURL()
    return configuration
  }

  private func validatedExecutableURL(
    path: String,
    expectedSha256: String,
    label: String
  ) throws -> URL {
    let url = URL(fileURLWithPath: path).standardizedFileURL
    var fileStat = stat()
    guard
      lstat(url.path, &fileStat) == 0,
      (fileStat.st_mode & S_IFMT) == S_IFREG,
      url.resolvingSymlinksInPath() == url,
      FileManager.default.isExecutableFile(atPath: url.path)
    else {
      throw ConfigurationError.untrustedExecutable("\(label) 路径不可执行或包含符号链接")
    }
    let identity = ExecutableIdentity(
      device: UInt64(fileStat.st_dev),
      inode: UInt64(fileStat.st_ino),
      size: fileStat.st_size,
      modifiedSeconds: fileStat.st_mtimespec.tv_sec,
      modifiedNanoseconds: fileStat.st_mtimespec.tv_nsec,
      changedSeconds: fileStat.st_ctimespec.tv_sec,
      changedNanoseconds: fileStat.st_ctimespec.tv_nsec
    )
    let normalizedSha256 = expectedSha256.lowercased()
    let alreadyValidated = Self.executableValidationLock.withLock {
      guard let cached = Self.validatedExecutables[url.path] else { return false }
      return cached.expectedSha256 == normalizedSha256 && cached.identity == identity
    }
    if alreadyValidated { return url }
    let digest = SHA256.hash(data: try Data(contentsOf: url, options: .mappedIfSafe))
      .map { String(format: "%02x", $0) }
      .joined()
    guard digest == normalizedSha256 else {
      throw ConfigurationError.untrustedExecutable("\(label) 校验失败，请重新运行 npm run codex:install")
    }
    Self.executableValidationLock.withLock {
      Self.validatedExecutables[url.path] = ValidatedExecutable(
        expectedSha256: normalizedSha256,
        identity: identity
      )
    }
    return url
  }

  private func validatedBundledExecutableURL(
    path: String,
    within bundleURL: URL,
    label: String
  ) throws -> URL {
    let standardizedBundleURL = bundleURL.standardizedFileURL
    let executableURL = URL(fileURLWithPath: path).standardizedFileURL
    var fileStat = stat()
    guard
      standardizedBundleURL.resolvingSymlinksInPath() == standardizedBundleURL,
      executableURL.path.hasPrefix(standardizedBundleURL.path + "/"),
      executableURL.resolvingSymlinksInPath() == executableURL,
      lstat(executableURL.path, &fileStat) == 0,
      (fileStat.st_mode & S_IFMT) == S_IFREG,
      FileManager.default.isExecutableFile(atPath: executableURL.path)
    else {
      throw ConfigurationError.untrustedExecutable(
        "\(label) 必须是官方 ChatGPT.app 内的真实可执行文件"
      )
    }
    return executableURL
  }

  private func validateBundleSignature(bundle: Bundle) throws {
    try validateCodeSignature(
      at: bundle.bundleURL,
      designatedRequirement: nil,
      label: "启动器"
    )
  }

  private func validateCodeSignature(
    at url: URL,
    designatedRequirement: String?,
    label: String
  ) throws {
    let standardizedURL = url.standardizedFileURL
    guard standardizedURL.resolvingSymlinksInPath() == standardizedURL else {
      throw ConfigurationError.untrustedExecutable("\(label) 路径包含符号链接")
    }
    var staticCode: SecStaticCode?
    let createStatus = SecStaticCodeCreateWithPath(
      standardizedURL as CFURL,
      SecCSFlags(),
      &staticCode
    )
    guard createStatus == errSecSuccess, let staticCode else {
      throw ConfigurationError.invalidCodeSignature(label, createStatus)
    }
    var requirement: SecRequirement?
    if let designatedRequirement {
      let requirementStatus = SecRequirementCreateWithString(
        designatedRequirement as CFString,
        SecCSFlags(),
        &requirement
      )
      guard requirementStatus == errSecSuccess, requirement != nil else {
        throw ConfigurationError.invalidCodeSignature(label, requirementStatus)
      }
    }
    let validationFlags = SecCSFlags(
      rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode
    )
    let validationStatus = SecStaticCodeCheckValidity(staticCode, validationFlags, requirement)
    guard validationStatus == errSecSuccess else {
      throw ConfigurationError.invalidCodeSignature(label, validationStatus)
    }
  }
}

enum ConfigurationError: LocalizedError {
  case invalidCodeSignature(String, OSStatus)
  case missingResource
  case unsupportedVersion
  case untrustedExecutable(String)
  case untrustedRuntime(String)

  var errorDescription: String? {
    switch self {
    case .invalidCodeSignature(let label, let status):
      return "\(label) 签名校验失败（\(status)），请重新运行 npm run codex:install"
    case .missingResource:
      return "启动器配置缺失，请重新运行 npm run codex:install"
    case .unsupportedVersion:
      return "启动器配置版本不兼容，请重新运行 npm run codex:install"
    case .untrustedExecutable(let message), .untrustedRuntime(let message):
      return message
    }
  }
}
