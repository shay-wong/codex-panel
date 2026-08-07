import CryptoKit
import Foundation
import XCTest
@testable import CodexPanelLauncher

final class LauncherConfigurationTests: XCTestCase {
  func testValidatedNodeRejectsContentChangedAfterInstallation() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let executable = directory.appendingPathComponent("node")
    try Data("trusted".utf8).write(to: executable)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o755],
      ofItemAtPath: executable.path
    )
    let configuration = try configuration(nodePath: executable.path, nodeSha256: sha256(executable))

    XCTAssertEqual(try configuration.validatedNodeURL(), executable.standardizedFileURL)
    try Data("changed".utf8).write(to: executable)
    XCTAssertThrowsError(try configuration.validatedNodeURL())
  }

  func testValidatedNodeRejectsSymbolicLinks() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let executable = directory.appendingPathComponent("real-node")
    let symlink = directory.appendingPathComponent("node")
    try Data("trusted".utf8).write(to: executable)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o755],
      ofItemAtPath: executable.path
    )
    try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: executable)
    let configuration = try configuration(nodePath: symlink.path, nodeSha256: sha256(executable))

    XCTAssertThrowsError(try configuration.validatedNodeURL())
  }

  func testValidatedCodexAppRejectsExecutableTampering() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let app = directory.appendingPathComponent("Fake Codex.app", isDirectory: true)
    let contents = app.appendingPathComponent("Contents", isDirectory: true)
    let executable = contents.appendingPathComponent("MacOS/Fake Codex")
    try FileManager.default.createDirectory(
      at: executable.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    try Data("#!/bin/sh\nexit 0\n".utf8).write(to: executable)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o755],
      ofItemAtPath: executable.path
    )
    try Data("""
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0"><dict>
      <key>CFBundleExecutable</key><string>Fake Codex</string>
      <key>CFBundleIdentifier</key><string>test.codex-panel.fake-codex</string>
      <key>CFBundlePackageType</key><string>APPL</string>
    </dict></plist>
    """.utf8).write(to: contents.appendingPathComponent("Info.plist"))
    try run("/usr/bin/codesign", ["--force", "--sign", "-", app.path])
    let requirement = try designatedRequirement(app)
    let configuration = try configuration(
      nodePath: executable.path,
      nodeSha256: try sha256(executable),
      codexAppPath: app.path,
      codexAppDesignatedRequirement: requirement
    )

    XCTAssertEqual(
      try configuration.validatedCodexAppExecutableURL(),
      executable.standardizedFileURL
    )
    try Data("tampered".utf8).write(to: executable)
    XCTAssertThrowsError(try configuration.validatedCodexAppExecutableURL())
  }

  private func configuration(
    nodePath: String,
    nodeSha256: String,
    codexAppPath: String = "/Applications/ChatGPT.app",
    codexAppDesignatedRequirement: String = "identifier com.openai.codex"
  ) throws -> LauncherConfiguration {
    let payload: [String: Any] = [
      "version": 3,
      "runtimeRelativePath": "runtime",
      "dataDirectory": "/tmp/data",
      "logPath": "/tmp/panel.log",
      "nodePath": nodePath,
      "nodeSha256": nodeSha256,
      "pathValue": "/usr/bin:/bin",
      "codexAppPath": codexAppPath,
      "codexAppDesignatedRequirement": codexAppDesignatedRequirement,
      "codexAppExecutablePath": nodePath,
      "codexAppExecutableSha256": nodeSha256,
      "codexExecutablePath": nodePath,
      "codexExecutableSha256": nodeSha256,
      "panelPort": 47_823,
      "cdpPort": 9_229,
    ]
    return try JSONDecoder().decode(
      LauncherConfiguration.self,
      from: JSONSerialization.data(withJSONObject: payload)
    )
  }

  private func temporaryDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("codex-panel-launcher-tests-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }

  private func sha256(_ url: URL) throws -> String {
    SHA256.hash(data: try Data(contentsOf: url))
      .map { String(format: "%02x", $0) }
      .joined()
  }

  private func designatedRequirement(_ app: URL) throws -> String {
    let output = try run("/usr/bin/codesign", ["-d", "-r-", app.path])
    guard let requirement = output
      .split(separator: "\n")
      .first(where: { $0.contains("designated => ") })?
      .split(separator: "designated => ", maxSplits: 1)
      .last
    else {
      throw NSError(domain: "LauncherConfigurationTests", code: 1)
    }
    return String(requirement)
  }

  @discardableResult
  private func run(_ executable: String, _ arguments: [String]) throws -> String {
    let process = Process()
    let output = Pipe()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.standardOutput = output
    process.standardError = output
    try process.run()
    process.waitUntilExit()
    let text = String(
      decoding: output.fileHandleForReading.readDataToEndOfFile(),
      as: UTF8.self
    )
    guard process.terminationStatus == 0 else {
      throw NSError(
        domain: "LauncherConfigurationTests",
        code: Int(process.terminationStatus),
        userInfo: [NSLocalizedDescriptionKey: text]
      )
    }
    return text
  }
}
