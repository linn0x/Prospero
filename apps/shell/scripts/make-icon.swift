#!/usr/bin/env swift
//
// 生成 Prospero 的 App 图标(.icns)。
//
//   swift scripts/make-icon.swift [输出路径]
//
// 图形是矢量描述的,每个尺寸各画一遍而不是从 1024 缩下去 —— 16pt 那一档
// 靠缩放会糊成一团。配色取自 apps/daemon/term.html 的 Tokyo Night 主题,
// 和 App 里那块终端同源。
import AppKit

// 画布按 1024 设计,其余尺寸靠 CTM 缩放。
let canvas: CGFloat = 1024

func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
  CGColor(
    red: CGFloat((hex >> 16) & 0xff) / 255,
    green: CGFloat((hex >> 8) & 0xff) / 255,
    blue: CGFloat(hex & 0xff) / 255,
    alpha: alpha
  )
}

/// macOS 图标的圆角是超椭圆,不是圆弧倒角。n=5 的超椭圆与系统形状足够接近,
/// 而 CGPath(roundedRect:) 的圆弧角在大尺寸下一眼就能看出来是"另一种圆"。
func squircle(center: CGPoint, radius a: CGFloat, n: CGFloat = 5) -> CGPath {
  let path = CGMutablePath()
  let steps = 512
  for i in 0...steps {
    let t = CGFloat(i) / CGFloat(steps) * 2 * .pi
    let c = cos(t), s = sin(t)
    let x = center.x + a * (c < 0 ? -1 : 1) * pow(abs(c), 2 / n)
    let y = center.y + a * (s < 0 ? -1 : 1) * pow(abs(s), 2 / n)
    if i == 0 { path.move(to: CGPoint(x: x, y: y)) } else { path.addLine(to: CGPoint(x: x, y: y)) }
  }
  path.closeSubpath()
  return path
}

/// 四角星。Prospero 是《暴风雨》里的魔法师 —— 终端提示符旁边那点光就是"art"。
func sparkle(at c: CGPoint, outer: CGFloat, inner: CGFloat) -> CGPath {
  let path = CGMutablePath()
  for i in 0..<8 {
    let r = i.isMultiple(of: 2) ? outer : inner
    let t = CGFloat(i) * .pi / 4 - .pi / 2
    let p = CGPoint(x: c.x + r * cos(t), y: c.y + r * sin(t))
    if i == 0 { path.move(to: p) } else { path.addLine(to: p) }
  }
  path.closeSubpath()
  return path
}

