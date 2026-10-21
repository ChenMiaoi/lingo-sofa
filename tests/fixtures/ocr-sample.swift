// Rebuild with: swift tests/fixtures/ocr-sample.swift tests/fixtures/ocr-sample.png
import AppKit

let image = NSImage(size: NSSize(width: 1200, height: 280))
image.lockFocus()
NSColor.white.setFill()
NSRect(x: 0, y: 0, width: 1200, height: 280).fill()
let attributes: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 44), .foregroundColor: NSColor.black,
]
"LingoSofa OCR 42".draw(at: NSPoint(x: 50, y: 180), withAttributes: attributes)
"本地识别，校对后翻译。".draw(at: NSPoint(x: 50, y: 70), withAttributes: attributes)
image.unlockFocus()
let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
