import XCTest
@testable import CodexPanelLauncher

final class ReleaseUpdateCheckerTests: XCTestCase {
  func testInstalledVersionPrefersTheFullForkVersion() {
    XCTAssertEqual(
      installedPanelVersion(from: [
        "CodexPanelVersion": "0.2.0-fork.1",
        "CFBundleShortVersionString": "0.2.0",
      ]),
      "0.2.0-fork.1"
    )
    XCTAssertEqual(
      installedPanelVersion(from: ["CFBundleShortVersionString": "0.2.0"]),
      "0.2.0"
    )
    XCTAssertEqual(installedPanelVersion(from: nil), "development")
  }

  func testForkVersionsFollowSemanticVersionOrdering() throws {
    XCTAssertLessThan(
      try XCTUnwrap(PanelVersion("0.2.0-fork.1")),
      try XCTUnwrap(PanelVersion("0.2.0-fork.2"))
    )
    XCTAssertLessThan(
      try XCTUnwrap(PanelVersion("0.2.0-fork.9")),
      try XCTUnwrap(PanelVersion("0.2.0"))
    )
    XCTAssertLessThan(
      try XCTUnwrap(PanelVersion("v0.2.0")),
      try XCTUnwrap(PanelVersion("0.3.0-fork.1"))
    )
  }

  func testReleaseURLMustBelongToTheForkReleasePath() throws {
    XCTAssertEqual(
      trustedPanelReleaseURL(
        "https://github.com/shay-wong/codex-panel/releases/tag/v0.2.0-fork.1"
      )?.absoluteString,
      "https://github.com/shay-wong/codex-panel/releases/tag/v0.2.0-fork.1"
    )
    XCTAssertNil(trustedPanelReleaseURL(
      "https://example.com/shay-wong/codex-panel/releases/tag/v9.9.9"
    ))
    XCTAssertNil(trustedPanelReleaseURL(
      "https://github.com/another-owner/codex-panel/releases/tag/v9.9.9"
    ))
    XCTAssertNil(trustedPanelReleaseURL(
      "https://github.com/shay-wong/codex-panel/releases/tag/v0.2.0-fork.2",
      expectedTag: "v0.2.0-fork.1"
    ))
  }

  func testReleaseListIncludesPrereleasesAndSelectsTheHighestVersion() throws {
    let data = Data(
      """
      [
        {
          "tag_name": "v0.2.0-fork.1",
          "html_url": "https://github.com/shay-wong/codex-panel/releases/tag/v0.2.0-fork.1",
          "draft": false,
          "prerelease": true
        },
        {
          "tag_name": "v0.2.0-fork.2",
          "html_url": "https://github.com/shay-wong/codex-panel/releases/tag/v0.2.0-fork.2",
          "draft": false,
          "prerelease": true
        },
        {
          "tag_name": "v9.0.0",
          "html_url": "https://github.com/shay-wong/codex-panel/releases/tag/v9.0.0",
          "draft": false,
          "prerelease": false
        }
      ]
      """.utf8
    )
    XCTAssertEqual(
      try ReleaseUpdateChecker().evaluate(
        statusCode: 200,
        data: data,
        currentVersion: "0.2.0-fork.1"
      ),
      .available(
        version: "0.2.0-fork.2",
        url: URL(
          string: "https://github.com/shay-wong/codex-panel/releases/tag/v0.2.0-fork.2"
        )!
      )
    )
    XCTAssertEqual(
      try ReleaseUpdateChecker().evaluate(
        statusCode: 404,
        data: Data(),
        currentVersion: "0.2.0-fork.1"
      ),
      .noPublishedRelease
    )
    XCTAssertEqual(
      try ReleaseUpdateChecker().evaluate(
        statusCode: 200,
        data: Data("[]".utf8),
        currentVersion: "0.2.0-fork.1"
      ),
      .noPublishedRelease
    )
    let upstreamOnly = Data(
      """
      [
        {
          "tag_name": "v9.0.0",
          "html_url": "https://github.com/shay-wong/codex-panel/releases/tag/v9.0.0",
          "draft": false
        }
      ]
      """.utf8
    )
    XCTAssertEqual(
      try ReleaseUpdateChecker().evaluate(
        statusCode: 200,
        data: upstreamOnly,
        currentVersion: "0.2.0-fork.1"
      ),
      .noPublishedRelease
    )
  }
}
