$ErrorActionPreference = 'Continue'

$ports = @(5679, 3013, 3000)
$killed = @{}

Write-Host "Huobao dev port cleanup"
Write-Host "Ports: $($ports -join ', ')"
Write-Host ""

foreach ($port in $ports) {
  $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue

  if (-not $connections) {
    Write-Host "Port ${port}: no listening process"
    continue
  }

  foreach ($connection in $connections) {
    $procId = [int]$connection.OwningProcess
    if ($procId -le 0 -or $killed.ContainsKey($procId)) {
      continue
    }

    try {
      $process = Get-Process -Id $procId -ErrorAction Stop
      Stop-Process -Id $procId -Force -ErrorAction Stop
      $killed[$procId] = $true
      Write-Host "Port ${port}: killed PID $procId ($($process.ProcessName))"
    } catch {
      Write-Host "Port ${port}: failed to kill PID $procId - $($_.Exception.Message)"
    }
  }
}

Write-Host ""
if ($killed.Count -eq 0) {
  Write-Host "No processes were killed."
} else {
  Write-Host "Done. Killed $($killed.Count) process(es)."
}
