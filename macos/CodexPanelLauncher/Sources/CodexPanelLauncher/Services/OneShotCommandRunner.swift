import Foundation

struct OneShotCommandOutput: Equatable {
  let standardOutput: String
  let standardError: String
  let terminationStatus: Int32
}

enum OneShotCommandError: LocalizedError {
  case timedOut(seconds: TimeInterval)

  var errorDescription: String? {
    switch self {
    case .timedOut(let seconds):
      return "命令执行超时（\(seconds.formatted()) 秒）"
    }
  }
}

private final class OneShotCommandCompletionGate: @unchecked Sendable {
  private let lock = NSLock()
  private var completed = false

  func claim() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard !completed else { return false }
    completed = true
    return true
  }
}

func runOneShotCommand(
  _ process: Process,
  timeoutSeconds: TimeInterval
) async throws -> OneShotCommandOutput {
  precondition(timeoutSeconds > 0)
  let standardOutput = Pipe()
  let standardError = Pipe()
  let completionGate = OneShotCommandCompletionGate()
  process.standardOutput = standardOutput
  process.standardError = standardError

  return try await withCheckedThrowingContinuation { continuation in
    process.terminationHandler = { finishedProcess in
      guard completionGate.claim() else { return }
      let outputData = standardOutput.fileHandleForReading.readDataToEndOfFile()
      let errorData = standardError.fileHandleForReading.readDataToEndOfFile()
      continuation.resume(returning: OneShotCommandOutput(
        standardOutput: String(decoding: outputData, as: UTF8.self)
          .trimmingCharacters(in: .whitespacesAndNewlines),
        standardError: String(decoding: errorData, as: UTF8.self)
          .trimmingCharacters(in: .whitespacesAndNewlines),
        terminationStatus: finishedProcess.terminationStatus
      ))
    }

    do {
      try process.run()
    } catch {
      guard completionGate.claim() else { return }
      continuation.resume(throwing: error)
      return
    }

    Task.detached {
      try? await Task.sleep(
        nanoseconds: UInt64(timeoutSeconds * 1_000_000_000)
      )
      guard completionGate.claim() else { return }
      if process.isRunning {
        process.terminate()
      }
      continuation.resume(throwing: OneShotCommandError.timedOut(seconds: timeoutSeconds))
    }
  }
}
