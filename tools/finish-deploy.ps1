# finish-deploy.ps1 —— 把已验收的修复版 exe 覆盖到安装版路径
#
# 背景（2026-10-02）：最终构建已从 target/release 直接启动并通过全量验收，
# 但安装版路径 C:\Users\Yang\AppData\Local\LLM Wiki\llm-wiki.exe 被游戏
# DeltaForceClient 的反作弊句柄长期锁定（游戏运行期间不释放），覆盖被阻塞。
# 游戏退出后运行本脚本完成收尾：
#     pwsh -File tools\finish-deploy.ps1
#
# 步骤：停当前实例（可能从 target 路径跑）→ 带重试覆盖 exe → 启动安装版
# → /health 与 /media 探针确认。回滚：同目录 llm-wiki.exe.bak-20260930。

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$src = 'C:\Users\Yang\.zcode\workspace\default\projects\llm-wiki\src-tauri\target\release\llm-wiki.exe'
$dst = 'C:\Users\Yang\AppData\Local\LLM Wiki\llm-wiki.exe'
$workDir = 'C:\Users\Yang\AppData\Local\LLM Wiki'

# 1) 停现有实例（安装版路径或 target 路径启动的都算）
Get-CimInstance Win32_Process -Filter "Name='llm-wiki.exe'" |
    Invoke-CimMethod -MethodName Terminate | Out-Null
Start-Sleep -Seconds 5

# 2) 覆盖（反作弊句柄若仍持有则重试；确认游戏已退出再跑更稳）
$copied = $false
foreach ($i in 1..12) {
    try {
        Copy-Item $src $dst -Force
        $copied = $true
        break
    } catch {
        Write-Host "attempt ${i}: 文件仍被锁定，30 秒后重试（游戏还在跑？）"
        Start-Sleep -Seconds 30
    }
}
if (-not $copied) { throw '覆盖失败：llm-wiki.exe 长时间被锁。确认三角洲行动已退出后重跑。' }
Write-Host '已覆盖安装版 exe'

# 3) 启动 + 探针
Start-Process -FilePath $dst -WorkingDirectory $workDir
Start-Sleep -Seconds 12
$h = curl.exe --noproxy '*' -s -o NUL -w "%{http_code}" 'http://127.0.0.1:19828/health'
if ($h -ne '200') { throw "health 异常：$h" }
Write-Host 'health 200 ✓'

$probe = @'
import urllib.request, urllib.parse
path = 'wiki/media/16-scheduled-import--2-问答--4-2025--3-上交所--3-ipo--2-主板--2-注册--3-嘉德利--24-8-1-发行人及中介机构关于首轮审核问询函的回复--10gl9or/img-1.png'
url = 'http://127.0.0.1:19828/api/v1/projects/283b69c0-157e-47a8-b1e3-f476d0735a7c/media?path=' + urllib.parse.quote(path, safe='')
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
r = opener.open(url)
print(r.status, r.headers.get('Content-Type'), len(r.read()))
'@
$probe | python -
Write-Host '部署收尾完成（期望输出：200 image/png 8290）'
