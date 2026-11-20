# Starwright one-step installer for Windows.
#
#   irm https://raw.githubusercontent.com/jsmith0475/Starwright/main/install.ps1 | iex
#
# Downloads the game into your user folder (Starwright), adds a Desktop shortcut, and starts it.
# Run it again to update. Nothing is installed system-wide and no administrator rights are needed.
# To remove Starwright, delete the folder and the shortcut.
#
# Options (environment variables):
#   STARWRIGHT_DIR        install somewhere other than %USERPROFILE%\Starwright
#   STARWRIGHT_NO_LAUNCH  set to 1 to install only, without starting the game
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repo = 'jsmith0475/Starwright'
$ref = if ($env:STARWRIGHT_REF) { $env:STARWRIGHT_REF } else { 'main' }
$dir = if ($env:STARWRIGHT_DIR) { $env:STARWRIGHT_DIR } else { Join-Path $env:USERPROFILE 'Starwright' }
$archive = if ($env:STARWRIGHT_ARCHIVE_URL) { $env:STARWRIGHT_ARCHIVE_URL } else { "https://github.com/$repo/archive/refs/heads/$ref.zip" }

function Test-Starwright($path) {
  $index = Join-Path $path 'index.html'
  (Test-Path -LiteralPath $index) -and ((Get-Content -LiteralPath $index -Raw) -match '<title>Starwright</title>')
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("starwright-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host 'Downloading Starwright...'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $zip = Join-Path $tmp 'starwright.zip'
  Invoke-WebRequest -UseBasicParsing -Uri $archive -OutFile $zip
  Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $tmp 'unzipped')
  $src = Get-ChildItem -LiteralPath (Join-Path $tmp 'unzipped') -Directory | Select-Object -First 1
  if (-not $src -or -not (Test-Starwright $src.FullName)) { throw 'The download does not look like Starwright.' }

  if (Test-Path -LiteralPath $dir) {
    if (Test-Starwright $dir) {
      Write-Host "Updating the copy in $dir (your saved games live in the browser and are not touched)."
      Remove-Item -LiteralPath $dir -Recurse -Force
    } else {
      throw "$dir already exists and is not a Starwright folder. Move it, or set STARWRIGHT_DIR to another folder."
    }
  }
  $parent = Split-Path -Parent $dir
  if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
  Move-Item -LiteralPath $src.FullName -Destination $dir
  Get-ChildItem -LiteralPath $dir -Recurse -File | Unblock-File

  $bat = Join-Path $dir 'start.bat'
  try {
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Starwright.lnk'))
    $lnk.TargetPath = $bat
    $lnk.WorkingDirectory = $dir
    $lnk.Description = 'Starwright: build rockets and fly them with real orbital mechanics'
    $lnk.Save()
    Write-Host 'Added a Starwright shortcut to your Desktop.'
  } catch {
    Write-Host 'Could not add a Desktop shortcut; start the game with start.bat in the folder below.'
  }

  Write-Host ''
  Write-Host "Starwright is installed in $dir"
  if ($env:STARWRIGHT_NO_LAUNCH) {
    Write-Host 'Start it any time with the Desktop shortcut or start.bat.'
  } else {
    Write-Host 'Starting it now. Next time, use the Desktop shortcut.'
    Start-Process -FilePath $bat -WorkingDirectory $dir
  }
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
