#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

$ServiceName = 'ClaudeRouter'
$ProjectDir  = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ToolsDir    = Join-Path $ProjectDir 'tools'
$NssmPath    = Join-Path $ToolsDir 'nssm.exe'
$ProxyScript = Join-Path $ProjectDir 'proxy.js'

# --- Validate Node.js ---
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) { throw "node.exe not found in PATH. Install Node.js first." }
$NodePath    = $NodeCmd.Source
$NodeVersion = & $NodePath --version 2>&1
if ($LASTEXITCODE -ne 0) { throw "node.exe found at $NodePath but failed to run: $NodeVersion" }
Write-Host "Node: $NodeVersion at $NodePath"

# --- Resolve user profile ---
# Under standard UAC elevation (same user elevated), USERPROFILE is correct.
# Under runas with a different admin account it will be wrong — confirm with user.
$UserProfile = $env:USERPROFILE
$UsageFile   = "$UserProfile\.claude\usage-status.md"

Write-Host ""
Write-Host "Detected user profile : $UserProfile"
Write-Host "Usage file will be    : $UsageFile"
$confirm = Read-Host "Correct? (Y/N)"
if ($confirm -notmatch '^[Yy]') {
    $UserProfile = Read-Host "Enter correct user profile path (e.g. C:\Users\mark)"
    $UsageFile   = "$UserProfile\.claude\usage-status.md"
    Write-Host "Using: $UsageFile"
}
Write-Host ""

# --- NSSM download ---
if (-not (Test-Path $ToolsDir)) { New-Item -ItemType Directory -Path $ToolsDir | Out-Null }

if (-not (Test-Path $NssmPath)) {
    Write-Host "Downloading NSSM 2.24..."
    $ZipPath     = Join-Path $env:TEMP "nssm-$([System.Guid]::NewGuid().ToString('N')).zip"
    $ExtractPath = Join-Path $env:TEMP "nssm-$([System.Guid]::NewGuid().ToString('N'))"
    try {
        Invoke-WebRequest -Uri 'https://nssm.cc/release/nssm-2.24.zip' -OutFile $ZipPath -UseBasicParsing
        Expand-Archive -Path $ZipPath -DestinationPath $ExtractPath -Force
        $NssmBin = Get-ChildItem -Path $ExtractPath -Filter 'nssm.exe' -Recurse |
                   Where-Object { $_.Directory.Name -eq 'win64' } |
                   Select-Object -First 1
        if (-not $NssmBin) { throw "Could not find nssm.exe (win64) in downloaded zip" }
        Copy-Item $NssmBin.FullName $NssmPath -Force
        Write-Host "NSSM saved to $NssmPath"
    } finally {
        Remove-Item $ZipPath     -Force -ErrorAction SilentlyContinue
        Remove-Item $ExtractPath -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-Nssm {
    param([string[]]$NssmArgs)
    $output = & $NssmPath @NssmArgs 2>&1
    if ($output) { Write-Host "  nssm: $output" }
    if ($LASTEXITCODE -ne 0) {
        throw "NSSM command failed (exit $LASTEXITCODE): nssm $($NssmArgs -join ' ')"
    }
}

# --- Remove existing service ---
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Removing existing '$ServiceName'..."
    & $NssmPath stop $ServiceName 2>&1 | Out-Null
    Start-Sleep -Seconds 2
    Invoke-Nssm @('remove', $ServiceName, 'confirm')
}

# --- Install service ---
# Install with executable only, then set AppParameters separately — avoids NSSM mishandling
# paths with spaces when passed inline to the install command
Write-Host "Installing service..."
Invoke-Nssm @('install', $ServiceName, $NodePath)
Invoke-Nssm @('set', $ServiceName, 'AppParameters', "`"$ProxyScript`"")
Invoke-Nssm @('set', $ServiceName, 'DisplayName',  'Claude Router')
Invoke-Nssm @('set', $ServiceName, 'Description',  'Routes Claude Code traffic between api.anthropic.com and a local LiteLLM gateway based on model and quota state, and writes a usage-status.md file Claude can read.')
Invoke-Nssm @('set', $ServiceName, 'Start',        'SERVICE_AUTO_START')
Invoke-Nssm @('set', $ServiceName, 'AppDirectory', $ProjectDir)
Invoke-Nssm @('set', $ServiceName, 'AppStdout',    (Join-Path $ProjectDir 'proxy.log'))
Invoke-Nssm @('set', $ServiceName, 'AppStderr',    (Join-Path $ProjectDir 'proxy-error.log'))
Invoke-Nssm @('set', $ServiceName, 'AppRotateFiles',  '1')
Invoke-Nssm @('set', $ServiceName, 'AppRotateBytes',  '1048576')

# Bake the actual user home path in — service runs as LocalSystem so os.homedir() would be wrong.
# To track quota PER ACCOUNT when multiple Claude logins share this router, also pass
# CLAUDE_CONFIG_DIRS (newline-separated entries in a single AppEnvironmentExtra value), e.g.:
#   Invoke-Nssm @('set', $ServiceName, 'AppEnvironmentExtra', "CLAUDE_USAGE_FILE=$UsageFile`nCLAUDE_CONFIG_DIRS=$env:USERPROFILE\.claude,$env:USERPROFILE\.claude2")
Invoke-Nssm @('set', $ServiceName, 'AppEnvironmentExtra', "CLAUDE_USAGE_FILE=$UsageFile")

# --- User environment variable ---
Write-Host "Setting ANTHROPIC_BASE_URL for current user..."
[System.Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', 'http://127.0.0.1:4080', 'User')

# --- Start service ---
Write-Host "Starting service..."
Invoke-Nssm @('start', $ServiceName)
Start-Sleep -Seconds 2
$svc = Get-Service -Name $ServiceName
Write-Host "Service status: $($svc.Status)"

Write-Host ""
Write-Host "=== Done ==="
Write-Host ""
Write-Host "IMPORTANT: Existing Claude Code sessions will NOT route through the proxy."
Write-Host "ANTHROPIC_BASE_URL is now set, but only new processes pick up user env var changes."
Write-Host ""
Read-Host "Close all Claude Code windows now, then press Enter to confirm you have restarted it"
Write-Host ""
Write-Host "Good. After your first request, usage will appear at:"
Write-Host "  $UsageFile"
