// EraButtons.cs - the device button listener (button press to ask, design
// 2026-10-27 section 4.1; plan T5.1).
//
// A partner's button reaches Windows as a key: a Flic in keyboard mode sends
// F13 (click) or F14 (hold), the I-13's Square button sends Ctrl+Alt+F9, and
// Ctrl+Alt+F10/F11 are the fallback pair for a Flic app that cannot send
// F13/F14. This program holds those five as global hotkeys (RegisterHotKey on
// a message-only window, so it hears them whatever window is in front) and
// turns each into one loopback request to the hub:
//
//   POST http://127.0.0.1:<port>/buttons/press  {"key":"F13","action":"ask"}
//
// The hub decides what a press does (buttons.js). This program only listens.
//
//   EraButtons.exe <port> <hub pid>
//
// At start it prints ONE line on stdout, {"registered":[...],"failed":[...]},
// which the hub's keeper reads into /status.buttons.keys. One instance per
// desktop session (named mutex; a second waits 5 s, then exits 3), and it
// exits by itself within 2 s once the hub that started it is gone.
// No visible window, no tray icon, no files written, no other program started.
// The hub compiles it on the device with Windows' own .NET Framework csc
// (C# 5: no string interpolation, no expression-bodied members):
//   csc /nologo /target:winexe /platform:x64 /r:System.Windows.Forms.dll
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class EraButtons
{
    const int WM_HOTKEY = 0x0312;
    const uint MOD_ALT = 0x0001;
    const uint MOD_CONTROL = 0x0002;
    const uint MOD_NOREPEAT = 0x4000;
    const uint VK_F9 = 0x78;
    const uint VK_F10 = 0x79;
    const uint VK_F11 = 0x7A;
    const uint VK_F13 = 0x7C;
    const uint VK_F14 = 0x7D;

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll")]
    static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    // Hotkey ids 1-5, in this order. The names and actions are the hub's KEYS
    // table (buttons.js); tests/buttons-payload.test.mjs keeps the two equal.
    static readonly int[] Ids = { 1, 2, 3, 4, 5 };
    static readonly string[] Names = { "F13", "F14", "Ctrl+Alt+F9", "Ctrl+Alt+F10", "Ctrl+Alt+F11" };
    static readonly string[] Actions = { "ask", "cancel", "ask", "ask", "cancel" };
    static readonly uint[] Mods = { 0, 0, MOD_CONTROL | MOD_ALT, MOD_CONTROL | MOD_ALT, MOD_CONTROL | MOD_ALT };
    static readonly uint[] Vks = { VK_F13, VK_F14, VK_F9, VK_F10, VK_F11 };

    static string pressUrl;
    static int hubPid;
    static DateTime hubStart;
    static Mutex single;
    static HotkeyWindow window;
    static System.Windows.Forms.Timer hubWatch;

    // A window that is never shown: HWND_MESSAGE parent, so it receives
    // WM_HOTKEY and nothing else ever sees it.
    sealed class HotkeyWindow : NativeWindow
    {
        public HotkeyWindow()
        {
            CreateParams cp = new CreateParams();
            cp.Parent = new IntPtr(-3);   // HWND_MESSAGE
            CreateHandle(cp);
        }
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_HOTKEY)
            {
                int id = m.WParam.ToInt32();
                for (int i = 0; i < Ids.Length; i++)
                    if (Ids[i] == id) Post(Names[i], Actions[i]);
            }
            base.WndProc(ref m);
        }
    }

    [STAThread]
    static int Main(string[] args)
    {
        int port;
        if (args.Length < 2 || !int.TryParse(args[0], out port) || !int.TryParse(args[1], out hubPid)) return 2;
        try { hubStart = Process.GetProcessById(hubPid).StartTime; }
        catch { return 4; }   // the hub that started us is already gone
        pressUrl = "http://127.0.0.1:" + port + "/buttons/press";
        // No proxy lookup for a loopback request: auto-detection can cost seconds.
        WebRequest.DefaultWebProxy = null;

        single = new Mutex(false, "Local\\OurEraComms.Buttons");
        bool owned;
        try { owned = single.WaitOne(5000); }
        catch (AbandonedMutexException) { owned = true; }   // its last owner died holding it
        if (!owned) return 3;

        window = new HotkeyWindow();
        List<string> registered = new List<string>();
        List<string> failed = new List<string>();
        for (int i = 0; i < Ids.Length; i++)
        {
            if (RegisterHotKey(window.Handle, Ids[i], Mods[i] | MOD_NOREPEAT, Vks[i])) registered.Add(Names[i]);
            else failed.Add(Names[i]);   // another program already holds this key
        }
        Console.Out.WriteLine("{\"registered\":" + JsonList(registered) + ",\"failed\":" + JsonList(failed) + "}");
        Console.Out.Flush();

        hubWatch = new System.Windows.Forms.Timer();
        hubWatch.Interval = 2000;
        hubWatch.Tick += delegate { if (!HubAlive()) Quit(); };
        hubWatch.Start();
        Application.Run();
        return 0;
    }

    static bool HubAlive()
    {
        try
        {
            Process p = Process.GetProcessById(hubPid);
            // a reused pid is another process: its start time differs
            return !p.HasExited && p.StartTime == hubStart;
        }
        catch { return false; }
    }

    static void Quit()
    {
        hubWatch.Stop();
        for (int i = 0; i < Ids.Length; i++) UnregisterHotKey(window.Handle, Ids[i]);
        window.DestroyHandle();
        try { single.ReleaseMutex(); } catch { }
        Application.ExitThread();
    }

    // Fire and forget, off the message loop: a slow or absent hub never holds
    // up the next key. 2 s timeout; any answer (or none) is ignored here.
    static void Post(string key, string action)
    {
        string json = "{\"key\":\"" + key + "\",\"action\":\"" + action + "\"}";
        ThreadPool.QueueUserWorkItem(delegate
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(pressUrl);
                req.Method = "POST";
                req.ContentType = "application/json";
                req.Proxy = null;
                req.Timeout = 2000;
                req.ReadWriteTimeout = 2000;
                req.KeepAlive = false;
                byte[] body = Encoding.UTF8.GetBytes(json);
                req.ContentLength = body.Length;
                using (System.IO.Stream s = req.GetRequestStream()) s.Write(body, 0, body.Length);
                using (WebResponse r = req.GetResponse()) { }
            }
            catch { }   // 409 (Chat off) and 400 arrive as exceptions too: the hub has logged them
        });
    }

    static string JsonList(List<string> items)
    {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < items.Count; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append('"').Append(items[i]).Append('"');
        }
        return sb.Append(']').ToString();
    }
}
