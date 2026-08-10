import Foundation

struct PanelVersion: Comparable, CustomStringConvertible {
  private enum Identifier: Equatable {
    case number(Int)
    case text(String)
  }

  let major: Int
  let minor: Int
  let patch: Int
  private let prerelease: [Identifier]
  let description: String

  init?(_ value: String) {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    let normalized = trimmed.hasPrefix("v") ? String(trimmed.dropFirst()) : trimmed
    let versionParts = normalized.split(
      separator: "-",
      maxSplits: 1,
      omittingEmptySubsequences: false
    )
    let core = versionParts[0].split(separator: ".", omittingEmptySubsequences: false)
    guard
      core.count == 3,
      let major = Int(core[0]),
      let minor = Int(core[1]),
      let patch = Int(core[2]),
      major >= 0,
      minor >= 0,
      patch >= 0
    else { return nil }

    let prerelease: [Identifier]
    if versionParts.count == 1 {
      prerelease = []
    } else {
      let components = versionParts[1].split(separator: ".", omittingEmptySubsequences: false)
      guard !components.isEmpty, components.allSatisfy({ !$0.isEmpty }) else { return nil }
      prerelease = components.map { component in
        if let number = Int(component) { return .number(number) }
        return .text(component.lowercased())
      }
    }

    self.major = major
    self.minor = minor
    self.patch = patch
    self.prerelease = prerelease
    description = normalized
  }

  static func < (left: PanelVersion, right: PanelVersion) -> Bool {
    for (lhs, rhs) in [
      (left.major, right.major),
      (left.minor, right.minor),
      (left.patch, right.patch),
    ] where lhs != rhs {
      return lhs < rhs
    }
    if left.prerelease.isEmpty != right.prerelease.isEmpty {
      return !left.prerelease.isEmpty
    }
    for index in 0..<min(left.prerelease.count, right.prerelease.count) {
      let lhs = left.prerelease[index]
      let rhs = right.prerelease[index]
      guard lhs != rhs else { continue }
      switch (lhs, rhs) {
      case (.number(let lhs), .number(let rhs)):
        return lhs < rhs
      case (.number, .text):
        return true
      case (.text, .number):
        return false
      case (.text(let lhs), .text(let rhs)):
        return lhs < rhs
      }
    }
    return left.prerelease.count < right.prerelease.count
  }
}

func trustedPanelReleaseURL(_ value: String, expectedTag: String? = nil) -> URL? {
  guard
    let url = URL(string: value),
    url.scheme == "https",
    url.host?.lowercased() == "github.com",
    url.port == nil,
    url.user == nil,
    url.password == nil,
    url.query == nil,
    url.fragment == nil
  else { return nil }
  let components = url.pathComponents.filter { $0 != "/" }
  guard
    components.count == 5,
    components[0] == "shay-wong",
    components[1] == "codex-panel",
    components[2] == "releases",
    components[3] == "tag",
    !components[4].isEmpty,
    expectedTag == nil || components[4] == expectedTag
  else { return nil }
  return url
}

enum ReleaseCheckResult: Equatable {
  case noPublishedRelease
  case current
  case available(version: String, url: URL)
}

struct ReleaseUpdateChecker {
  private struct GitHubRelease: Decodable {
    let tagName: String
    let htmlURL: String
    let draft: Bool

    private enum CodingKeys: String, CodingKey {
      case tagName = "tag_name"
      case htmlURL = "html_url"
      case draft
    }
  }

  private let endpoint = URL(
    string: "https://api.github.com/repos/shay-wong/codex-panel/releases?per_page=100"
  )!

  func check(currentVersion: String) async throws -> ReleaseCheckResult {
    var request = URLRequest(url: endpoint)
    request.timeoutInterval = 8
    request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
    request.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
    request.setValue("codex-panel/\(currentVersion)", forHTTPHeaderField: "User-Agent")
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let httpResponse = response as? HTTPURLResponse else {
      throw ReleaseCheckError.invalidResponse
    }
    return try evaluate(
      statusCode: httpResponse.statusCode,
      data: data,
      currentVersion: currentVersion
    )
  }

  func evaluate(
    statusCode: Int,
    data: Data,
    currentVersion: String
  ) throws -> ReleaseCheckResult {
    guard let installedVersion = PanelVersion(currentVersion) else {
      throw ReleaseCheckError.invalidInstalledVersion(currentVersion)
    }
    if statusCode == 404 { return .noPublishedRelease }
    guard statusCode == 200 else { throw ReleaseCheckError.httpStatus(statusCode) }
    let releases = try JSONDecoder().decode([GitHubRelease].self, from: data)
    let candidates = releases.compactMap { release -> (PanelVersion, URL)? in
      guard
        !release.draft,
        isForkReleaseTag(release.tagName),
        let releaseVersion = PanelVersion(release.tagName),
        let releaseURL = trustedPanelReleaseURL(
          release.htmlURL,
          expectedTag: release.tagName
        )
      else { return nil }
      return (releaseVersion, releaseURL)
    }
    guard let (releaseVersion, releaseURL) = candidates.max(by: { $0.0 < $1.0 }) else {
      return .noPublishedRelease
    }
    guard installedVersion < releaseVersion else { return .current }
    return .available(version: releaseVersion.description, url: releaseURL)
  }
}

private func isForkReleaseTag(_ value: String) -> Bool {
  value.range(
    of: #"^v?[0-9]+\.[0-9]+\.[0-9]+-fork\.[1-9][0-9]*$"#,
    options: .regularExpression
  ) != nil
}

enum ReleaseCheckError: LocalizedError {
  case httpStatus(Int)
  case invalidInstalledVersion(String)
  case invalidResponse

  var errorDescription: String? {
    switch self {
    case .httpStatus(let status):
      return "更新服务返回 HTTP \(status)"
    case .invalidInstalledVersion(let version):
      return "无法识别当前版本：\(version)"
    case .invalidResponse:
      return "更新服务返回了无效数据"
    }
  }
}
