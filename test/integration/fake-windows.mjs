import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';

let shim;

const source = (node) => `using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class Shim {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct StartupInfo {
    public int cb;
    public string reserved;
    public string desktop;
    public string title;
    public int x, y, width, height, columns, rows, fill, flags;
    public short show, reserved2size;
    public IntPtr reserved2, input, output, error;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct ProcessInfo {
    public IntPtr process, thread;
    public int pid, tid;
  }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessW(string app, StringBuilder line, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref StartupInfo si, out ProcessInfo pi);

  [DllImport("kernel32.dll")]
  static extern IntPtr GetStdHandle(int which);

  [DllImport("kernel32.dll")]
  static extern IntPtr GetConsoleWindow();

  [DllImport("kernel32.dll")]
  static extern uint WaitForSingleObject(IntPtr handle, uint ms);

  [DllImport("kernel32.dll")]
  static extern bool GetExitCodeProcess(IntPtr handle, out uint code);

  public static int Main() {
    string self = Process.GetCurrentProcess().MainModule.FileName;
    string line = Environment.CommandLine;
    int at = 0;
    if (line.StartsWith("\\"")) {
      at = line.IndexOf('"', 1) + 1;
    } else {
      while (at < line.Length && line[at] != ' ' && line[at] != '\\t') at++;
    }
    string node = @"${node.replaceAll('"', '""')}";
    StringBuilder command = new StringBuilder("\\"" + node + "\\" \\"" + Path.ChangeExtension(self, ".cjs") + "\\"" + line.Substring(at));
    StartupInfo si = new StartupInfo();
    si.cb = Marshal.SizeOf(typeof(StartupInfo));
    si.flags = 0x100;
    si.input = GetStdHandle(-10);
    si.output = GetStdHandle(-11);
    si.error = GetStdHandle(-12);
    uint flags = GetConsoleWindow() == IntPtr.Zero ? 0x08000000u : 0u;
    ProcessInfo pi;
    if (!CreateProcessW(node, command, IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero, null, ref si, out pi)) {
      Console.Error.WriteLine("shim: CreateProcess failed with " + Marshal.GetLastWin32Error());
      return 127;
    }
    WaitForSingleObject(pi.process, 0xFFFFFFFF);
    uint code;
    GetExitCodeProcess(pi.process, out code);
    return (int)code;
  }
}
`;

function compile() {
  const dir = mkdtempSync(join(tmpdir(), 'slicc-capture-shim-'));
  const file = join(dir, 'shim.cs');
  const out = join(dir, 'shim.exe');
  writeFileSync(file, source(process.execPath));
  const csc = join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const built = spawnSync(csc, ['/nologo', '/target:exe', `/out:${out}`, file], {
    encoding: 'utf8',
  });
  if (built.status !== 0 || !existsSync(out)) {
    throw new Error(`csc failed: ${built.stdout}${built.stderr}${built.error?.message ?? ''}`);
  }
  return out;
}

export function fakeExe(dir, name, script) {
  shim ??= compile();
  copyFileSync(shim, join(dir, name));
  writeFileSync(join(dir, `${parse(name).name}.cjs`), script);
  return join(dir, name);
}
