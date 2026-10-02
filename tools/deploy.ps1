# deploy.ps1 —— §4.3 部署安装版（备份 → 停旧 → 覆盖 → 启动 → 防双实例）：
#     pwsh -File tools\deploy.ps1
# 回滚：把 $target.bak-20260930 复制回 $target 后重启（§4.5）。

$ErrorActionPreference = 'Stop'
$target = 'C:\Users\guaji\AppData\Local\LLM Wiki\llm-wiki.exe'
$built = Join-Path (Split-Path $PSScriptRoot -Parent) 'src-tauri\target\release\llm-wiki.exe'
$backup = "$target.bak-20260930"

if (-not (Test-Path $built)) { throw "构建产物不存在：$built（先跑 tools\build.ps1）" }
if (-not (Test-Path $target)) { throw "安装版不存在：$target" }

# 1. 备份（只备一次；重复部署不覆盖第一份原始备份）
if (Test-Path $backup) {
    Write-Host "[跳过] 备份已存在：$backup"
} else {
    Copy-Item $target $backup
    Write-Host "已备份 → $backup"
}

# 2. 停旧实例（19828 被占时 exe 无法覆盖；历史坑：安装版会中途拉起抢端口）
$procs = Get-Process llm-wiki -ErrorAction SilentlyContinue
if ($procs) {
    $procs | Stop-Process -Force
    Write-Host "已停旧实例 PID：$($procs.Id -join ', ')"
    Start-Sleep -Seconds 2
}

# 3. 覆盖 + 4. 启动
Copy-Item $built $target -Force
Write-Host "已覆盖 $target"
Start-Process $target
Write-Host '已启动新实例'

# 5. 清点 19828 监听者——端口写死且版本号同为 0.6.11，双实例无法从 health 区分
Start-Sleep -Seconds 5
$listeners = Get-NetTCPConnection -LocalPort 19828 -State Listen -ErrorAction SilentlyContinue
if (-not $listeners) { throw '19828 无监听者——实例未起来，查事件日志/手动启动' }
$owningPids = $listeners | Select-Object -ExpandProperty OwningProcess -Unique
if ($owningPids.Count -gt 1) {
    throw "19828 有 $($owningPids.Count) 个监听者（PID: $($owningPids -join ', ')）——杀多余实例后重验"
}
Write-Host "19828 唯一监听者 PID：$($owningPids[0])"
Write-Host '下一步：pwsh -File tools\verify.ps1'
