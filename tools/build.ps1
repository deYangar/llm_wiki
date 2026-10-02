# build.ps1 —— §4.2 构建（在 repo 根目录跑）：
#     pwsh -File tools\build.ps1
# 产出：src-tauri\target\release\llm-wiki.exe（必须经 tauri build，
# 裸 cargo build --release 的 exe 会连 devUrl:1420 显示「localhost 拒绝连接」）。

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)   # repo 根
. (Join-Path $PSScriptRoot 'build-env.ps1')

Write-Host '== npm install =='
npm install
if ($LASTEXITCODE -ne 0) { throw 'npm install 失败' }

Write-Host '== vite 前端构建（cargo 编 lib 的前置） =='
npm run build
if ($LASTEXITCODE -ne 0) { throw 'npm run build 失败' }

Write-Host '== tauri build --no-bundle（约 12 分钟） =='
npx tauri build --no-bundle
if ($LASTEXITCODE -ne 0) { throw 'tauri build 失败' }

$exe = 'src-tauri\target\release\llm-wiki.exe'
if (-not (Test-Path $exe)) { throw "未找到产物 $exe" }
Write-Host ''
Write-Host "构建完成：$((Resolve-Path $exe).Path)"
Write-Host '下一步：pwsh -File tools\deploy.ps1'
