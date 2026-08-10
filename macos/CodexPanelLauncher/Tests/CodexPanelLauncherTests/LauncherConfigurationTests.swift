import CryptoKit
import Foundation
import XCTest

@testable import CodexPanelLauncher

final class LauncherConfigurationTests: XCTestCase {
  private struct SignedCodexFixture {
    let app: URL
    let appExecutable: URL
    let cliExecutable: URL
    let appIdentifier: String
    let cliIdentifier: String

    var appRequirement: String { "identifier \"\(appIdentifier)\"" }
    var cliRequirement: String { "identifier \"\(cliIdentifier)\"" }
  }

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
    try Data(
      """
      <?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0"><dict>
        <key>CFBundleExecutable</key><string>Fake Codex</string>
        <key>CFBundleIdentifier</key><string>test.codex-panel.fake-codex</string>
        <key>CFBundlePackageType</key><string>APPL</string>
      </dict></plist>
      """.utf8
    ).write(to: contents.appendingPathComponent("Info.plist"))
    try run("/usr/bin/codesign", ["--force", "--sign", "-", app.path])
    let configuration = try configuration(
      nodePath: executable.path,
      nodeSha256: try sha256(executable),
      codexAppPath: app.path,
      codexAppDesignatedRequirement: "identifier \"test.codex-panel.fake-codex\""
    )

