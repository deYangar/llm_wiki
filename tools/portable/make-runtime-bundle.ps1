<#
.SYNOPSIS
    llm-wiki 便携运行形态组装器 —— 产出 dist/wiki-runtime-<日期>/
    （供 ipoanswer 侧 tools/bundle.ps1 收录进整合包，自身不压缩）。

.DESCRIPTION
    组件构成：

      llm-wiki.exe        最新构建（含 --minimized / LLM_WIKI_START_MINIMIZED=1
                          服务形态启动参数，2026-10-21 加入）
      pdfium\             exe 旁的 PDF 解析动态库（导入/正文提取依赖）
      mcp-server\         MCP 服务（node，含依赖，~50M）
      bin\fix-state-paths.py
                          启动前部署 app-state（路径改写到实际解压位置 +
                          目标机原设置备份/还原）
      data\app-state.json 模板 —— 取开发机 %APPDATA% 活配置（含 key，勿外传）
      data\wiki\          案例库（md + media 原文页图片 + .llm-wiki 向量库）
      data\知识库\        准则库

    raw/（PDF 原件 + MinerU 解析缓存，案例库 6.7G）默认不带 —— 网站运行
    （问答/检索/图谱/原文页）完全不读 raw；只有目标机要重跑拆题/重解析时
    才需要（-WithRaw 带上）。新增文档的增量导入不受影响（新文档本无缓存）。

    ⚠️ 库是活库：C:\library 正被本机安装版使用。组装时若 19828 在听只警告
    不中止（idle 状态无写入，拷贝安全）；正在跑导入/嵌入时不要组装。
    ⚠️ 本文件须带 UTF-8 BOM（PS 5.1 无 BOM 按 GBK 解码报错）。

    用法（在 llm-wiki 仓根）：
      pwsh -File tools\portable\make-runtime-bundle.ps1
      pwsh -File tools\portable\make-runtime-bundle.ps1 -WithRaw