func draw(_ cg: CGContext) {
  let center = CGPoint(x: canvas / 2, y: canvas / 2)
  // 824/1024 是 macOS 图标网格给正方形图标留的内容尺寸,四周留白由系统统一。
  let body = squircle(center: center, radius: 412)

  // 阴影让图标从 Dock 的背景里浮起来。
  cg.saveGState()
  cg.setShadow(offset: CGSize(width: 0, height: 18), blur: 34, color: rgb(0x000000, 0.42))
  cg.addPath(body)
  cg.setFillColor(rgb(0x1a1b26))
  cg.fillPath()
  cg.restoreGState()

  // 底色:上浅下深,深到接近终端画面的 #1a1b26。
  cg.saveGState()
  cg.addPath(body)
  cg.clip()
  let space = CGColorSpaceCreateDeviceRGB()
  if let g = CGGradient(
    colorsSpace: space,
    colors: [rgb(0x2a3050), rgb(0x1a1b26), rgb(0x121320)] as CFArray,
    locations: [0, 0.55, 1]
  ) {
    cg.drawLinearGradient(
      g,
      start: CGPoint(x: 200, y: 140),
      end: CGPoint(x: 820, y: 900),
      options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
    )
  }
  // 左上一团冷光,避免整块底色发死。
  if let glow = CGGradient(
    colorsSpace: space,
    colors: [rgb(0x7aa2f7, 0.26), rgb(0x7aa2f7, 0)] as CFArray,
    locations: [0, 1]
  ) {
    cg.drawRadialGradient(
      glow,
      startCenter: CGPoint(x: 330, y: 250), startRadius: 0,
      endCenter: CGPoint(x: 330, y: 250), endRadius: 560,
      options: []
    )
  }
  cg.restoreGState()

  // 玻璃边:上缘接光、下缘收暗。均匀描边会让整块图形显得是贴上去的。
  cg.saveGState()
  cg.addPath(body)
  cg.setLineWidth(5)
  cg.replacePathWithStrokedPath()
  cg.clip()
  if let g = CGGradient(
    colorsSpace: space,
    colors: [rgb(0xc0caf5, 0.38), rgb(0xc0caf5, 0.10), rgb(0xc0caf5, 0.03)] as CFArray,
    locations: [0, 0.5, 1]
  ) {
    cg.drawLinearGradient(
      g,
      start: CGPoint(x: 512, y: 100),
      end: CGPoint(x: 512, y: 924),
      options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
    )
  }
  cg.restoreGState()

  // 提示符 ❯ —— 图标的主体,16pt 下也要认得出。
  let chevron = CGMutablePath()
  chevron.move(to: CGPoint(x: 330, y: 366))
  chevron.addLine(to: CGPoint(x: 500, y: 512))
  chevron.addLine(to: CGPoint(x: 330, y: 658))

  cg.saveGState()
  cg.setLineWidth(72)
  cg.setLineCap(.round)
  cg.setLineJoin(.round)
  cg.addPath(chevron)
  cg.replacePathWithStrokedPath()
  cg.clip()
  if let g = CGGradient(
    colorsSpace: space,
    colors: [rgb(0x7dcfff), rgb(0x7aa2f7)] as CFArray,
    locations: [0, 1]
  ) {
    cg.drawLinearGradient(
      g,
      start: CGPoint(x: 320, y: 340),
      end: CGPoint(x: 520, y: 680),
      options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
    )
  }
  cg.restoreGState()

  // 光标块:提示符后面等着输入的那一格。
  cg.saveGState()
  let cursor = CGPath(
    roundedRect: CGRect(x: 552, y: 626, width: 148, height: 66),
    cornerWidth: 31, cornerHeight: 31, transform: nil
  )
  cg.addPath(cursor)
  cg.setFillColor(rgb(0xbb9af7))
  cg.fillPath()
  cg.restoreGState()

  // 魔法那一点光。
  cg.saveGState()
  cg.addPath(sparkle(at: CGPoint(x: 664, y: 348), outer: 58, inner: 14))
  cg.setFillColor(rgb(0xe0af68))
  cg.fillPath()
  cg.addPath(sparkle(at: CGPoint(x: 750, y: 262), outer: 26, inner: 6))
  cg.setFillColor(rgb(0xe0af68, 0.75))
  cg.fillPath()
  cg.restoreGState()
}

func render(pixels: Int) -> Data {
  guard let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
  ), let ctx = NSGraphicsContext(bitmapImageRep: rep) else {
    fatalError("无法创建 \(pixels)px 位图")
  }
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = ctx
  let cg = ctx.cgContext
  let scale = CGFloat(pixels) / canvas
  cg.scaleBy(x: scale, y: scale)
  // 位图是左下原点;翻一次,好让上面的坐标按"从上往下"读。
  cg.translateBy(x: 0, y: canvas)
  cg.scaleBy(x: 1, y: -1)
  cg.setAllowsAntialiasing(true)
  draw(cg)
  NSGraphicsContext.restoreGraphicsState()
  guard let data = rep.representation(using: .png, properties: [:]) else {
    fatalError("PNG 编码失败")
  }
  return data
}

let output = CommandLine.arguments.count > 1
  ? CommandLine.arguments[1]
  : FileManager.default.currentDirectoryPath + "/AppIcon.icns"

let iconset = URL(fileURLWithPath: NSTemporaryDirectory())
  .appendingPathComponent("Prospero-\(UUID().uuidString).iconset")
try! FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

// iconutil 认这套固定文件名。
let variants: [(String, Int)] = [
  ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
  ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
  ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
  ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
  ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
]
for (name, px) in variants {
  try! render(pixels: px).write(to: iconset.appendingPathComponent(name))
}

let task = Process()
task.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
task.arguments = ["-c", "icns", iconset.path, "-o", output]
try! task.run()
task.waitUntilExit()
guard task.terminationStatus == 0 else { exit(task.terminationStatus) }
try? FileManager.default.removeItem(at: iconset)

// 顺手留一张大图,方便 README / 预览直接引用。
try! render(pixels: 1024).write(
  to: URL(fileURLWithPath: output).deletingLastPathComponent()
    .appendingPathComponent("AppIcon-1024.png")
)
print("图标已生成:\(output)")
