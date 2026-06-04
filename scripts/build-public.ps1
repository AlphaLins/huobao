param(
  [switch]$Install
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")

function Run-Step($Title, $Path, $Command, $ArgList) {
  Write-Host ""
  Write-Host "==> $Title"
  Push-Location $Path
  try {
    & $Command @ArgList
  } finally {
    Pop-Location
  }
}

if ($Install) {
  Run-Step "Install backend dependencies" (Join-Path $root "backend") "npm" @("ci")
  Run-Step "Install frontend dependencies" (Join-Path $root "frontend") "npm" @("ci")
}

Run-Step "Typecheck backend" (Join-Path $root "backend") "npm" @("run", "typecheck")
Run-Step "Generate frontend static build" (Join-Path $root "frontend") "npm" @("run", "generate")

$source = Join-Path $root "frontend\.output\public"
$target = Join-Path $root "frontend\dist"

if (!(Test-Path $source)) {
  throw "Frontend output was not found: $source"
}

if (Test-Path $target) {
  Remove-Item -LiteralPath $target -Recurse -Force
}

Copy-Item -LiteralPath $source -Destination $target -Recurse
Write-Host ""
Write-Host "Public frontend copied to $target"
