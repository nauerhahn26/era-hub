// native-display.exe <width> <height> <result.json> - set the guest's REAL desktop
// mode (no browser emulation) and prove it by Windows' own readback. Shipped and
// compiled in the guest by vm.nativeDisplay() with the .NET Framework csc, run in
// the interactive desktop session (a display change from the ssh session has no
// desktop to change). Why and the contract: native-display.mjs.
// The change is dynamic (flags 0, no CDS_UPDATEREGISTRY): it lasts until the guest
// reboots, which leg B never does after its revert.
// Lessons kept from the Chat/Games private preparation it is derived from (10/26):
// test only modes Windows enumerates; ask for width+height first, because forcing
// the virtual adapter's refresh rate failed CDS_TEST; wake the display before
// running (on a dark one the helper never wrote its result). <result.json>.progress.txt
// records each step so a helper that never returns still says where it stopped.
using System;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
class NativeDisplay {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string deviceName;
    public ushort specVersion, driverVersion, size, driverExtra; public uint fields;
    public int positionX, positionY; public uint orientation, fixedOutput;
    public short color, duplex, yResolution, ttOption, collate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string formName;
    public ushort logPixels; public uint bitsPerPel, pelsWidth, pelsHeight, displayFlags, displayFrequency,
      icmMethod, icmIntent, mediaType, ditherType, reserved1, reserved2, panningWidth, panningHeight;
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettings(string device, int mode, ref DEVMODE dm);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int ChangeDisplaySettings(ref DEVMODE dm, uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  const int ENUM_CURRENT_SETTINGS = -1;
  const uint CDS_TEST = 2;
  // DM_PELSWIDTH|DM_PELSHEIGHT, + DM_BITSPERPEL, + DM_DISPLAYFREQUENCY
  static readonly uint[] MASKS = { 0x00180000u, 0x001c0000u, 0x005c0000u };
  static string progress;
  static void Step(string what) { try { File.AppendAllText(progress, DateTime.UtcNow.ToString("o") + " " + what + Environment.NewLine); } catch {} }
  static DEVMODE Read(int n) {
    var d = new DEVMODE(); d.size = (ushort)Marshal.SizeOf(typeof(DEVMODE));
    if (!EnumDisplaySettings(null, n, ref d)) throw new Exception("EnumDisplaySettings failed for mode " + n);
    return d;
  }
  static object Mode(DEVMODE d) { return new { width = d.pelsWidth, height = d.pelsHeight, bpp = d.bitsPerPel, hz = d.displayFrequency }; }
  static int Main(string[] a) {
    if (a.Length != 3) return 64;
    progress = a[2] + ".progress.txt";
    var result = new Dictionary<string, object>();
    result["ok"] = false;
    int code = 1;
    try {
      uint width = uint.Parse(a[0]), height = uint.Parse(a[1]);
      result["target"] = new { width = width, height = height };
      Step("start " + width + "x" + height);
      SetProcessDPIAware();
      int structSize = Marshal.SizeOf(typeof(DEVMODE)); result["structSize"] = structSize;
      if (structSize != 220) throw new Exception("Unexpected DEVMODEW size " + structSize);
      result["before"] = Mode(Read(ENUM_CURRENT_SETTINGS));
      var modes = new List<DEVMODE>(); var listed = new List<object>();
      for (int i = 0; i < 4096; i++) {
        var d = new DEVMODE(); d.size = (ushort)structSize;
        if (!EnumDisplaySettings(null, i, ref d)) break;
        modes.Add(d); listed.Add(Mode(d));
      }
      result["modes"] = listed;
      Step("enumerated " + modes.Count);
      var attempts = new List<object>(); result["attempts"] = attempts;
      DEVMODE? chosen = null;
      foreach (var m in modes) {
        if (m.pelsWidth != width || m.pelsHeight != height) continue;
        foreach (uint mask in MASKS) {
          var probe = m; probe.size = (ushort)structSize; probe.driverExtra = 0; probe.fields = mask;
          int test = ChangeDisplaySettings(ref probe, CDS_TEST);
          attempts.Add(new { bpp = m.bitsPerPel, hz = m.displayFrequency, fields = mask, testCode = test });
          if (test == 0) { chosen = probe; break; }
        }
        if (chosen != null) break;
      }
      Step("tested " + attempts.Count);
      if (chosen == null) throw new Exception(width + "x" + height + " is not an enumerated mode that passes CDS_TEST; nothing applied");
      var target = chosen.Value;
      int applied = ChangeDisplaySettings(ref target, 0u);
      result["applyCode"] = applied;
      Step("applied " + applied);
      if (applied != 0) throw new Exception("ChangeDisplaySettings failed: " + applied);
      var after = Read(ENUM_CURRENT_SETTINGS);
      for (int i = 0; i < 20 && (after.pelsWidth != width || after.pelsHeight != height); i++) { Thread.Sleep(250); after = Read(ENUM_CURRENT_SETTINGS); }
      result["after"] = Mode(after);
      if (after.pelsWidth != width || after.pelsHeight != height) throw new Exception("Windows reads back " + after.pelsWidth + "x" + after.pelsHeight + " after the change");
      result["ok"] = true; code = 0;
    } catch (Exception e) { result["error"] = e.Message; }
    result["exitCode"] = code;
    File.WriteAllText(a[2], new JavaScriptSerializer().Serialize(result));
    Step("done " + code);
    return code;
  }
}
