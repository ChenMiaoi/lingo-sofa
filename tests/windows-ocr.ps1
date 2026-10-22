param([string]$Helper = "$PSScriptRoot/../target/debug/lingo-sofa-ocr-helper.exe", [switch]$RequireChinese)
$ErrorActionPreference = 'Stop'
function Read-Ocr([string]$Argument) {
    $result = & $Helper $Argument
    if ($LASTEXITCODE -ne 0) { throw 'OCR helper process failed.' }
    $result | Write-Host
    return $result | ConvertFrom-Json
}
$fixture = Read-Ocr "$PSScriptRoot/fixtures/ocr-sample.png"
if (!$fixture.text.Contains('LingoSofa OCR 42')) { throw 'English fixture recognition failed.' }
$chinese = '"\u672c\u5730\u8bc6\u522b"' | ConvertFrom-Json
if (!$fixture.text.Contains($chinese)) { throw 'Chinese fixture recognition failed.' }
$small = Read-Ocr "$PSScriptRoot/fixtures/windows-ocr-small.png"
$expected = "LingoSofa OCR acceptance 42`nThe quick brown fox jumps over the lazy dog.`n" + ('"\u672c\u5730\u622a\u56fe\u8bc6\u522b\uff1a\u53ea\u6d4b\u8bd5\u5408\u6210\u6587\u5b57\uff0c\u4e0d\u5305\u542b\u4e2a\u4eba\u4fe1\u606f\u3002"' | ConvertFrom-Json)
if ($small.text -cne $expected) { throw 'Small-font mixed-language fixture differs from the complete expected text.' }
$synthetic = Read-Ocr '--self-test'
if (!$synthetic.text.Contains('LingoSofa OCR 42')) { throw 'Synthetic GDI capture and OCR failed.' }
$blank = Read-Ocr '--self-test-blank'
if ($blank.error -ne 'ocr_empty') { throw 'Blank capture must fail without submitting text.' }
Write-Host 'Native fixture, synthetic BitBlt and blank recognition checks passed. No user desktop was captured.'
