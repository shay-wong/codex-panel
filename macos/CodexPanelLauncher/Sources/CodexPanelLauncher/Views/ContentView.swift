import AppKit
import SwiftUI

struct ContentView: View {
  @ObservedObject var manager: PanelManager
  @Environment(\.colorScheme) private var colorScheme

  var body: some View {
    VStack(spacing: 0) {
      header
      Divider()
      ScrollView {
        VStack(alignment: .leading, spacing: 22) {
          statusGrid
          if let error = manager.lastError {
            errorBanner(error)
          }
          actions
          locations
        }
        .padding(24)
      }
    }
    .frame(minWidth: 680, minHeight: 500)
    .toolbar {
      ToolbarItemGroup {
        Button {
          Task { await manager.refresh() }
        } label: {
          Image(systemName: "arrow.clockwise")
        }
        .help("刷新状态")
        .disabled(manager.isBusy)

        Button {
          showSettingsWindow()
        } label: {
          Image(systemName: "gearshape")
        }
        .help("设置")
      }
    }
  }

  private var header: some View {
    HStack(spacing: 16) {
      launcherIcon
        .frame(width: 58, height: 58)
      VStack(alignment: .leading, spacing: 4) {
        Text("Codex Panel")
          .font(.title2.weight(.semibold))
        Text("本机服务与 Codex 内嵌集成")
          .foregroundStyle(.secondary)
        Text("版本 \(manager.currentVersion)")
          .font(.caption)
          .foregroundStyle(.tertiary)
      }
      Spacer()
      if manager.isBusy {
        ProgressView()
          .controlSize(.small)
      }
    }
    .padding(.horizontal, 24)
    .padding(.vertical, 18)
  }

  private var launcherIcon: some View {
    Group {
      if let url = Bundle.main.url(
        forResource: colorScheme == .dark ? "CodexPanelDark" : "CodexPanel",
        withExtension: "icns"
      ),
         let image = NSImage(contentsOf: url) {
        Image(nsImage: image)
          .resizable()
          .scaledToFit()
      } else {
        Image(systemName: "rectangle.split.3x1")
          .resizable()
          .scaledToFit()
          .padding(10)
          .foregroundStyle(.blue)
      }
    }
  }

  private var statusGrid: some View {
    HStack(alignment: .top, spacing: 12) {
      StatusCard(status: manager.panelStatus)
      StatusCard(status: manager.codexStatus)
      StatusCard(status: manager.integrationStatus)
    }
  }

  private func errorBanner(_ message: String) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(.orange)
      Text(message)
        .font(.callout)
        .textSelection(.enabled)
      Spacer()
      Button {
        manager.lastError = nil
      } label: {
        Image(systemName: "xmark")
      }
      .buttonStyle(.plain)
      .help("关闭")
    }
    .padding(12)
    .background(.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
  }

  private var actions: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("服务控制")
        .font(.headline)
      HStack(spacing: 10) {
        if manager.isRunning {
          Button {
            Task { await manager.openEmbeddedPanel() }
          } label: {
            Label("打开任务面板", systemImage: "rectangle.split.3x1")
          }
          .buttonStyle(.borderedProminent)
          .keyboardShortcut("p", modifiers: [.command, .shift])
        } else {
          Button {
            Task { await manager.startAll() }
          } label: {
            Label("启动服务", systemImage: "play.fill")
          }
          .buttonStyle(.borderedProminent)
        }

        Button {
          Task { await manager.restartAll() }
        } label: {
          Label("重新启动", systemImage: "arrow.clockwise")
        }

        Button {
          Task { await manager.stopAll() }
        } label: {
          Label("停止", systemImage: "stop.fill")
        }

        Spacer()

        Button {
          manager.openBrowserPanel()
        } label: {
          Image(systemName: "safari")
        }
        .help("在浏览器中打开")

        Button {
          manager.openLog()
        } label: {
          Image(systemName: "doc.text")
        }
        .help("打开日志")
      }
      .disabled(manager.isBusy)
    }
  }

  private var locations: some View {
    HStack(spacing: 14) {
      Button {
        manager.revealDataDirectory()
      } label: {
        Label("数据目录", systemImage: "externaldrive")
      }
      .buttonStyle(.link)

      Button {
        manager.openLog()
      } label: {
        Label("运行日志", systemImage: "doc.text")
      }
      .buttonStyle(.link)
    }
    .font(.callout)
  }

  private func showSettingsWindow() {
    NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
  }
}
