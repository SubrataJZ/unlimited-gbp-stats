# build-zip.ps1 -- package the extension for upload / Chrome Web Store.
#
# Ships ONLY what the manifest actually loads. Tests, the frozen legacy
# server/, *.bak, and the preview/dev HTML pages stay out -- a store review
# rejects unused files, and shipping server/ would leak dead code.
#
# Usage:  powershell -ExecutionPolicy Bypass -File build-zip.ps1
# Output: ../dist/unlimited-gbp-stats-<version>.zip

$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$manifest = Get-Content (Join-Path $src 'manifest.json') -Raw | ConvertFrom-Json
$version = $manifest.version

# -- Store-readiness checks -----------------------------------------------
# Caught here rather than after a multi-day review turnaround. See
# DISTRIBUTION.md for why the Web Store is the channel and update_url is not.

# The Web Store rejects any manifest carrying update_url: a store-hosted
# extension updates through the store, and a manifest that names its own update
# server is refused at upload.
if ($manifest.PSObject.Properties.Name -contains 'update_url') {
  throw "manifest.json contains update_url -- the Chrome Web Store rejects this. Remove it (see DISTRIBUTION.md)."
}

# A version that is not strictly higher than the published one is refused too.
if ($version -notmatch '^\d+\.\d+\.\d+$') {
  throw "version '$version' is not SemVer x.y.z"
}

# Every file the manifest or an HTML page references, and nothing else.
$files = @(
  'manifest.json',
  'background.js', 'storage.js', 'metrics-payload.js', 'backend-jwt.js', 'review-date.js',
  'content.js', 'content.css',
  'popup.html', 'popup.js',
  'auth.html', 'auth.js', 'auth.css',
  'dashboard.html', 'dashboard.js', 'dashboard.css'
)
$icons = @('icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png')

# Fail loudly on a missing file rather than shipping a broken zip.
foreach ($f in ($files + $icons)) {
  if (-not (Test-Path (Join-Path $src $f))) { throw "missing: $f" }
}

$dist = Join-Path (Split-Path $src -Parent) 'dist'
if (-not (Test-Path $dist)) { New-Item -ItemType Directory -Path $dist | Out-Null }
$zip = Join-Path $dist "unlimited-gbp-stats-$version.zip"
if (Test-Path $zip) { Remove-Item $zip }

# Entries are written by hand rather than with Compress-Archive: on Windows
# PowerShell 5.1 that cmdlet stores "icons\icon16.png" with a BACKSLASH, which
# violates the zip spec (4.4.17.1 requires "/") and is a known cause of Chrome
# Web Store upload rejections and silent unpack failures. Naming each entry
# explicitly also keeps manifest.json at the archive root, with no wrapper folder.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::Open($zip, 'Create')
try {
  foreach ($f in ($files + $icons)) {
    $entry = $f -replace '\\', '/'
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $archive, (Join-Path $src $f), $entry, 'Optimal') | Out-Null
  }
} finally {
  $archive.Dispose()
}

$kb = [math]::Round((Get-Item $zip).Length / 1KB, 1)
Write-Output "built: $zip ($kb KB, $($files.Count + $icons.Count) files, v$version)"
