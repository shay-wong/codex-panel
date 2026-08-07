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
    }
    .frame(width: 480, height: 300)
    .padding(12)
    .onAppear {
      loginItems.refresh()
    }
  }
}
