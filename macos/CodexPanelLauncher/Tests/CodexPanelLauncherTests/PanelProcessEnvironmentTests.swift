import XCTest
@testable import CodexPanelLauncher

final class PanelProcessEnvironmentTests: XCTestCase {
  func testSanitizedEnvironmentRemovesRuntimeInjectionVariables() {
    let environment = sanitizedPanelProcessEnvironment(
      inheriting: [
        "HOME": "/Users/test",
        "LANG": "zh_CN.UTF-8",
        "PATH": "/untrusted/bin",
        "CODEX_PANEL_HOST": "0.0.0.0",
        "CODEX_PANEL_DATA_DIR": "/untrusted/data",
        "CODEX_EXECUTABLE": "/untrusted/codex",
        "NODE_OPTIONS": "--require=/tmp/inject.cjs",
        "NODE_PATH": "/tmp/modules",
        "NPM_CONFIG_NODE_OPTIONS": "--import=/tmp/inject.mjs",
        "BASH_ENV": "/tmp/bash-env",
        "ENV": "/tmp/sh-env",
        "ZDOTDIR": "/tmp/zsh",
        "CODEX_PANEL_PORT": "47999",
        "CODEX_TASKBOARD_PORT": "48000",
        "DYLD_INSERT_LIBRARIES": "/tmp/inject.dylib",
        "DYLD_LIBRARY_PATH": "/tmp/dylibs",
        "LD_PRELOAD": "/tmp/inject.so",
        "LD_LIBRARY_PATH": "/tmp/libs",
      ],
      pathValue: "/trusted/bin",
      dataDirectory: "/trusted/data",
      panelPort: 47_823,
      codexExecutablePath: "/trusted/codex",
      runtimeFilePath: "/trusted/data/launcher-runtime.json"
    )

    for key in [
      "NODE_OPTIONS",
      "NODE_PATH",
      "NPM_CONFIG_NODE_OPTIONS",
      "BASH_ENV",
      "ENV",
      "ZDOTDIR",
      "CODEX_TASKBOARD_PORT",
      "DYLD_INSERT_LIBRARIES",
      "DYLD_LIBRARY_PATH",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
    ] {
      XCTAssertNil(environment[key], "\(key) must not reach the signed Node runtime")
    }
    XCTAssertEqual(environment["HOME"], "/Users/test")
    XCTAssertEqual(environment["LANG"], "zh_CN.UTF-8")
    XCTAssertEqual(environment["PATH"], "/trusted/bin")
    XCTAssertEqual(environment["CODEX_PANEL_HOST"], "127.0.0.1")
    XCTAssertEqual(environment["CODEX_PANEL_DATA_DIR"], "/trusted/data")
    XCTAssertEqual(environment["CODEX_PANEL_PORT"], "47823")
    XCTAssertEqual(environment["CODEX_EXECUTABLE"], "/trusted/codex")
    XCTAssertEqual(
      environment["CODEX_PANEL_RUNTIME_FILE"],
      "/trusted/data/launcher-runtime.json"
    )
  }
}
