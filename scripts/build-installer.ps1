# Genera el instalador NSIS de AgentsBoard en dist\ (pasos 1-4 de AGENTS.md, sección 7).
# Uso: powershell -ExecutionPolicy Bypass -File scripts\build-installer.ps1

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

function Invoke-Checked {
  param([string]$Name, [scriptblock]$Command)
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$Name falló con código $LASTEXITCODE" }
}

Write-Host '1/4 Empaquetando sin reconstruir node-pty ni firmar...'
Invoke-Checked 'electron-builder --dir' {
  npx electron-builder --dir --win --config.npmRebuild=false --config.win.signAndEditExecutable=false
}

Write-Host '2/4 Aplicando icono al exe con rcedit...'
$rcedit = (Get-ChildItem "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign" -Recurse -Filter rcedit-x64.exe -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
if (-not $rcedit) { throw 'No se encontró rcedit-x64.exe en la caché de winCodeSign. Revisa AGENTS.md, sección 7.' }
Invoke-Checked 'rcedit' {
  & $rcedit 'dist\win-unpacked\AgentsBoard.exe' --set-icon build\icon.ico
}

Write-Host '3/4 Generando instalador NSIS...'
$pre = (Resolve-Path dist\win-unpacked).Path
Invoke-Checked 'electron-builder nsis' {
  npx electron-builder --win nsis --prepackaged "$pre" --config.win.signAndEditExecutable=false
}

$installer = Get-ChildItem dist -Filter 'AgentsBoard Setup *.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) { throw 'No se generó el instalador en dist\.' }
Write-Host "4/4 Listo: $($installer.FullName) ($($installer.Length) bytes)"
