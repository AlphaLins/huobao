$ErrorActionPreference = "Stop"

function Normalize-ProxyUrl([string]$Value) {
  if (!$Value) { return "" }
  $proxy = $Value.Trim()
  if ($proxy -match "=") {
    $parts = $proxy -split ";"
    $https = $parts | Where-Object { $_ -match "^https=" } | Select-Object -First 1
    $http = $parts | Where-Object { $_ -match "^http=" } | Select-Object -First 1
    $proxy = if ($https) { $https -replace "^https=", "" } elseif ($http) { $http -replace "^http=", "" } else { "" }
  }
  if (!$proxy) { return "" }
  if ($proxy -notmatch "^https?://") { $proxy = "http://$proxy" }
  return $proxy
}

$settings = Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -ErrorAction SilentlyContinue
$proxyUrl = ""
if ($settings -and $settings.ProxyEnable -eq 1) {
  $proxyUrl = Normalize-ProxyUrl $settings.ProxyServer
}

if ($proxyUrl) {
  $env:NODE_USE_ENV_PROXY = "1"
  $env:HTTP_PROXY = $proxyUrl
  $env:HTTPS_PROXY = $proxyUrl
  Write-Host "Node proxy enabled: $proxyUrl"
} else {
  Write-Host "Node proxy not enabled: Windows system proxy is disabled"
}
