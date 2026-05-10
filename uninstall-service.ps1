#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

$ServiceName = 'AnthropicQuotaProxy'
$ProjectDir  = Split-Path -Parent $MyInvocation.MyCommand.Definition
$NssmPath    = Join-Path $ProjectDir 'tools\nssm.exe'

if (Test-Path $NssmPath) {
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc) {
        Write-Host "Stopping and removing service '$ServiceName'..."
        & $NssmPath stop $ServiceName 2>&1 | Out-Null
        Start-Sleep -Seconds 2
        & $NssmPath remove $ServiceName confirm
        Write-Host "Service removed."
    } else {
        Write-Host "Service '$ServiceName' not found — nothing to remove."
    }
} else {
    Write-Host "NSSM not found at $NssmPath"
    # Fall back to sc.exe
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc) {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        sc.exe delete $ServiceName | Out-Null
        Write-Host "Service removed via sc.exe."
    }
}

Write-Host "Removing ANTHROPIC_BASE_URL user env var..."
[System.Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', $null, 'User')
Write-Host "Done. Restart Claude Code to restore direct API connection."
