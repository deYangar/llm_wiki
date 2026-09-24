param([string]$OutPath, [int]$TargetPid)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win32Enum {
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$found = [IntPtr]::Zero
$cb = [Win32Enum+EnumProc]{ param($h, $l)
    $pid2 = 0
    [Win32Enum]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
    if ($pid2 -eq $TargetPid -and [Win32Enum]::IsWindowVisible($h)) {
        $r = New-Object Win32Enum+RECT
        [Win32Enum]::GetWindowRect($h, [ref]$r) | Out-Null
        if (($r.Right - $r.Left) -gt 200 -and ($r.Bottom - $r.Top) -gt 150) { $script:found = $h; return $false }
    }
    return $true
}
[Win32Enum]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
if ($found -eq [IntPtr]::Zero) { "no visible window for pid $TargetPid"; exit 1 }
[Win32Enum]::SetForegroundWindow($found) | Out-Null
Start-Sleep -Milliseconds 900
$r = New-Object Win32Enum+RECT
[Win32Enum]::GetWindowRect($found, [ref]$r) | Out-Null
$w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"saved $OutPath ($w x $ht)"