#>
[CmdletBinding()]
param(
    [string]$OutputDir = 'dist',
    [switch]$WithRaw,
    [string]$Exe = '',

    # 删除已存在的同名产物目录后重建（删除走回收站）
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repoRoot

function Write-Step { param([string]$m) Write-Host "==> $m" }
function Write-Ok   { param([string]$m) Write-Host "  ok  $m" -ForegroundColor Green }
function Write-Info { param([string]$m) Write-Host "      $m" -ForegroundColor DarkGray }
function Die        { param([string]$m) Write-Host "  xx  $m" -ForegroundColor Red; exit 1 }

# robocopy 退出码 0-7 都是成功
function Copy-Tree { param([string]$Src, [string]$Dst, [string[]]$XD = @())
    $rcArgs = @($Src, $Dst, '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:2', '/W:2', '/NFL', '/NDL', '/NP')
    if ($XD.Count) { $rcArgs += @('/XD') + $XD }
    robocopy @rcArgs | Out-Null
    if ($LASTEXITCODE -ge 8) { Die "robocopy 失败（exit $LASTEXITCODE）：$Src -> $Dst" }
}

# ---------------------------------------------------------------- 前置检查
if (-not $Exe) { $Exe = Join-Path $repoRoot 'src-tauri\target\release\llm-wiki.exe' }
if (-not (Test-Path $Exe)) { Die "exe 不存在：$Exe（先跑 tools\build.ps1）" }
$exeTime = (Get-Item $Exe).LastWriteTime
Write-Info "exe 构建时间：$($exeTime.ToString('yyyy-MM-dd HH:mm:ss'))"
if ($exeTime -lt (Get-Date).AddHours(-2)) {
    Die "exe 是 2 小时前的旧构建 —— 本次组装要求带 --minimized 的最新构建。先跑 pwsh -File tools\build.ps1 再来。"
}
$liveState = Join-Path $env:APPDATA 'com.llmwiki.app\app-state.json'
if (-not (Test-Path $liveState)) { Die "开发机活配置不存在：$liveState" }

$c = New-Object Net.Sockets.TcpClient
try { $c.Connect('127.0.0.1', 19828); $wikiRunning = $true } catch { $wikiRunning = $false } finally { $c.Dispose() }
if ($wikiRunning) {
    Write-Warning "本机 llm-wiki（19828）正在运行 —— idle 状态拷贝安全；若正在导入/嵌入请等它跑完再组装。"
}

# ---------------------------------------------------------------- staging
$stamp = Get-Date -Format 'yyyyMMdd'
$staging = Join-Path (Join-Path $repoRoot $OutputDir) "wiki-runtime-$stamp"
if (Test-Path $staging) {
    if ($Force) {
        Add-Type -AssemblyName Microsoft.VisualBasic
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($staging, 'OnlyErrorDialogs', 'SendToRecycleBin')
        Write-Ok "已删除旧产物 $staging（回收站）"
    } else {
        Die "$staging 已存在 —— 失败重跑加 -Force。"
    }
}
New-Item -ItemType Directory -Force -Path (Join-Path $repoRoot $OutputDir), $staging | Out-Null

# ---------------------------------------------------------------- 组装
Write-Step "exe + 原生依赖"
Copy-Item $Exe (Join-Path $staging 'llm-wiki.exe')
Copy-Tree (Join-Path $repoRoot 'pdfium') (Join-Path $staging 'pdfium')
Write-Ok "exe + pdfium 就绪"

Write-Step "mcp-server（node 依赖整体随包）"
Copy-Tree (Join-Path $repoRoot 'mcp-server') (Join-Path $staging 'mcp-server') @('test')
Write-Ok "mcp-server 就绪"

Write-Step "bin\fix-state-paths.py（启动时部署/还原 app-state）"
New-Item -ItemType Directory -Force -Path (Join-Path $staging 'bin') | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'fix-state-paths.py') (Join-Path $staging 'bin\')
Write-Ok "bin 就绪"

Write-Step "data\app-state.json 模板（取开发机活配置）"
New-Item -ItemType Directory -Force -Path (Join-Path $staging 'data') | Out-Null
Copy-Item $liveState (Join-Path $staging 'data\app-state.json')
Write-Ok "模板就绪（含 key —— 整合包勿外传）"

$rawXor = if ($WithRaw) { @() } else { @('raw') }
$rawNote = if ($WithRaw) { '含 raw（-WithRaw：目标机可重跑导入）' } else { '排除 raw（运行不需要；-WithRaw 可带上）' }

Write-Step "案例库 C:\library\wiki（$rawNote）"
Copy-Tree 'C:\library\wiki' (Join-Path $staging 'data\wiki') $rawXor
Write-Ok "案例库就绪"

Write-Step "准则库 C:\library\知识库（$rawNote）"
Copy-Tree 'C:\library\知识库' (Join-Path $staging 'data\知识库') $rawXor
Write-Ok "准则库就绪"

# ---------------------------------------------------------------- 体积报告
Write-Step "产物体积"
$total = 0
foreach ($d in 'pdfium', 'mcp-server', 'data') {
    $sum = (Get-ChildItem (Join-Path $staging $d) -Recurse -File | Measure-Object Length -Sum).Sum
    $total += $sum
    Write-Info ('{0,-12} {1,10:N0} MB' -f $d, ($sum / 1MB))
}
$exeSize = (Get-Item (Join-Path $staging 'llm-wiki.exe')).Length
$total += $exeSize
Write-Info ('{0,-12} {1,10:N0} MB' -f 'exe', ($exeSize / 1MB))
Write-Ok ("合计 {0:N0} MB —— {1}" -f ($total / 1MB), $staging)
Write-Host ""
Write-Host "    下一步：ipoanswer 仓 tools\bundle.ps1 收录本目录组装整合包" -ForegroundColor Cyan
