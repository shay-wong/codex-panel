import XCTest
@testable import CodexPanelLauncher

final class IntegrationRecoveryPolicyTests: XCTestCase {
  func testRecoveryUsesLimitedBackoffInsideFailureWindow() {
    var policy = IntegrationRecoveryPolicy()
    let start = Date(timeIntervalSince1970: 1_000)

    XCTAssertEqual(policy.recordUnexpectedExit(at: start), 2)
    XCTAssertEqual(policy.recordUnexpectedExit(at: start.addingTimeInterval(5)), 5)
    XCTAssertEqual(policy.recordUnexpectedExit(at: start.addingTimeInterval(10)), 15)
    XCTAssertNil(policy.recordUnexpectedExit(at: start.addingTimeInterval(20)))
  }

  func testRecoveryBudgetResetsAfterTheFailureWindow() {
    var policy = IntegrationRecoveryPolicy()
    let start = Date(timeIntervalSince1970: 2_000)

    _ = policy.recordUnexpectedExit(at: start)
    _ = policy.recordUnexpectedExit(at: start.addingTimeInterval(5))
    XCTAssertEqual(policy.recordUnexpectedExit(at: start.addingTimeInterval(66)), 2)
  }
}
