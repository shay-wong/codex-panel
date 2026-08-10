import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  private var appearanceObservation: NSKeyValueObservation?
  private var terminationInProgress = false
  var shutdownHandler: (() async -> Void)?

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)
    appearanceObservation = NSApp.observe(
      \.effectiveAppearance,
      options: [.initial, .new]
    ) { [weak self] application, _ in
      DispatchQueue.main.async {
        self?.updateApplicationIcon(for: application.effectiveAppearance)
      }
    }
  }

  func applicationShouldHandleReopen(
    _ sender: NSApplication,
    hasVisibleWindows flag: Bool
  ) -> Bool {
    if !flag {
      sender.windows.first(where: { !($0 is NSPanel) })?.makeKeyAndOrderFront(nil)
    }
    return true
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard let shutdownHandler else { return .terminateNow }
    guard !terminationInProgress else { return .terminateLater }
    terminationInProgress = true
    Task {
      await shutdownHandler()
      sender.reply(toApplicationShouldTerminate: true)
    }
    return .terminateLater
  }

  private func updateApplicationIcon(for appearance: NSAppearance) {
    let iconName = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
      ? "CodexPanelDark"
      : "CodexPanel"
    guard
      let iconURL = Bundle.main.url(forResource: iconName, withExtension: "icns"),
      let icon = NSImage(contentsOf: iconURL)
    else { return }
    NSApp.applicationIconImage = icon
  }
}

@main
struct CodexPanelLauncherApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @StateObject private var manager: PanelManager
  @StateObject private var loginItems = LoginItemController()

  init() {
    let result = Result { try LauncherConfiguration.load() }
    _manager = StateObject(wrappedValue: PanelManager(configurationResult: result))
  }

  var body: some Scene {
    WindowGroup("Codex Panel", id: "main") {
      ContentView(manager: manager)
        .task {
          appDelegate.shutdownHandler = {
            await manager.shutdown()
          }
          await manager.activate()
        }
    }
    .defaultSize(width: 760, height: 540)
    .windowResizability(.contentMinSize)
    .commands {
      CommandMenu("Panel") {
        Button("打开任务面板") {
          Task { await manager.openEmbeddedPanel() }
        }
        .keyboardShortcut("p", modifiers: [.command, .shift])

        Button("重新启动服务") {
          Task { await manager.restartAll() }
        }
        .keyboardShortcut("r", modifiers: [.command, .shift])

        Divider()

        Button("停止服务") {
          Task { await manager.stopAll() }
        }

        Button("打开运行日志") {
          manager.openLog()
        }

        Divider()

        Button("检查更新") {
          Task { await manager.checkForUpdates() }
        }
        .disabled(manager.isCheckingForUpdates)
      }
    }

    Settings {
      SettingsView(manager: manager, loginItems: loginItems)
    }
  }
}
