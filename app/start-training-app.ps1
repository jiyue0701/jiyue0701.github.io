$ErrorActionPreference = 'SilentlyContinue'

$appRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeBin = 'C:\Users\50699\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin'
$pnpm = 'C:\Users\50699\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd'
$url = 'http://localhost:5173/?view=home'

$env:PATH = "$nodeBin;$env:PATH"

$running = $false
try {
  $probe = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
  $running = $probe.StatusCode -eq 200
} catch {
  $running = $false
}

if (-not $running) {
  Start-Process -FilePath $pnpm -ArgumentList 'exec','vite','--host','127.0.0.1','--port','5173' -WorkingDirectory $appRoot -WindowStyle Hidden
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 500
    try {
      $probe = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
      if ($probe.StatusCode -eq 200) { break }
    } catch {}
  }
}

Start-Process $url
