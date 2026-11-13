# Runs the folder-module tests in headless Chrome, for a PC without Node.js.
#
#   powershell -ExecutionPolicy Bypass -File tests\browser\run-in-chrome.ps1
#
# It covers the tests that need no simulated TIPS page: documents-folder, document-exceptions and
# library-layout. The other tests (jsdom simulations of the Reader) still need `npm test`.
# Chrome runs with its own throwaway profile, so your open Chrome windows are not touched.
param([string[]]$Tests = @('documents-folder', 'document-exceptions', 'library-layout'), [string]$Chrome = '')

$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot)
if (-not $Chrome) {
  $Chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
              "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $Chrome) { throw 'Chrome was not found. Pass its path with -Chrome.' }

$work = Join-Path $env:TEMP ('tips-exporter-tests-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $work | Out-Null
$url = { param($p) 'file:///' + ($p -replace '\\', '/' -replace ' ', '%20') }
$wrap = { param($p) "function (module, exports, require, process, console, __dirname, Buffer) {`n" + [IO.File]::ReadAllText($p) + "`n}" }
$pass = 0; $fail = 0
try {
  foreach ($name in $Tests) {
    $page = Join-Path $work "$name.html"
    $html = @"
<!doctype html><meta charset="utf-8"><title>$name</title><pre id="out"></pre>
<script src="$(& $url (Join-Path $root 'tests\browser\node-shim.js'))"></script>
<script src="$(& $url (Join-Path $root 'index-csv.js'))"></script>
<script src="$(& $url (Join-Path $root 'documents-client.js'))"></script>
<script src="$(& $url (Join-Path $root 'documents-folder.js'))"></script>
<script>__define('helpers/memory-fs', $(& $wrap (Join-Path $root 'tests\helpers\memory-fs.js')));</script>
<script>__run($(& $wrap (Join-Path $root "tests\$name.test.js")));</script>
"@
    [IO.File]::WriteAllText($page, $html, (New-Object Text.UTF8Encoding($false)))
    $dump = Join-Path $work "$name.out.txt"
    $arguments = @('--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
                   "--user-data-dir=`"$(Join-Path $work 'profile')`"", '--virtual-time-budget=10000', '--dump-dom', "`"$(& $url $page)`"")
    $p = Start-Process -FilePath $Chrome -ArgumentList $arguments -RedirectStandardOutput $dump -RedirectStandardError (Join-Path $work "$name.err.txt") -WindowStyle Hidden -PassThru
    if (-not $p.WaitForExit(120000)) { try { $p.Kill() } catch {}; Write-Output "x $name  Chrome did not finish"; $fail++; continue }
    # Chrome's helper processes can still be writing the page dump after the launcher exits: wait for the whole page.
    $text = ''; $until = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $until) {
      try {
        $stream = New-Object IO.FileStream($dump, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        try { $text = (New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)).ReadToEnd() } finally { $stream.Dispose() }
      } catch { }
      if ($text -match '</html>') { break }
      Start-Sleep -Milliseconds 500
    }
    $m = [regex]::Match($text, '(?s)<pre id="out">(.*?)</pre>')
    $lines = if ($m.Success) { [Net.WebUtility]::HtmlDecode($m.Groups[1].Value) -split "`n" } else { @('ERROR the page produced no output') }
    $p1 = @($lines | Where-Object { $_ -match '^PASS ' }).Count
    $bad = @($lines | Where-Object { $_ -match '^(FAIL|ERROR)\b' })
    $pass += $p1; $fail += $bad.Count
    if ($p1 -eq 0 -and $bad.Count -eq 0) { $fail++; $bad = @('ERROR no checks ran') }
    Write-Output ("{0} {1,-22} {2} passed{3}" -f $(if ($bad.Count) { 'x' } else { 'ok' }), $name, $p1, $(if ($bad.Count) { ", $($bad.Count) failed" } else { '' }))
    $bad | ForEach-Object { Write-Output ('    ' + ($_ -replace '\s+at .*$', '')) }
    $lines | Where-Object { $_ -match '^INFO ' } | ForEach-Object { Write-Output ('    ' + $_.Substring(5)) }
  }
} finally {
  Start-Sleep -Milliseconds 300
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Output ''
Write-Output "$pass checks passed, $fail failed"
exit $(if ($fail) { 1 } else { 0 })
