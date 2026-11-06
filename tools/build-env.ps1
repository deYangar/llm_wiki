# build-env.ps1 —— 构建终端会话级注入构建工具链（dot-source 用法）：
#     . .\tools\build-env.ps1
# 只改当前会话环境变量，机器全局零改动（§4.1 原则）。
# 工具链双层发现：仓内便携工具链（tools\msvc 等，setup-toolchain.ps1 产物）
# 优先；没有则用系统级 VS BuildTools / Rust / protoc（2026-11-06 起支持，
# 便携目录随 11-02 事故丢失后系统兜底成为常态路径）。两者都无才报错。

$ErrorActionPreference = 'Stop'
$toolsDir = $PSScriptRoot

# ---- MSVC / WinSDK：便携（PortableBuildTools 布局）优先，系统 VS 兜底 ----
$msvcRoot = Join-Path $toolsDir 'msvc'
$msvcVer = Get-ChildItem (Join-Path $msvcRoot 'VC\Tools\MSVC') -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
if ($msvcVer) {
    $sdkRoot = Join-Path $msvcRoot 'Windows Kits\10'
    $toolchainKind = 'portable'
} else {
    # 系统 VS BuildTools（vswhere 定位安装根，MSVC/WinSDK 版本目录动态发现）
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path $vswhere)) { throw "仓内无便携 MSVC 且找不到 vswhere —— 跑 pwsh -File tools\setup-toolchain.ps1 或安装 VS BuildTools" }
    $installPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $installPath) { throw "vswhere 未找到含 C++ 工具链的 VS 安装 —— 跑 setup-toolchain.ps1 或装 VS BuildTools C++ workload" }
    $msvcVer = Get-ChildItem (Join-Path $installPath 'VC\Tools\MSVC') -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1
    if (-not $msvcVer) { throw "VS 安装（$installPath）下没有 MSVC 工具链" }
    $sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10'
    $toolchainKind = "system VS ($($installPath))"
}
$sdkVer = Get-ChildItem (Join-Path $sdkRoot 'Include') -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
if (-not $sdkVer) { throw "未找到 Windows SDK（Include 根：$sdkRoot）" }

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

# ---- Rust：仓内重定向 CARGO_HOME 优先，系统默认（~/.cargo）兜底 ----
$cargoHome = Join-Path $toolsDir 'cargo'
if (Test-Path (Join-Path $cargoHome 'bin')) {
    $env:CARGO_HOME = $cargoHome
    $env:RUSTUP_HOME = Join-Path $toolsDir 'rustup'
    $env:PATH = "$(Join-Path $env:CARGO_HOME 'bin');$env:PATH"
    $rustKind = "portable ($env:CARGO_HOME)"
} else {
    $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
    $rustKind = "system (~/.cargo)"
}

# ---- protoc（会话注入，不设永久变量）：仓内优先，系统安装兜底 ----
$protocLocal = Join-Path $toolsDir 'protoc\bin\protoc.exe'
if (Test-Path $protocLocal) {
    $env:PROTOC = $protocLocal
} else {
    $env:PROTOC = Join-Path $env:LOCALAPPDATA 'Programs\protoc\bin\protoc.exe'
    if (-not (Test-Path $env:PROTOC)) { throw "未找到 protoc（仓内与 %LOCALAPPDATA%\Programs\protoc 都没有）" }
}
$env:PATH = "$(Split-Path $env:PROTOC -Parent);$env:PATH"

Write-Host "已注入构建环境："
Write-Host "  MSVC $($msvcVer.Name) + WinSDK $($sdkVer.Name)  [$toolchainKind]"
Write-Host "  Rust [$rustKind]"
Write-Host "  PROTOC=$env:PROTOC"
& cl 2>&1 | Select-Object -First 1
& rustc --version
& protoc --version
