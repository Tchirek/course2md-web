param([string[]]$ExtensionId = @())
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskData = if ($env:C2MD_DATA_DIR) { $env:C2MD_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'course2md' }
$taskLocation = Join-Path $taskData 'location.json'
if (-not $env:C2MD_DATA_DIR -and (Test-Path -LiteralPath $taskLocation)) {
    $taskChosen = (Get-Content -LiteralPath $taskLocation -Raw | ConvertFrom-Json).dir
    if ([IO.Path]::IsPathRooted($taskChosen)) { $taskData = $taskChosen }
}
$taskCache = Join-Path $taskData 'bootstrap'
New-Item -ItemType Directory -Path $taskCache -Force | Out-Null
$taskArch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }

function Get-CheckedFile([string]$Url, [string]$File, [string]$Hash) {
    if ((Test-Path -LiteralPath $File) -and (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash -eq $Hash) { return }
    Write-Host "Downloading $Url"
    $taskIncoming = $File + '.download'
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $taskIncoming
    if ((Get-FileHash -LiteralPath $taskIncoming -Algorithm SHA256).Hash -ne $Hash) { throw "Checksum failed: $File" }
    Move-Item -LiteralPath $taskIncoming -Destination $File -Force
}

$taskNode = $null
$taskNodeCandidates = @($env:C2MD_NODE, (Get-Command node.exe -ErrorAction SilentlyContinue).Source,
    (Join-Path $taskCache "node-v24.13.0-win-$taskArch\node.exe"))
foreach ($taskCandidate in $taskNodeCandidates) {
    if (-not $taskCandidate -or -not (Test-Path -LiteralPath $taskCandidate)) { continue }
    try {
        $taskVersion = & $taskCandidate --version
        if ($LASTEXITCODE -eq 0 -and $taskVersion -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22) { $taskNode = $taskCandidate; break }
    } catch { continue }
}
if (-not $taskNode) {
    $taskNodeHash = if ($taskArch -eq 'arm64') { '92b9f9b0c0c123e11e4afc535f0ec19cd987465eea506427553a49971364158a' } else { 'ca2742695be8de44027d71b3f53a4bdb36009b95575fe1ae6f7f0b5ce091cb88' }
    $taskZip = Join-Path $taskCache "node-v24.13.0-win-$taskArch.zip"
    Get-CheckedFile "https://nodejs.org/dist/v24.13.0/node-v24.13.0-win-$taskArch.zip" $taskZip $taskNodeHash
    Expand-Archive -LiteralPath $taskZip -DestinationPath $taskCache -Force
    $taskNode = Join-Path $taskCache "node-v24.13.0-win-$taskArch\node.exe"
}

$taskPython = $null
$taskPythonCandidates = @($env:C2MD_PYTHON, (Get-Command python.exe -ErrorAction SilentlyContinue).Source,
    (Join-Path $taskCache 'python\python.exe'))
$taskPyLauncher = Get-Command py.exe -ErrorAction SilentlyContinue
if ($taskPyLauncher) {
    try {
        $taskFromLauncher = & $taskPyLauncher.Source -3 -c 'import sys; print(sys.executable)' 2>$null
        if ($LASTEXITCODE -eq 0) { $taskPythonCandidates += $taskFromLauncher }
    } catch { }
}
foreach ($taskCandidate in $taskPythonCandidates) {
    if (-not $taskCandidate -or -not (Test-Path -LiteralPath $taskCandidate)) { continue }
    try {
        & $taskCandidate -c 'import sys, tomllib, venv; assert sys.version_info >= (3, 11)' 2>$null
        if ($LASTEXITCODE -eq 0) { $taskPython = $taskCandidate; break }
    } catch { continue }
}
if (-not $taskPython) {
    $taskPythonName = if ($taskArch -eq 'arm64') { 'python-3.13.12-arm64.exe' } else { 'python-3.13.12-amd64.exe' }
    $taskPythonHash = if ($taskArch -eq 'arm64') { 'a4476454abcc329b04d330a296995cce5530544d3d2fc006d89f17ae9437fb8c' } else { '96159fcb523ae404b707186a75b4104ee23851e476a5e838e14584cf1e03f981' }
    $taskInstaller = Join-Path $taskCache $taskPythonName
    Get-CheckedFile "https://www.python.org/ftp/python/3.13.12/$taskPythonName" $taskInstaller $taskPythonHash
    $taskPythonFolder = Join-Path $taskCache 'python'
    $taskInstallArgs = @('/quiet', 'InstallAllUsers=0', 'Include_launcher=0', 'Include_test=0', 'PrependPath=0', ('TargetDir="' + $taskPythonFolder + '"'))
    $taskInstall = Start-Process -FilePath $taskInstaller -ArgumentList $taskInstallArgs -WindowStyle Hidden -Wait -PassThru
    if ($taskInstall.ExitCode -notin @(0, 3010)) { throw "Python setup failed: $($taskInstall.ExitCode)" }
    $taskPython = Join-Path $taskPythonFolder 'python.exe'
}
$env:C2MD_PYTHON = $taskPython
$taskBin = Join-Path $taskData 'bin'
New-Item -ItemType Directory -Path $taskBin -Force | Out-Null
$env:PATH = $taskBin + ';' + (Split-Path -Parent $taskNode) + ';' + $env:PATH
if (-not (Get-Command ffmpeg.exe -ErrorAction SilentlyContinue) -or -not (Get-Command ffprobe.exe -ErrorAction SilentlyContinue)) {
    $taskFfmpegZip = Join-Path $taskCache 'ffmpeg-8.1.2-essentials_build.zip'
    Get-CheckedFile 'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.zip' $taskFfmpegZip 'db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec'
    Expand-Archive -LiteralPath $taskFfmpegZip -DestinationPath $taskCache -Force
    foreach ($taskTool in @('ffmpeg.exe', 'ffprobe.exe')) {
        Copy-Item -LiteralPath (Join-Path $taskCache "ffmpeg-8.1.2-essentials_build\bin\$taskTool") -Destination (Join-Path $taskBin $taskTool) -Force
    }
}
if (-not (Get-Command yt-dlp.exe -ErrorAction SilentlyContinue)) {
    $taskYtName = if ($taskArch -eq 'arm64') { 'yt-dlp_arm64.exe' } else { 'yt-dlp.exe' }
    $taskYtHash = if ($taskArch -eq 'arm64') { '05b438997bafc3affdfda9d041353c9d73e04dc842207254b655b0887c4445b0' } else { '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a' }
    Get-CheckedFile "https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/$taskYtName" (Join-Path $taskBin 'yt-dlp.exe') $taskYtHash
}
& ffmpeg.exe -version | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'FFmpeg check failed' }
& yt-dlp.exe --version | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'yt-dlp check failed' }
$taskRuntime = @{ python = $taskPython } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $taskData 'runtime.json'), $taskRuntime, [Text.UTF8Encoding]::new($false))
$taskDeploy = Join-Path $taskData 'helper\tools'
New-Item -ItemType Directory -Path $taskDeploy -Force | Out-Null
if ([IO.Path]::GetFullPath($PSScriptRoot) -ne [IO.Path]::GetFullPath($taskDeploy)) {
    Get-ChildItem -LiteralPath $PSScriptRoot -File | Where-Object { $_.Extension -in @('.mjs', '.py', '.cs', '.json', '.ps1') } | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $taskDeploy $_.Name) -Force
    }
}
& $taskNode (Join-Path $taskDeploy 'install-local-asr.mjs') @ExtensionId
if ($LASTEXITCODE -ne 0) { throw 'Helper registration failed' }
