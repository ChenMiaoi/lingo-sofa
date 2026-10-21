param([string]$Helper = (Join-Path $PSScriptRoot '..\apps\desktop\src-tauri\resources\selection-helper.exe'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class SelectionFixtureNative {
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd,uint msg,IntPtr w,IntPtr l);
}
"@
$reports = @()
foreach ($scenario in @('move','scroll','selection-change')) {
 $form = New-Object System.Windows.Forms.Form
 $form.Text = 'LingoSofa owned UIA test fixture'
 $form.StartPosition = 'Manual'
 $form.Location = New-Object System.Drawing.Point(180,160)
 $form.Size = New-Object System.Drawing.Size(700,450)
 $form.TopMost = $true
 $text = New-Object System.Windows.Forms.RichTextBox
 $text.Dock = 'Fill'
 $text.Font = New-Object System.Drawing.Font('Segoe UI',16)
 $expected = 'Selected paragraph for LingoSofa.'
 $text.Text = "Unselected header.`n`n$expected`n`n" + ((1..100 | ForEach-Object { "Unselected following paragraph $_." }) -join "`n")
 $form.Controls.Add($text)
 $state = @{process=$null;line=$null;first=$null;invalid=$null;error=$null;changed=$false;started=[DateTime]::UtcNow;selectedAt=$null}
 $timer = New-Object System.Windows.Forms.Timer
 $timer.Interval = 80
 $form.Add_Shown({
  $text.Focus() | Out-Null
  $text.Select($text.Text.IndexOf($expected),$expected.Length)
  $text.ScrollToCaret()
  $form.Activate()
  $timer.Start()
 })
 $timer.Add_Tick({
  try {
   if (([DateTime]::UtcNow-$state.started).TotalSeconds -gt 10) {throw 'Owned UIA fixture timed out'}
   if (-not $state.process) {
    if (([DateTime]::UtcNow-$state.started).TotalMilliseconds -lt 350) {return}
    [SelectionFixtureNative]::SetForegroundWindow($form.Handle) | Out-Null
    $text.Focus() | Out-Null
    if ([SelectionFixtureNative]::GetForegroundWindow() -ne $form.Handle) {throw 'Foreground activation unavailable in this desktop session'}
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = [IO.Path]::GetFullPath($Helper)
  $info.Arguments = "$($form.Handle.ToInt64()) 0"
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $state.process = [Diagnostics.Process]::Start($info)
  $state.line = $state.process.StandardOutput.ReadLineAsync()
    return
   }
   if ($state.line.IsCompleted) {
    $line=$state.line.Result
    if (-not $line) {throw 'Selection helper closed without invalidation'}
    $frame=$line | ConvertFrom-Json
    if ($frame.kind -eq 'selection') {
     if ($frame.text -ne $expected) {throw 'Selection helper returned text outside the selected paragraph'}
     if ($frame.bounds.width -le 0 -or $frame.bounds.height -le 0) {throw 'Selection bounds are empty'}
     $state.first=$frame
     $state.selectedAt=[DateTime]::UtcNow
    } elseif ($frame.kind -eq 'invalid') {
     if (-not $state.first -or -not $state.changed) {throw "Initial selection failed: $($frame.code)"}
     $state.invalid=$frame.code
     $timer.Stop();$form.Close();return
    }
    $state.line=$state.process.StandardOutput.ReadLineAsync()
   }
   if ($state.first -and -not $state.changed -and (([DateTime]::UtcNow-$state.selectedAt).TotalMilliseconds -gt 500)) {
    $state.changed=$true
    switch ($scenario) {
     'move' {$form.Left += 45}
     'scroll' {[SelectionFixtureNative]::SendMessage($text.Handle,0x115,[IntPtr]3,[IntPtr]::Zero) | Out-Null}
     'selection-change' {$text.Select(0,10)}
    }
   }
  } catch {$state.error=$_.Exception.Message;$timer.Stop();$form.Close()}
 })
 try {$form.ShowDialog() | Out-Null} finally {
  $timer.Stop();$timer.Dispose()
  if ($state.process -and -not $state.process.HasExited) {$state.process.Kill();$state.process.WaitForExit()}
  $form.Dispose()
 }
 $reports += [ordered]@{scenario=$scenario;selectedTextOnly=($null -ne $state.first);bounds=$state.first.bounds;invalidation=$state.invalid;passed=($null -ne $state.invalid -and $null -eq $state.error);error=$state.error}
}
$directory=Join-Path $PSScriptRoot '..\.cache\v3-validation'
[IO.Directory]::CreateDirectory($directory) | Out-Null
$reports | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $directory 'selection-system.json')
$reports | ConvertTo-Json -Depth 6
if (@($reports | Where-Object {-not $_.passed}).Count -ne 0) {exit 1}
