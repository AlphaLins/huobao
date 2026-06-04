param(
  [int]$Port = 5679,
  [string]$HostName = "127.0.0.1",
  [string]$PublicUrl = "",
  [string]$CorsOrigins = "",
  [string]$PublicAccessPassword = "",
  [string]$AdminUsername = "",
  [string]$AdminPassword = ""
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$backend = Join-Path $root "backend"

$env:PORT = "$Port"
$env:HOST = $HostName

if ($PublicUrl) {
  $origin = $PublicUrl.TrimEnd("/")
  if (!$CorsOrigins) {
    $CorsOrigins = "$origin,http://localhost:3013,http://127.0.0.1:3013,http://localhost:$Port,http://127.0.0.1:$Port"
  }
}

if ($CorsOrigins) {
  $env:CORS_ORIGINS = $CorsOrigins
}
if ($PublicAccessPassword) {
  $env:PUBLIC_ACCESS_PASSWORD = $PublicAccessPassword
}
if ($AdminUsername) {
  $env:ADMIN_USERNAME = $AdminUsername
}
if ($AdminPassword) {
  $env:ADMIN_PASSWORD = $AdminPassword
}

Write-Host "Starting Huobao public server"
Write-Host "Local:  http://$HostName`:$Port"
if ($PublicUrl) {
  Write-Host "Public: $PublicUrl"
}
Write-Host "Access password: $(if ($PublicAccessPassword) { 'custom' } else { 'default huobao' })"
Write-Host ""

Push-Location $backend
try {
  npm run start
} finally {
  Pop-Location
}
