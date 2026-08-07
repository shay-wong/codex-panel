import AppKit
import ServiceManagement

@MainActor
final class LoginItemController: ObservableObject {
  @Published private(set) var isEnabled = false
  @Published private(set) var requiresApproval = false
  @Published private(set) var errorMessage: String?

  private let service = SMAppService.mainApp

  init() {
    refresh()
  }

  func refresh() {
    switch service.status {
    case .enabled:
      isEnabled = true
      requiresApproval = false
    case .requiresApproval:
      isEnabled = true
      requiresApproval = true
    case .notRegistered, .notFound:
      isEnabled = false
      requiresApproval = false
    @unknown default:
      isEnabled = false
      requiresApproval = false
    }
  }

  func setEnabled(_ enabled: Bool) {
    errorMessage = nil
    do {
      if enabled {
        if service.status == .notRegistered || service.status == .notFound {
          try service.register()
        }
      } else if service.status != .notRegistered {
        try service.unregister()
      }
    } catch {
      errorMessage = error.localizedDescription
    }
    refresh()
  }

  func openSystemSettings() {
    SMAppService.openSystemSettingsLoginItems()
  }
}
