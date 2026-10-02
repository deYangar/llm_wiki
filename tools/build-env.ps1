# build-env.ps1 —— 构建终端会话级注入便携工具链（dot-source 用法）：
#     . .\tools\build-env.ps1
# 只改当前会话环境变量，机器全局零改动（§4.1 原则）。
# 前置：tools\setup-toolchain.ps1 已跑过一次。

$ErrorActionPreference = 'Stop'
$toolsDir = $PSScriptRoot

# ---- MSVC / WinSDK（PortableBuildTools 布局，版本目录动态发现） ----
$msvcRoot = Join-Path $toolsDir 'msvc'
$msvcVer = Get-ChildItem (Join-Path $msvcRoot 'VC\Tools\MSVC') -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
if (-not $msvcVer) { throw "未找到 MSVC，先跑：pwsh -File tools\setup-toolchain.ps1" }
$sdkRoot = Join-Path $msvcRoot 'Windows Kits\10'
$sdkVer = Get-ChildItem (Join-Path $sdkRoot 'Include') -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
if (-not $sdkVer) { throw "未找到 Windows SDK" }

$msvcBin = Join-Path $msvcVer.FullName 'bin\Hostx64\x64'
$sdkBin = Join-Path $sdkRoot "bin\$($sdkVer.Name)\x64"
$env:INCLUDE = @(
    (Join-Path $msvcVer.FullName 'include'),
    (Join-Path $sdkRoot "Include\$($sdkVer.Name)\ucrt"),
    (Join-Path $sdkRoot "Include\$($sdkVer.Name)\um"),
    (Join-Path $sdkRoot "Include\$($sdkVer.Name)\shared"),
    (Join-Path $sdkRoot "Include\$($sdkVer.Name)\winrt"),
    (Join-Path $sdkRoot "Include\$($sdkVer.Name)\cppwinrt")
) -join ';'
$env:LIB = @(
    (Join-Path $msvcVer.FullName 'lib\x64'),
    (Join-Path $sdkRoot "Lib\$($sdkVer.Name)\ucrt\x64"),
    (Join-Path $sdkRoot "Lib\$($sdkVer.Name)\um\x64")
) -join ';'
$env:PATH = "$msvcBin;$sdkBin;$env:PATH"

# ---- Rust（重定向的 CARGO_HOME/RUSTUP_HOME） ----
$env:CARGO_HOME = Join-Path $toolsDir 'cargo'
$env:RUSTUP_HOME = Join-Path $toolsDir 'rustup'
$env:PATH = "$(Join-Path $env:CARGO_HOME 'bin');$env:PATH"

# ---- protoc（会话注入，不设永久变量） ----
$env:PROTOC = Join-Path $toolsDir 'protoc\bin\protoc.exe'
$env:PATH = "$(Split-Path $env:PROTOC -Parent);$env:PATH"

Write-Host "已注入构建环境："
Write-Host "  MSVC $($msvcVer.Name) + WinSDK $($sdkVer.Name)"
Write-Host "  CARGO_HOME=$env:CARGO_HOME"
Write-Host "  RUSTUP_HOME=$env:RUSTUP_HOME"
Write-Host "  PROTOC=$env:PROTOC"
& cl 2>&1 | Select-Object -First 1
& rustc --version
& protoc --version
