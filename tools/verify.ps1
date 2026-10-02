# verify.ps1 —— §4.4 底座层验收：
#     pwsh -File tools\verify.ps1
# ① media 三例：png（200 + SHA256 == 磁盘文件）、jpg（200）、不存在路径（404）
# ② 既有端点回归：/health、/files/content、/graph

$ErrorActionPreference = 'Stop'
# curl.exe 输出 UTF-8 字节，PowerShell 管道按 [Console]::OutputEncoding 解码；
# 不设的话中文项目名变乱码，ConvertFrom-Json 直接失败
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$base = 'http://127.0.0.1:19828/api/v1'
$failures = @()

function Assert-True($cond, $label, $detail = '') {
    if ($cond) {
        Write-Host "  PASS  $label" -ForegroundColor Green
    } else {
        Write-Host "  FAIL  $label  $detail" -ForegroundColor Red
        $script:failures += $label
    }
}

# ---- 定位项目与真实媒体文件 ----
$projectsRaw = curl.exe --noproxy '*' -s "$base/projects" | ConvertFrom-Json
$projects = if ($projectsRaw.projects) { $projectsRaw.projects } else { $projectsRaw }
$project = @($projects | Where-Object { $_.current })[0]
if (-not $project) { $project = @($projects)[0] }
if (-not $project) { throw 'GET /projects 未返回任何项目' }
$projId = [uri]::EscapeDataString($project.id)
$mediaRoot = Join-Path $project.path 'wiki\media'
Write-Host "项目：$($project.name)（$($project.path)）"

$png = [System.IO.Directory]::EnumerateFiles($mediaRoot, '*.png', 'AllDirectories') | Select-Object -First 1
$jpg = [System.IO.Directory]::EnumerateFiles($mediaRoot, '*.jpg', 'AllDirectories') | Select-Object -First 1
if (-not $png) { throw "media 根下没找到 png：$mediaRoot" }
$pngRel = $png.Substring($project.path.Length + 1).Replace('\', '/')
$jpgRel = if ($jpg) { $jpg.Substring($project.path.Length + 1).Replace('\', '/') } else { $null }

# ---- ① media 三例 ----
$tmp = Join-Path $env:TEMP "llm-wiki-verify-$PID.bin"

Write-Host "`n[1] png：$pngRel"
$out = curl.exe --noproxy '*' -s -o $tmp -w "%{http_code}`t%{content_type}" "$base/projects/$projId/media?path=$([uri]::EscapeDataString($pngRel))"
$code, $ctype = $out -split "`t"
Assert-True ($code -eq '200') 'png 返回 200' "实际 $code"
Assert-True ($ctype -like 'image/png*') 'png Content-Type image/png' "实际 $ctype"
$diskHash = (Get-FileHash -Algorithm SHA256 $png).Hash
$wireHash = (Get-FileHash -Algorithm SHA256 $tmp).Hash
Assert-True ($diskHash -eq $wireHash) 'png 字节 SHA256 与磁盘一致' "disk=$diskHash wire=$wireHash"

if ($jpgRel) {
    Write-Host "`n[2] jpg：$jpgRel"
    $out = curl.exe --noproxy '*' -s -o $tmp -w "%{http_code}`t%{content_type}" "$base/projects/$projId/media?path=$([uri]::EscapeDataString($jpgRel))"
    $code, $ctype = $out -split "`t"
    Assert-True ($code -eq '200') 'jpg 返回 200' "实际 $code"
    Assert-True ($ctype -like 'image/jpeg*') 'jpg Content-Type image/jpeg' "实际 $ctype"
} else {
    Write-Host '`n[2] 库内无 jpg，跳过 jpg 例'
}

Write-Host "`n[3] 不存在路径"
$out = curl.exe --noproxy '*' -s -o NUL -w "%{http_code}" "$base/projects/$projId/media?path=wiki%2Fmedia%2F__absent__%2Fnope.png"
Assert-True ($out -eq '404') '缺失文件返回 404' "实际 $out"

# ---- ② 既有端点回归 ----
Write-Host "`n[回归] /health"
$out = curl.exe --noproxy '*' -s -o NUL -w "%{http_code}" 'http://127.0.0.1:19828/health'
Assert-True ($out -eq '200') '/health 200' "实际 $out"

Write-Host "`n[回归] /files/content（文本页）"
$md = [System.IO.Directory]::EnumerateFiles((Join-Path $project.path 'wiki'), '*.md', 'AllDirectories') |
    Where-Object { $_ -notmatch '\\media\\' } | Select-Object -First 1
$mdRel = $md.Substring($project.path.Length + 1).Replace('\', '/')
$out = curl.exe --noproxy '*' -s -o NUL -w "%{http_code}" "$base/projects/$projId/files/content?path=$([uri]::EscapeDataString($mdRel))"
Assert-True ($out -eq '200') '/files/content 200' "实际 $out（$mdRel）"

Write-Host "`n[回归] /graph"
$out = curl.exe --noproxy '*' -s -o NUL -w "%{http_code}" "$base/projects/$projId/graph?limit=1"
Assert-True ($out -eq '200') '/graph 200' "实际 $out"

Remove-Item $tmp -ErrorAction SilentlyContinue
Write-Host ''
if ($failures.Count) { throw "验收未通过（$($failures.Count) 项 FAIL）" }
Write-Host '验收全部通过 ✓' -ForegroundColor Green
