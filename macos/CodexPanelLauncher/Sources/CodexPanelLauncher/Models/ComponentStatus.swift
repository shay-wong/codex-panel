import Foundation

enum ComponentStatusLevel {
  case healthy
  case working
  case warning
  case idle
  case failed
}

struct ComponentStatus {
  let title: String
  let detail: String
  let systemImage: String
  let level: ComponentStatusLevel
}
