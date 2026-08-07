// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "CodexPanelLauncher",
  platforms: [
    .macOS(.v13),
  ],
  products: [
    .executable(name: "CodexPanelLauncher", targets: ["CodexPanelLauncher"]),
    .executable(name: "CodexPanelIconBuilder", targets: ["CodexPanelIconBuilder"]),
  ],
  targets: [
    .executableTarget(
      name: "CodexPanelLauncher",
      path: "Sources/CodexPanelLauncher"
    ),
    .executableTarget(
      name: "CodexPanelIconBuilder",
      path: "Sources/CodexPanelIconBuilder"
    ),
    .testTarget(
      name: "CodexPanelLauncherTests",
      dependencies: ["CodexPanelLauncher"],
      path: "Tests/CodexPanelLauncherTests"
    ),
  ],
  swiftLanguageModes: [.v5]
)
