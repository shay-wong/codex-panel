import AppKit
import Foundation

guard CommandLine.arguments.count == 5 else {
  fputs(
    "usage: CodexPanelIconBuilder <light-source> <dark-source> <light.png> <dark.png>\n",
    stderr
  )
  exit(2)
}

let lightSourcePath = CommandLine.arguments[1]
let darkSourcePath = CommandLine.arguments[2]
let lightOutputPath = CommandLine.arguments[3]
let darkOutputPath = CommandLine.arguments[4]
guard let lightSource = NSImage(contentsOfFile: lightSourcePath) else {
  fputs("unable to read icon at \(lightSourcePath)\n", stderr)
  exit(1)
}
guard let darkSource = NSImage(contentsOfFile: darkSourcePath) else {
  fputs("unable to read icon at \(darkSourcePath)\n", stderr)
  exit(1)
}

let pixelSize = 1024
let canvasSize = NSSize(width: pixelSize, height: pixelSize)

func sourceBitmap(from source: NSImage) -> NSBitmapImageRep {
  let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: pixelSize,
    pixelsHigh: pixelSize,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  )!
  let context = NSGraphicsContext(bitmapImageRep: bitmap)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = context
  context.imageInterpolation = .high
  source.draw(
    in: NSRect(origin: .zero, size: canvasSize),
    from: NSRect(origin: .zero, size: source.size),
    operation: .sourceOver,
    fraction: 1
  )
  context.flushGraphics()
  NSGraphicsContext.restoreGraphicsState()
  return bitmap
}

func drawPanelRibbon(on bitmap: NSBitmapImageRep, dark: Bool) {
  let context = NSGraphicsContext(bitmapImageRep: bitmap)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = context

  NSBezierPath(
    roundedRect: NSRect(x: 96, y: 96, width: 832, height: 832),
    xRadius: 190,
    yRadius: 190
  ).addClip()

  let transform = NSAffineTransform()
  transform.translateX(by: 800, yBy: 800)
  transform.rotate(byDegrees: -45)
  transform.concat()

  let ribbonRect = NSRect(x: -280, y: -50, width: 560, height: 100)
  let shadow = NSShadow()
  shadow.shadowColor = NSColor.black.withAlphaComponent(dark ? 0.52 : 0.32)
  shadow.shadowBlurRadius = 14
  shadow.shadowOffset = NSSize(width: 0, height: -7)

  NSGraphicsContext.saveGraphicsState()
  shadow.set()
  (dark
    ? NSColor(calibratedRed: 0.38, green: 0.44, blue: 1.00, alpha: 0.98)
    : NSColor(calibratedRed: 0.14, green: 0.17, blue: 0.36, alpha: 0.98)
  ).setFill()
  ribbonRect.fill()
  NSGraphicsContext.restoreGraphicsState()

  NSColor.white.withAlphaComponent(dark ? 0.42 : 0.30).setStroke()
  for y in [-48.0, 48.0] {
    let edge = NSBezierPath()
    edge.move(to: NSPoint(x: ribbonRect.minX, y: y))
    edge.line(to: NSPoint(x: ribbonRect.maxX, y: y))
    edge.lineWidth = 3
    edge.stroke()
  }

  let paragraph = NSMutableParagraphStyle()
  paragraph.alignment = .center
  let attributes: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 42, weight: .bold),
    .foregroundColor: NSColor.white,
    .kern: 2.4,
    .paragraphStyle: paragraph,
  ]
  ("PANEL" as NSString).draw(
    in: NSRect(x: ribbonRect.minX, y: -26, width: ribbonRect.width, height: 54),
    withAttributes: attributes
  )

  context.flushGraphics()
  NSGraphicsContext.restoreGraphicsState()
}

func write(_ bitmap: NSBitmapImageRep, to outputPath: String) throws {
  guard let png = bitmap.representation(using: .png, properties: [:]) else {
    throw IconError.encodingFailed
  }
  try png.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
}

enum IconError: LocalizedError {
  case encodingFailed

  var errorDescription: String? {
    "unable to encode generated icon"
  }
}

do {
  let light = sourceBitmap(from: lightSource)
  drawPanelRibbon(on: light, dark: false)
  try write(light, to: lightOutputPath)

  let dark = sourceBitmap(from: darkSource)
  drawPanelRibbon(on: dark, dark: true)
  try write(dark, to: darkOutputPath)
} catch {
  fputs("unable to write icon: \(error.localizedDescription)\n", stderr)
  exit(1)
}
