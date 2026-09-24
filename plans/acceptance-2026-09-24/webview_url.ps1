$p = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'"
"total webview2 procs: $($p.Count)"
$p | Select-Object ProcessId, ParentProcessId | Format-Table
$llm = Get-CimInstance Win32_Process -Filter "Name='llm-wiki.exe'"
"llm-wiki pid: $($llm.ProcessId)"