    XCTAssertEqual(
      try configuration.validatedCodexAppExecutableURL(),
      executable.standardizedFileURL
    )
    try Data("tampered".utf8).write(to: executable)
    XCTAssertThrowsError(try configuration.validatedCodexAppExecutableURL())
  }

  func testValidatedCodexAppAcceptsSignedUpdateWithSameIdentity() throws {
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
    try Data(
      """
      <?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0"><dict>
        <key>CFBundleExecutable</key><string>Fake Codex</string>
        <key>CFBundleIdentifier</key><string>test.codex-panel.fake-codex</string>
        <key>CFBundlePackageType</key><string>APPL</string>
      </dict></plist>
      """.utf8
    ).write(to: contents.appendingPathComponent("Info.plist"))
    try run("/usr/bin/codesign", ["--force", "--sign", "-", app.path])
    let configuration = try configuration(
      nodePath: executable.path,
      nodeSha256: try sha256(executable),
      codexAppPath: app.path,
      codexAppDesignatedRequirement: "identifier \"test.codex-panel.fake-codex\""
    )

    XCTAssertEqual(
      try configuration.validatedCodexAppExecutableURL(),
      executable.standardizedFileURL
    )

    try Data("#!/bin/sh\nexit 42\n".utf8).write(to: executable)
    try run("/usr/bin/codesign", ["--force", "--sign", "-", app.path])

    XCTAssertEqual(
      try configuration.validatedCodexAppExecutableURL(),
      executable.standardizedFileURL
    )

    try Data(
      """
      <?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0"><dict>
        <key>CFBundleExecutable</key><string>Fake Codex</string>
        <key>CFBundleIdentifier</key><string>test.codex-panel.other-codex</string>
        <key>CFBundlePackageType</key><string>APPL</string>
      </dict></plist>
      """.utf8
    ).write(to: contents.appendingPathComponent("Info.plist"))
    try run("/usr/bin/codesign", ["--force", "--sign", "-", app.path])

    XCTAssertThrowsError(try configuration.validatedCodexAppExecutableURL())
  }

  func testValidatedCodexAppRejectsExecutableOutsideBundle() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let app = directory.appendingPathComponent("Fake Codex.app", isDirectory: true)
    let contents = app.appendingPathComponent("Contents", isDirectory: true)
    let bundledExecutable = contents.appendingPathComponent("MacOS/Fake Codex")
    let outsideExecutable = directory.appendingPathComponent("outside-codex")
    try FileManager.default.createDirectory(
      at: bundledExecutable.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    for executable in [bundledExecutable, outsideExecutable] {
      try Data("#!/bin/sh\nexit 0\n".utf8).write(to: executable)
      try FileManager.default.setAttributes(
        [.posixPermissions: 0o755],
        ofItemAtPath: executable.path
      )
    }
    try Data(
      """
      <?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0"><dict>
        <key>CFBundleExecutable</key><string>Fake Codex</string>
        <key>CFBundleIdentifier</key><string>test.codex-panel.fake-codex</string>
        <key>CFBundlePackageType</key><string>APPL</string>
      </dict></plist>
      """.utf8
    ).write(to: contents.appendingPathComponent("Info.plist"))
    try run("/usr/bin/codesign", ["--force", "--sign", "-", app.path])
    let configuration = try configuration(
      nodePath: outsideExecutable.path,
      nodeSha256: try sha256(outsideExecutable),
      codexAppPath: app.path,
      codexAppDesignatedRequirement: "identifier \"test.codex-panel.fake-codex\"",
      codexAppExecutablePath: outsideExecutable.path
    )

    XCTAssertThrowsError(try configuration.validatedCodexAppExecutableURL())
  }

  func testValidatedCodexExecutableEnforcesIndependentSignatureAcrossUpdates() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let fixture = try signedCodexFixture(in: directory)
    let configuration = try configuration(
      nodePath: fixture.appExecutable.path,
      nodeSha256: try sha256(fixture.appExecutable),
      codexAppPath: fixture.app.path,
      codexAppDesignatedRequirement: fixture.appRequirement,
      codexAppExecutablePath: fixture.appExecutable.path,
      codexExecutablePath: fixture.cliExecutable.path,
      codexExecutableDesignatedRequirement: fixture.cliRequirement
    )

    XCTAssertEqual(
      try configuration.validatedCodexExecutableURL(),
      fixture.cliExecutable.standardizedFileURL
    )

    try replaceExecutable(at: fixture.cliExecutable, with: "/usr/bin/false")
    try signExecutable(fixture.cliExecutable, identifier: fixture.cliIdentifier)
    try signApp(fixture.app)

    XCTAssertEqual(
      try configuration.validatedCodexExecutableURL(),
      fixture.cliExecutable.standardizedFileURL
    )

    try Data("unsigned replacement".utf8).write(to: fixture.cliExecutable)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o755],
      ofItemAtPath: fixture.cliExecutable.path
    )
    try signApp(fixture.app)
    XCTAssertThrowsError(try configuration.validatedCodexExecutableURL()) { error in
      guard case ConfigurationError.invalidCodeSignature(let label, _) = error else {
        return XCTFail("Expected an unsigned CLI signature failure, got \(error)")
      }
      XCTAssertEqual(label, "Codex CLI")
    }

    try replaceExecutable(at: fixture.cliExecutable, with: "/bin/echo")
    try signExecutable(fixture.cliExecutable, identifier: "test.codex-panel.other-cli")
    try signApp(fixture.app)

    XCTAssertThrowsError(try configuration.validatedCodexExecutableURL()) { error in
      guard case ConfigurationError.invalidCodeSignature(let label, _) = error else {
        return XCTFail("Expected an invalid CLI signature, got \(error)")
      }
      XCTAssertEqual(label, "Codex CLI")
    }
  }

  func testValidatedCodexExecutableRejectsSymbolicLinksAndBundleEscape() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let fixture = try signedCodexFixture(in: directory)
    let outsideExecutable = directory.appendingPathComponent("outside-codex")
    try replaceExecutable(at: outsideExecutable, with: "/usr/bin/true")
    try signExecutable(outsideExecutable, identifier: fixture.cliIdentifier)

    let outsideConfiguration = try configuration(
      nodePath: fixture.appExecutable.path,
      nodeSha256: try sha256(fixture.appExecutable),
      codexAppPath: fixture.app.path,
      codexAppDesignatedRequirement: fixture.appRequirement,
      codexAppExecutablePath: fixture.appExecutable.path,
      codexExecutablePath: outsideExecutable.path,
      codexExecutableDesignatedRequirement: fixture.cliRequirement
    )
    XCTAssertThrowsError(try outsideConfiguration.validatedCodexExecutableURL()) { error in
      guard case ConfigurationError.untrustedExecutable = error else {
        return XCTFail("Expected a bundle-containment failure, got \(error)")
      }
    }

    try FileManager.default.removeItem(at: fixture.cliExecutable)
    try FileManager.default.createSymbolicLink(
      at: fixture.cliExecutable,
      withDestinationURL: outsideExecutable
    )
    try signApp(fixture.app)
    let symlinkConfiguration = try configuration(
      nodePath: fixture.appExecutable.path,
      nodeSha256: try sha256(fixture.appExecutable),
      codexAppPath: fixture.app.path,
      codexAppDesignatedRequirement: fixture.appRequirement,
      codexAppExecutablePath: fixture.appExecutable.path,
      codexExecutablePath: fixture.cliExecutable.path,
      codexExecutableDesignatedRequirement: fixture.cliRequirement
    )
    XCTAssertThrowsError(try symlinkConfiguration.validatedCodexExecutableURL()) { error in
      guard case ConfigurationError.untrustedExecutable = error else {
        return XCTFail("Expected a symbolic-link rejection, got \(error)")
      }
    }
  }

  private func configuration(
    nodePath: String,
    nodeSha256: String,
    codexAppPath: String = "/Applications/ChatGPT.app",
    codexAppDesignatedRequirement: String = "identifier com.openai.codex",
    codexAppExecutablePath: String? = nil,
    codexExecutablePath: String? = nil,
    codexExecutableDesignatedRequirement: String? = nil
  ) throws -> LauncherConfiguration {
    let payload: [String: Any] = [
      "version": 4,
      "runtimeRelativePath": "runtime",
      "dataDirectory": "/tmp/data",
      "logPath": "/tmp/panel.log",
      "nodePath": nodePath,
      "nodeSha256": nodeSha256,
      "pathValue": "/usr/bin:/bin",
      "codexAppPath": codexAppPath,
      "codexAppDesignatedRequirement": codexAppDesignatedRequirement,
      "codexAppExecutablePath": codexAppExecutablePath ?? nodePath,
      "codexExecutablePath": codexExecutablePath ?? nodePath,
      "codexExecutableDesignatedRequirement": codexExecutableDesignatedRequirement
        ?? codexAppDesignatedRequirement,
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

  private func signedCodexFixture(in directory: URL) throws -> SignedCodexFixture {
    let appIdentifier = "test.codex-panel.fake-codex"
    let cliIdentifier = "test.codex-panel.fake-cli"
    let app = directory.appendingPathComponent("Fake Codex.app", isDirectory: true)
    let contents = app.appendingPathComponent("Contents", isDirectory: true)
    let appExecutable = contents.appendingPathComponent("MacOS/Fake Codex")
    let cliExecutable = contents.appendingPathComponent("Resources/codex")
    try FileManager.default.createDirectory(
      at: appExecutable.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    try FileManager.default.createDirectory(
      at: cliExecutable.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    try replaceExecutable(at: appExecutable, with: "/usr/bin/true")
    try replaceExecutable(at: cliExecutable, with: "/usr/bin/true")
    try Data(
      """
      <?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0"><dict>
        <key>CFBundleExecutable</key><string>Fake Codex</string>
        <key>CFBundleIdentifier</key><string>\(appIdentifier)</string>
        <key>CFBundlePackageType</key><string>APPL</string>
      </dict></plist>
      """.utf8
    ).write(to: contents.appendingPathComponent("Info.plist"))
    try signExecutable(cliExecutable, identifier: cliIdentifier)
    try signApp(app)
    return SignedCodexFixture(
      app: app,
      appExecutable: appExecutable,
      cliExecutable: cliExecutable,
      appIdentifier: appIdentifier,
      cliIdentifier: cliIdentifier
    )
  }

  private func replaceExecutable(at destination: URL, with sourcePath: String) throws {
    if FileManager.default.fileExists(atPath: destination.path) {
      try FileManager.default.removeItem(at: destination)
    }
    try FileManager.default.copyItem(
      at: URL(fileURLWithPath: sourcePath),
      to: destination
    )
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o755],
      ofItemAtPath: destination.path
    )
  }

  private func signExecutable(_ executable: URL, identifier: String) throws {
    try run(
      "/usr/bin/codesign",
      ["--force", "--sign", "-", "--identifier", identifier, executable.path]
    )
  }

  private func signApp(_ app: URL) throws {
    try run("/usr/bin/codesign", ["--force", "--sign", "-", app.path])
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
