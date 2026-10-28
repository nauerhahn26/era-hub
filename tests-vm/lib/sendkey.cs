// sendkey.cs - press one key chord with SendInput, as a keyboard would
// (leg B's button case, button press to ask plan T5.8). A Flic in keyboard
// mode is a Bluetooth keyboard to Windows; this stands in for it.
//   sendkey.exe F13        sendkey.exe Ctrl+Alt+F9
// Compiled in the guest with Windows' own csc (C# 5) and run from the
// interactive desktop session (vm.interactive), where the hotkeys live.
using System;
using System.Runtime.InteropServices;

static class SendKey
{
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    // the union is as wide as its widest member, or SendInput refuses the size
    [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);

    static INPUT Key(ushort vk, bool up)
    {
        INPUT i = new INPUT();
        i.type = 1;                       // INPUT_KEYBOARD
        i.u.ki.wVk = vk;
        i.u.ki.dwFlags = up ? 2u : 0u;    // KEYEVENTF_KEYUP
        return i;
    }

    static int Main(string[] args)
    {
        if (args.Length != 1) return 2;
        string[] parts = args[0].Split('+');
        ushort[] vks = new ushort[parts.Length];
        for (int i = 0; i < parts.Length; i++)
        {
            if (parts[i] == "Ctrl") vks[i] = 0x11;          // VK_CONTROL
            else if (parts[i] == "Alt") vks[i] = 0x12;      // VK_MENU
            else vks[i] = (ushort)(0x70 + int.Parse(parts[i].Substring(1)) - 1);   // F1 = 0x70, F13 = 0x7C
        }
        // modifiers down, key down, key up, modifiers up
        INPUT[] seq = new INPUT[vks.Length * 2];
        for (int i = 0; i < vks.Length; i++)
        {
            seq[i] = Key(vks[i], false);
            seq[seq.Length - 1 - i] = Key(vks[i], true);
        }
        uint sent = SendInput((uint)seq.Length, seq, Marshal.SizeOf(typeof(INPUT)));
        return sent == seq.Length ? 0 : 1;
    }
}
