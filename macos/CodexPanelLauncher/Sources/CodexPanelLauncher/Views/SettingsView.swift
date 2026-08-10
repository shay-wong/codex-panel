import SwiftUI

struct SettingsView: View {
  @ObservedObject var manager: PanelManager
  @ObservedObject var loginItems: LoginItemController
  @AppStorage(PreferenceKey.autoConnectCodex) private var autoConnectCodex = true
  @AppStorage(PreferenceKey.autoOpenPanel) private var autoOpenPanel = true

  var body: some View {
    TabView {
      Form {
        Section("启动") {
          Toggle(
            "登录时启动 Codex Panel",
            isOn: Binding(
              get: { loginItems.isEnabled },
              set: { loginItems.setEnabled($0) }
            )
          )
          Toggle("启动时连接 Codex", isOn: $autoConnectCodex)
          Toggle("连接后自动打开任务面板", isOn: $autoOpenPanel)
            .disabled(!autoConnectCodex)
        }

        if loginItems.requiresApproval {
          Section {
            LabeledContent("登录项", value: "等待系统批准")
            Button("打开登录项设置") {
              loginItems.openSystemSettings()
            }
          }
        }

        if let error = loginItems.errorMessage {
          Section {
            Text(error)
              .foregroundStyle(.red)
              .textSelection(.enabled)
          }
        }
      }
      .formStyle(.grouped)
      .tabItem {
        Label("通用", systemImage: "gearshape")
      }

      Form {
        Section("本机数据") {
          Button("在 Finder 中显示数据目录") {
            manager.revealDataDirectory()
          }
          Button("打开运行日志") {
            manager.openLog()
          }
        }
      }
      .formStyle(.grouped)
      .tabItem {
        Label("位置", systemImage: "folder")
      }

      Form {
        Section("版本") {
          LabeledContent("当前版本", value: manager.currentVersion)
          LabeledContent("更新状态") {
            HStack(spacing: 8) {
              if manager.isCheckingForUpdates {
                ProgressView()
                  .controlSize(.small)
              }
              Text(manager.updateMessage)
                .foregroundStyle(.secondary)
            }
          }
        }

        Section {
          HStack {
            Button("检查更新") {
              Task { await manager.checkForUpdates() }
            }
            .disabled(manager.isCheckingForUpdates)

            if manager.availableReleaseVersion != nil {
              Button("查看 Release") {
                manager.openAvailableRelease()
              }
            }
          }
        }
      }
      .formStyle(.grouped)
      .tabItem {
        Label("更新", systemImage: "arrow.down.circle")
      }
    }
    .frame(width: 500, height: 340)
    .padding(12)
    .onAppear {
      loginItems.refresh()
    }
  }
}
