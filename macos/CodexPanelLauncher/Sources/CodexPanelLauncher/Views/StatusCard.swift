import SwiftUI

struct StatusCard: View {
  let status: ComponentStatus

  private var tint: Color {
    switch status.level {
    case .healthy:
      return .green
    case .working:
      return .blue
    case .warning:
      return .orange
    case .idle:
      return .secondary
    case .failed:
      return .red
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack {
        Image(systemName: status.systemImage)
          .font(.system(size: 17, weight: .semibold))
          .foregroundStyle(tint)
        Spacer()
        Circle()
          .fill(tint)
          .frame(width: 8, height: 8)
      }

      VStack(alignment: .leading, spacing: 4) {
        Text(status.title)
          .font(.headline)
        Text(status.detail)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .lineLimit(2)
      }
    }
    .frame(maxWidth: .infinity, minHeight: 88, alignment: .topLeading)
    .padding(16)
    .background(.quaternary.opacity(0.55), in: RoundedRectangle(cornerRadius: 8))
    .overlay {
      RoundedRectangle(cornerRadius: 8)
        .stroke(.separator.opacity(0.45), lineWidth: 1)
    }
  }
}
