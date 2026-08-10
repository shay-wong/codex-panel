import Foundation

struct IntegrationRecoveryPolicy {
  private let failureWindow: TimeInterval
  private let delays: [TimeInterval]
  private var failures: [Date] = []

  init(
    failureWindow: TimeInterval = 60,
    delays: [TimeInterval] = [2, 5, 15]
  ) {
    self.failureWindow = failureWindow
    self.delays = delays
  }

  mutating func recordUnexpectedExit(at date: Date = Date()) -> TimeInterval? {
    failures.removeAll { date.timeIntervalSince($0) >= failureWindow }
    guard failures.count < delays.count else { return nil }
    let delay = delays[failures.count]
    failures.append(date)
    return delay
  }

  mutating func reset() {
    failures.removeAll()
  }
}
