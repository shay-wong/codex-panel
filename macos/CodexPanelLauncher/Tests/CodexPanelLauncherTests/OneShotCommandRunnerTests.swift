import Foundation
import XCTest
@testable import CodexPanelLauncher

final class OneShotCommandRunnerTests: XCTestCase {
  func testSeparatesStandardOutputFromWarnings() async throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/sh")
    process.arguments = [
      "-c",
      "printf '{\"port\":9229}'; printf 'SQLite warning\\n' >&2",
    ]

    let output = try await runOneShotCommand(process, timeoutSeconds: 2)

    XCTAssertEqual(output.standardOutput, "{\"port\":9229}")
    XCTAssertEqual(output.standardError, "SQLite warning")
    XCTAssertEqual(output.terminationStatus, 0)
  }

  func testPreservesBothOutputStreamsForFailedCommands() async throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/sh")
    process.arguments = [
      "-c",
      "printf 'partial output'; printf 'failure detail\\n' >&2; exit 7",
    ]

    let output = try await runOneShotCommand(process, timeoutSeconds: 2)

    XCTAssertEqual(output.standardOutput, "partial output")
    XCTAssertEqual(output.standardError, "failure detail")
    XCTAssertEqual(output.terminationStatus, 7)
  }

  func testTimesOutCommandsThatDoNotExit() async {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/sleep")
    process.arguments = ["10"]

    do {
      _ = try await runOneShotCommand(process, timeoutSeconds: 0.1)
      XCTFail("Expected the command to time out")
    } catch let error as OneShotCommandError {
      guard case .timedOut = error else {
        return XCTFail("Unexpected command error: \(error)")
      }
    } catch {
      XCTFail("Unexpected error: \(error)")
    }
  }
}
