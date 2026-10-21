import AppKit

// AppKit has a bottom-left global origin; screen capture and source anchors use top-left points.
func captureRect(_ rect: NSRect, primaryTop: CGFloat) -> NSRect {
    let x = floor(rect.minX)
    let y = floor(primaryTop - rect.maxY)
    return NSRect(x: x, y: y, width: ceil(rect.maxX)-x, height: ceil(primaryTop-rect.minY)-y)
}

func finish(_ response: [String: Any]) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
    exit(0)
}

if CommandLine.arguments.dropFirst() == ["--self-test"] {
    assert(captureRect(NSRect(x: 10, y: 800, width: 200, height: 100), primaryTop: 1080) == NSRect(x: 10, y: 180, width: 200, height: 100))
    assert(captureRect(NSRect(x: -900, y: -100, width: 200, height: 100), primaryTop: 1080) == NSRect(x: -900, y: 1080, width: 200, height: 100))
    assert(captureRect(NSRect(x: 1500, y: 1200, width: 200, height: 100), primaryTop: 1080).minY == -220)
    assert(captureRect(NSRect(x: 10.25, y: 800.25, width: 100.5, height: 50.5), primaryTop: 1080) == NSRect(x: 10, y: 229, width: 101, height: 51))
    finish(["passed": true])
}
guard CommandLine.arguments.count == 2 else { finish(["error": "ocr_capture_failed"]) }
let destination = CommandLine.arguments[1]
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
var overlays: [NSWindow] = []
var selecting = false

final class RegionWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

final class RegionView: NSView {
    private var start: NSPoint?
    private var selection: NSRect?
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .crosshair) }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { finish(["cancelled": true]) }
    }
    override func mouseDown(with event: NSEvent) {
        guard !selecting else { return }
        start = convert(event.locationInWindow, from: nil)
        window?.makeFirstResponder(self)
    }
    override func mouseDragged(with event: NSEvent) {
        guard let start else { return }
        let point = convert(event.locationInWindow, from: nil)
        let rect = NSRect(x: min(start.x, point.x), y: min(start.y, point.y), width: abs(point.x-start.x), height: abs(point.y-start.y))
        selection = rect.intersection(bounds)
        needsDisplay = true
    }
    override func mouseUp(with event: NSEvent) {
        mouseDragged(with: event)
        guard let selection, selection.width >= 4, selection.height >= 4, let window else { start = nil; return }
        selecting = true
        let screenRect = window.convertToScreen(convert(selection, to: nil))
        guard let primary = NSScreen.screens.first else { finish(["error": "ocr_capture_failed"]) }
        let region = captureRect(screenRect, primaryTop: primary.frame.maxY)
        let scale = window.backingScaleFactor
        if region.width * region.height * scale * scale > 16_000_000 { finish(["error": "ocr_image_too_large"]) }
        overlays.forEach { $0.orderOut(nil) }
        // Wait for the compositor to remove the selection overlay before taking the region.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            let capture = Process()
            capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            capture.arguments = ["-x", "-t", "png", "-R", "\(Int(region.minX)),\(Int(region.minY)),\(Int(region.width)),\(Int(region.height))", destination]
            capture.standardOutput = FileHandle.nullDevice
            capture.standardError = FileHandle.nullDevice
            do { try capture.run(); capture.waitUntilExit() } catch { finish(["error": "ocr_capture_failed"]) }
            guard capture.terminationStatus == 0, FileManager.default.fileExists(atPath: destination) else { finish(["error": "ocr_capture_failed"]) }
            finish(["bounds": ["x": region.minX * scale, "y": region.minY * scale, "width": region.width * scale, "height": region.height * scale]])
        }
    }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.withAlphaComponent(0.18).setFill()
        bounds.fill()
        if let selection {
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current?.cgContext.clear(selection)
            NSGraphicsContext.restoreGraphicsState()
            NSColor(calibratedRed: 0.77, green: 0.80, blue: 0.65, alpha: 1).setStroke()
            let border = NSBezierPath(rect: selection.insetBy(dx: -0.5, dy: -0.5))
            border.lineWidth = 1
            border.stroke()
        }
        let text = "拖动框选文字区域 · Esc 取消"
        text.draw(at: NSPoint(x: 24, y: bounds.height-58), withAttributes: [.font: NSFont.systemFont(ofSize: 15), .foregroundColor: NSColor.white])
    }
}

for screen in NSScreen.screens {
    let window = RegionWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
    window.setFrame(screen.frame, display: false)
    window.level = .screenSaver
    window.backgroundColor = .clear
    window.isOpaque = false
    window.hasShadow = false
    window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    let view = RegionView(frame: NSRect(origin: .zero, size: screen.frame.size))
    window.contentView = view
    window.makeFirstResponder(view)
    overlays.append(window)
    window.orderFrontRegardless()
}
overlays.first?.makeKey()
app.activate(ignoringOtherApps: true)
app.run()
