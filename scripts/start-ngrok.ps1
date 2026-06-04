param(
  [int]$Port = 5679,
  [string]$Url = ""
)

$ErrorActionPreference = "Stop"

$ngrokCommand = Get-Command ngrok -ErrorAction SilentlyContinue
$ngrokPath = if ($ngrokCommand) { $ngrokCommand.Source } else { Join-Path $env:USERPROFILE "bin\ngrok\ngrok.exe" }

if (!(Test-Path $ngrokPath)) {
  throw "ngrok was not found in PATH. Install it first, then run: ngrok config add-authtoken <token>"
}

$args = @("http", "http://localhost:$Port")
if ($Url) {
  $args += "--url=$Url"
}

Write-Host "Starting ngrok tunnel"
Write-Host "Upstream: http://localhost:$Port"
if ($Url) {
  Write-Host "Public URL: $Url"
} else {
  Write-Host "Public URL: auto-assigned by ngrok"
}
Write-Host ""

& $ngrokPath @args
