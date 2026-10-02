# setup-toolchain.ps1 —— 一次性获取便携工具链（幂等，重复跑只补缺）
# 依据 plans/2026-09-30-media-endpoint.md §4.1：全部住 <repo>/tools/，零系统残留。
# 用法：pwsh -File tools\setup-toolchain.ps1
# 网络备选：GitHub 直连失败时先 $env:HTTPS_PROXY="http://127.0.0.1:7890" 再跑本脚本。

$ErrorActionPreference = 'Stop'
$toolsDir = $PSScriptRoot
$downloads = Join-Path $toolsDir 'downloads'
New-Item -ItemType Directory -Force -Path $downloads | Out-Null

function Get-Url([string]$url, [string]$outFile, [string[]]$fallbacks = @()) {
    if (Test-Path $outFile) { return }
    $candidates = @($url) + $fallbacks
    foreach ($u in $candidates) {
        try {
            Write-Host "下载 $u"
            Invoke-WebRequest -Uri $u -OutFile $outFile -UseBasicParsing
            return
        } catch {
            Write-Warning "失败：$u —— $($_.Exception.Message)"
        }
    }
    throw "全部下载源失败：$url"
}

# ---------- 1. MSVC + WinSDK（PortableBuildTools，免 VS 安装器/注册表） ----------
# CLI 见 https://github.com/Data-Oriented-House/PortableBuildTools source/pbt.c：
#   accept_license target=x64 host=x64 path=<dir>   （env 默认 none，不写系统 PATH）
# 布局：<dir>\VC\Tools\MSVC\<ver>\bin\Hostx64\x64\cl.exe
#       <dir>\Windows Kits\10\Include\<sdkver>\{ucrt,um,shared,winrt,cppwinrt}
$msvcDir = Join-Path $toolsDir 'msvc'
if (Test-Path (Join-Path $msvcDir 'VC\Tools\MSVC')) {
    Write-Host '[跳过] MSVC 已存在'
} else {
    $pbt = Join-Path $downloads 'PortableBuildTools.exe'
    Get-Url 'https://github.com/Data-Oriented-House/PortableBuildTools/releases/latest/download/PortableBuildTools.exe' $pbt
    Write-Host '安装 MSVC v143 + WinSDK（约 1-2 GB，几分钟）…'
    & $pbt accept_license target=x64 host=x64 path="$msvcDir"
    if ($LASTEXITCODE -ne 0) { throw "PortableBuildTools 退出码 $LASTEXITCODE" }
}

# ---------- 2. Rust（rustup 重定向 CARGO_HOME/RUSTUP_HOME，不落 ~/.cargo） ----------
$cargoHome = Join-Path $toolsDir 'cargo'
$rustupHome = Join-Path $toolsDir 'rustup'
if (Test-Path (Join-Path $cargoHome 'bin\cargo.exe')) {
    Write-Host '[跳过] Rust 已存在'
} else {
    $rustupInit = Join-Path $downloads 'rustup-init.exe'
    Get-Url 'https://win.rustup.rs/x86_64' $rustupInit @(
        'https://mirrors.tuna.tsinghua.edu.cn/rustup/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe'
    )
    $env:CARGO_HOME = $cargoHome
    $env:RUSTUP_HOME = $rustupHome
    # 官方源失败时改用清华镜像重装（首次下载工具链约 700MB）
    & $rustupInit -y --profile minimal --default-toolchain stable-x86_64-pc-windows-msvc --no-modify-path
    if ($LASTEXITCODE -ne 0) {
        Write-Host '官方源失败，切清华镜像重试…'
        $env:RUSTUP_DIST_SERVER = 'https://mirrors.tuna.tsinghua.edu.cn/rustup'
        $env:RUSTUP_UPDATE_ROOT = 'https://mirrors.tuna.tsinghua.edu.cn/rustup/rustup'
        & $rustupInit -y --profile minimal --default-toolchain stable-x86_64-pc-windows-msvc --no-modify-path
        if ($LASTEXITCODE -ne 0) { throw "rustup 安装失败（退出码 $LASTEXITCODE）" }
    }
}

# crates.io 清华 sparse 镜像（随 CARGO_HOME 生效）
$cargoConfig = Join-Path $cargoHome 'config.toml'
if (-not (Test-Path $cargoConfig)) {
    @'
[source.crates-io]
replace-with = 'mirror'

[source.mirror]
registry = "sparse+https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/"
'@ | Set-Content -Path $cargoConfig -Encoding UTF8 -NoNewline
    Write-Host "已写 $cargoConfig"
}

# ---------- 3. protoc（便携 zip，与 Yang 机同版本 29.3） ----------
$protocDir = Join-Path $toolsDir 'protoc'
if (Test-Path (Join-Path $protocDir 'bin\protoc.exe')) {
    Write-Host '[跳过] protoc 已存在'
} else {
    $protocZip = Join-Path $downloads 'protoc-29.3-win64.zip'
    Get-Url 'https://github.com/protocolbuffers/protobuf/releases/download/v29.3/protoc-29.3-win64.zip' $protocZip
    Expand-Archive -Path $protocZip -DestinationPath $protocDir -Force
}

Write-Host ''
Write-Host '工具链就绪。构建终端内执行：. .\tools\build-env.ps1'
