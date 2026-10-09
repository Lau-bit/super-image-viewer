<#
.SYNOPSIS
  Passive mouse-position + click recorder that attaches to Super Image Viewer's main window.

.DESCRIPTION
  Built to catch "clicking the top-right corner closes the app while the bars are hidden".
  READ-ONLY: it never moves the cursor, clicks, or sends input. It polls the cursor and mouse
  buttons (~8 ms), asks Windows what is under each click (WindowFromPoint + WM_NCHITTEST, the
  same question Windows asks when routing a real click), and listens to WinEvents from the app's
  own windows (move/size loops, mouse capture, menus, windows/tooltips shown or destroyed).

  Logged:
    ATTACH / window state changes (rect, visible, minimized, maximized)
    move   — every cursor position inside the top-right corner zone (CornerZone px square)
    LEFT/RIGHT/MIDDLE DOWN|UP — anywhere over or near the app, with the window under the cursor
             (APP / VIEWER / other) and its hit-test (CLIENT, TOP, TOPRIGHT, CLOSE, ...)
    EVT    — WinEvents from the app's process
    on close: WINDOW DESTROYED, the last 3 s of cursor trail, and the process exit code

  Coordinates are physical screen pixels; "r=" is how far left of the window's right content
  edge, "t=" how far below its top content edge (negative = outside the content, on the frame).

  With -CdpPort, click-recorder-page.mjs also hooks the page (clicks that reach the DOM, and
  any windowClose/window.close call with its stack) into <Log>.page.log.

.EXAMPLE
  pwsh tools\click-recorder.ps1                       # 30 min, log in tools\recordings\
  pwsh tools\click-recorder.ps1 -Minutes 60 -CdpPort 9549
#>
param(
  [string]$Title = 'Super Image Viewer',
  [string]$ExeName = 'super-image-viewer',
  [int]$Minutes = 30,
  [int]$CornerZone = 250,
  [int]$CdpPort = 0,
  [string]$Log
)

