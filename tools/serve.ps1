# Starwright static server for Windows. Started by start.bat; needs nothing but the PowerShell
# that ships with Windows 10 and 11. Serves the game folder on localhost only.
param([int]$Port = 8642, [switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$url = "http://localhost:$Port/"
$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'
  '.mjs' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'; '.svg' = 'image/svg+xml'; '.png' = 'image/png'
  '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'; '.gif' = 'image/gif'; '.webp' = 'image/webp'
  '.ico' = 'image/x-icon'; '.mp4' = 'video/mp4'; '.wasm' = 'application/wasm'
  '.txt' = 'text/plain; charset=utf-8'; '.md' = 'text/plain; charset=utf-8'
}

function Open-Game { if (-not $NoBrowser) { Start-Process $url } }

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($url)
try {
  $listener.Start()
} catch {
  # The port is taken. If it is Starwright already running, just open it.
  $page = ''
  try { $page = (Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 3).Content } catch {}
  if ($page -match '<title>Starwright</title>') {
    Write-Host "Starwright is already running at $url"
    Open-Game
    exit 0
  }
  Write-Host "Could not start on port $Port. Another program may be using it."
  Write-Host "Close that program, or run:  start.bat -Port 8700"
  exit 1
}

Write-Host "Starwright is running at $url"
Write-Host "Leave this window open while you play. Close it to stop."
Open-Game

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $res = $ctx.Response
    try {
      $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
      if ($rel -eq '' -or $rel.EndsWith('/')) { $rel += 'index.html' }
      $full = [IO.Path]::GetFullPath((Join-Path $root $rel))
      $inside = $full.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
      if ($inside -and (Test-Path -LiteralPath $full -PathType Leaf)) {
        $bytes = [IO.File]::ReadAllBytes($full)
        $ext = [IO.Path]::GetExtension($full).ToLowerInvariant()
        if ($types.ContainsKey($ext)) { $res.ContentType = $types[$ext] } else { $res.ContentType = 'application/octet-stream' }
        $res.Headers['Cache-Control'] = 'no-cache'
        $res.ContentLength64 = $bytes.Length
        if ($ctx.Request.HttpMethod -ne 'HEAD') { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
      } else {
        $res.StatusCode = 404
      }
    } catch {
      try { $res.StatusCode = 500 } catch {}
    } finally {
      try { $res.Close() } catch {}
    }
  }
} finally {
  $listener.Stop()
}