if (-not $Log) {
  $dir = Join-Path $PSScriptRoot 'recordings'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $Log = Join-Path $dir ("click-recording-{0}.log" -f (Get-Date).ToString('yyyyMMdd-HHmmss', [cultureinfo]::InvariantCulture))
}

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class ClickRecorder {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public POINT pt; }
  delegate bool EnumProc(IntPtr h, IntPtr l);
  delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeoutW(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc cb, uint pid, uint tid, uint flags);
  [DllImport("user32.dll")] static extern int GetMessageW(out MSG m, IntPtr h, uint min, uint max);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref MSG m);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder s, ref uint n);

  static StreamWriter writer;
  static readonly object gate = new object();
  static volatile uint appPid;
  static IntPtr mainHwnd = IntPtr.Zero;
  static WinEventProc eventCallback;   // kept alive for the hook's lifetime

  static string Now() { return DateTime.Now.ToString("HH:mm:ss.fff", CultureInfo.InvariantCulture); }
  public static void Log(string s) {
    lock (gate) { string line = Now() + " " + s; writer.WriteLine(line); writer.Flush(); Console.WriteLine(line); }
  }
  static string Cls(IntPtr h) { var sb = new StringBuilder(256); GetClassNameW(h, sb, 256); return sb.ToString(); }
  static string Txt(IntPtr h) { var sb = new StringBuilder(256); GetWindowTextW(h, sb, 256); return sb.ToString(); }
  static string Hex(IntPtr h) { return "0x" + h.ToInt64().ToString("X"); }

  static string HitName(long v) {
    switch (v) {
      case -2: return "ERROR"; case -1: return "TRANSPARENT"; case 0: return "NOWHERE"; case 1: return "CLIENT";
      case 2: return "CAPTION"; case 3: return "SYSMENU"; case 4: return "GROWBOX"; case 5: return "MENU";
      case 8: return "MINBUTTON"; case 9: return "MAXBUTTON"; case 10: return "LEFT"; case 11: return "RIGHT";
      case 12: return "TOP"; case 13: return "TOPLEFT"; case 14: return "TOPRIGHT"; case 15: return "BOTTOM";
      case 16: return "BOTTOMLEFT"; case 17: return "BOTTOMRIGHT"; case 18: return "BORDER"; case 20: return "CLOSE";
      case 21: return "HELP"; default: return v.ToString();
    }
  }
  static long Hit(IntPtr h, POINT p) {
    IntPtr r; long lp = ((long)(ushort)(short)p.Y << 16) | (long)(ushort)(short)p.X;
    if (SendMessageTimeoutW(h, 0x0084, IntPtr.Zero, new IntPtr(lp), 2, 200, out r) == IntPtr.Zero) return -999;
    return r.ToInt64();
  }

  static string ImageName(uint pid) {
    IntPtr h = OpenProcess(0x1000, false, pid);
    if (h == IntPtr.Zero) return "";
    var sb = new StringBuilder(1024); uint n = 1024;
    string name = QueryFullProcessImageNameW(h, 0, sb, ref n) ? Path.GetFileNameWithoutExtension(sb.ToString()) : "";
    CloseHandle(h);
    return name;
  }
  // Exact title AND the owning process's image name: a title alone also matches editor tabs.
  static IntPtr FindApp(string title, string exe, out uint pid) {
    IntPtr found = IntPtr.Zero; uint foundPid = 0;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || Txt(h) != title) return true;
      uint p; GetWindowThreadProcessId(h, out p);
      if (!string.Equals(ImageName(p), exe, StringComparison.OrdinalIgnoreCase)) return true;
      found = h; foundPid = p; return false;
    }, IntPtr.Zero);
    pid = foundPid; return found;
  }

  static string State(IntPtr h) {
    RECT r; GetWindowRect(h, out r);
    return string.Format("rect=({0},{1})-({2},{3}) visible={4} minimized={5} maximized={6}", r.L, r.T, r.R, r.B, IsWindowVisible(h), IsIconic(h), IsZoomed(h));
  }

  // What a click at p would land on: window under the cursor, whose it is, and its hit-test.
  static string Where(POINT p, int relR, int relT, bool withHit) {
    IntPtr under = WindowFromPoint(p);
    IntPtr root = GetAncestor(under, 2);
    uint pid; GetWindowThreadProcessId(root, out pid);
    string owner = root == mainHwnd ? "APP" : (pid == appPid ? "APP-" + (Txt(root) == "Image" ? "VIEWER" : "WINDOW '" + Txt(root) + "'") : "other '" + Txt(root) + "'");
    string s = string.Format("({0},{1}) r={2} t={3} over [{4}] {5}", p.X, p.Y, relR, relT, Cls(under), owner);
    if (withHit) {
      long hit = Hit(under, p);
      s += " hit=" + HitName(hit);
      if (hit == -1 && root != under) s += " root-hit=" + HitName(Hit(root, p));
    }
    return s;
  }

  static string EventName(uint e) {
    switch (e) {
      case 0x0003: return "FOREGROUND"; case 0x0004: return "MENUSTART"; case 0x0005: return "MENUEND";
      case 0x0006: return "MENUPOPUPSTART"; case 0x0007: return "MENUPOPUPEND"; case 0x0008: return "CAPTURESTART";
      case 0x0009: return "CAPTUREEND"; case 0x000A: return "MOVESIZESTART"; case 0x000B: return "MOVESIZEEND";
      case 0x0010: return "DIALOGSTART"; case 0x0011: return "DIALOGEND"; case 0x0016: return "MINIMIZESTART";
      case 0x0017: return "MINIMIZEEND"; case 0x8000: return "OBJ_CREATE"; case 0x8001: return "OBJ_DESTROY";
      case 0x8002: return "OBJ_SHOW"; case 0x8003: return "OBJ_HIDE"; case 0x8005: return "OBJ_FOCUS";
      case 0x800A: return "OBJ_STATECHANGE"; case 0x800C: return "OBJ_NAMECHANGE";
      default: return "0x" + e.ToString("X4");
    }
  }

  static void OnEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
    try {
      if (appPid == 0 || hwnd == IntPtr.Zero || idObject == -9 /* OBJID_CURSOR */) return;
      // Location changes and z-order churn: the window rect is polled already.
      if (ev == 0x800B || ev == 0x8004) return;
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      if (pid != appPid) return;
      // Focus/state/name churn inside the page is not interesting; titlebar (-2) and window (0) objects are.
      if ((ev == 0x8005 || ev == 0x800A || ev == 0x800C) && idObject != 0 && idObject != -2) return;
      string who = hwnd == mainHwnd ? "MAIN" : (Txt(GetAncestor(hwnd, 2)) == "Image" ? "VIEWER" : "");
      Log(string.Format("EVT {0} {1} [{2}] '{3}' {4} obj={5} child={6}", EventName(ev), Hex(hwnd), Cls(hwnd), Txt(hwnd), who, idObject, idChild));
    } catch { }
  }

  static void HookLoop() {
    eventCallback = OnEvent;
    // System events (foreground, menus, capture, move/size, minimize) and object
    // create/destroy/show/hide/focus/state/name. Location changes are dropped in OnEvent.
    SetWinEventHook(0x0001, 0x0017, IntPtr.Zero, eventCallback, 0, 0, 0x0002);
    SetWinEventHook(0x8000, 0x800C, IntPtr.Zero, eventCallback, 0, 0, 0x0002);
    MSG m;
    while (GetMessageW(out m, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref m); DispatchMessageW(ref m); }
  }

  public static void Run(string logPath, string title, string exe, int minutes, int cornerZone) {
    var fs = new FileStream(logPath, FileMode.Append, FileAccess.Write, FileShare.Read);
    writer = new StreamWriter(fs, new UTF8Encoding(false));
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    Log("click recorder started (" + minutes + " min); waiting for '" + title + "' (" + exe + ".exe)");
    new Thread(HookLoop) { IsBackground = true }.Start();

    var trail = new Queue<KeyValuePair<DateTime, string>>();
    int[] vks = { 1, 2, 4 }; string[] names = { "LEFT", "RIGHT", "MIDDLE" };
    bool[] wasDown = new bool[3];
    POINT last = new POINT { X = int.MinValue, Y = int.MinValue };
    string lastState = null;
    IntPtr proc = IntPtr.Zero;
    DateTime end = DateTime.Now.AddMinutes(minutes);

    while (DateTime.Now < end) {
      if (mainHwnd == IntPtr.Zero) {
        uint pid; IntPtr h = FindApp(title, exe, out pid);
        if (h == IntPtr.Zero) { Thread.Sleep(250); continue; }
        mainHwnd = h; appPid = pid;
        proc = OpenProcess(0x1000 | 0x00100000, false, pid);   // QUERY_LIMITED_INFORMATION | SYNCHRONIZE
        lastState = State(h);
        Log("ATTACH pid=" + pid + " hwnd=" + Hex(h) + " " + lastState);
      }

      POINT p; GetCursorPos(out p);
      bool alive = IsWindow(mainHwnd);
      RECT wr = new RECT(); RECT cr = new RECT(); POINT o = new POINT();
      if (alive) { GetWindowRect(mainHwnd, out wr); GetClientRect(mainHwnd, out cr); ClientToScreen(mainHwnd, ref o); }
      int relR = (o.X + cr.R - 1) - p.X;   // px left of the content's right edge
      int relT = p.Y - o.Y;                // px below the content's top edge
      bool near = alive && p.X >= wr.L - 40 && p.X <= wr.R + 40 && p.Y >= wr.T - 40 && p.Y <= wr.B + 40;
      bool inCorner = alive && relR >= -15 && relR <= cornerZone && relT >= -15 && relT <= cornerZone;
      bool moved = p.X != last.X || p.Y != last.Y;

      // Buttons first: the click that kills the window must be recorded before we notice it died.
      for (int i = 0; i < 3; i++) {
        bool down = (GetAsyncKeyState(vks[i]) & 0x8000) != 0;
        if (down == wasDown[i]) continue;
        wasDown[i] = down;
        string w = Where(p, relR, relT, down);
        trail.Enqueue(new KeyValuePair<DateTime, string>(DateTime.Now, names[i] + (down ? " DOWN " : " UP ") + w));
        if (near || inCorner) Log(names[i] + (down ? " DOWN " : " UP   ") + w);
      }
      if (moved) {
        string pos = string.Format("({0},{1}) r={2} t={3}", p.X, p.Y, relR, relT);
        trail.Enqueue(new KeyValuePair<DateTime, string>(DateTime.Now, "pos " + pos));
        if (inCorner) Log("move " + Where(p, relR, relT, false));
        last = p;
      }
      while (trail.Count > 0 && (DateTime.Now - trail.Peek().Key).TotalMilliseconds > 3000) trail.Dequeue();

      if (!alive) {
        Log("WINDOW DESTROYED — last 3 s of cursor trail follows");
        foreach (var e in trail) Log("   trail " + e.Key.ToString("HH:mm:ss.fff", CultureInfo.InvariantCulture) + " " + e.Value);
        if (proc != IntPtr.Zero) {
          WaitForSingleObject(proc, 5000);
          uint code;
          if (GetExitCodeProcess(proc, out code)) Log(code == 259 ? "process still running after 5 s" : "PROCESS EXITED code=0x" + code.ToString("X8") + " (" + (int)code + ")");
          CloseHandle(proc); proc = IntPtr.Zero;
        }
        mainHwnd = IntPtr.Zero; appPid = 0;
        Log("waiting for the app to come back...");
        continue;
      }
      string st = State(mainHwnd);
      if (st != lastState) { Log("window " + st); lastState = st; }
      Thread.Sleep(8);
    }
    Log("click recorder finished");
  }
}
"@

$pageProc = $null
if ($CdpPort -gt 0) {
  $pageScript = Join-Path $PSScriptRoot 'click-recorder-page.mjs'
  $pageProc = Start-Process node -ArgumentList $pageScript, $CdpPort, "$Log.page.log", $Minutes -WindowStyle Hidden -PassThru
}
Write-Host "Recording to: $Log"
try { [ClickRecorder]::Run($Log, $Title, $ExeName, $Minutes, $CornerZone) }
finally { if ($pageProc -and -not $pageProc.HasExited) { Stop-Process -Id $pageProc.Id -ErrorAction SilentlyContinue } }
