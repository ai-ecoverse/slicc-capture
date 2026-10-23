import { extname } from 'node:path';
import { lookup, say, step } from './tools.mjs';

const extensions = {
  '.png': 'png',
  '.jpg': 'jpg',
  '.jpeg': 'jpg',
  '.bmp': 'bmp',
  '.gif': 'gif',
  '.tif': 'tiff',
  '.tiff': 'tiff',
};

const native = [
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class SccaptureNative {',
  '[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }',
  '[StructLayout(LayoutKind.Sequential)] public struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT pt; }',
  '[StructLayout(LayoutKind.Sequential)] public struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }',
  '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
  '[DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO info);',
  '[DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);',
  '[DllImport("user32.dll")] static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr icon, int w, int h, int step, IntPtr brush, int flags);',
  '[DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr handle);',
  'public static void DrawCursor(IntPtr hdc, int left, int top) {',
  'CURSORINFO info = new CURSORINFO();',
  'info.cbSize = Marshal.SizeOf(typeof(CURSORINFO));',
  'if (!GetCursorInfo(ref info) || info.flags != 1) return;',
  'ICONINFO icon;',
  'if (!GetIconInfo(info.hCursor, out icon)) return;',
  'DrawIconEx(hdc, info.pt.X - icon.xHotspot - left, info.pt.Y - icon.yHotspot - top, info.hCursor, 0, 0, 0, IntPtr.Zero, 3);',
  'if (icon.hbmMask != IntPtr.Zero) DeleteObject(icon.hbmMask);',
  'if (icon.hbmColor != IntPtr.Zero) DeleteObject(icon.hbmColor);',
  '}',
  '}',
].join(' ');

export const script = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  'try {',
  '  Add-Type -AssemblyName System.Drawing',
  '  Add-Type -AssemblyName System.Windows.Forms',
  `  Add-Type -TypeDefinition '${native}'`,
  '  [void][SccaptureNative]::SetProcessDPIAware()',
  '  $screen = $env:SCCAPTURE_SCREEN',
  "  if ($screen -eq 'all') {",
  '    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen',
  "  } elseif ($screen -eq 'primary') {",
  '    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
  '  } else {',
  '    $screens = @([System.Windows.Forms.Screen]::PrimaryScreen) + @([System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary })',
  '    $index = [int]$screen',
  '    if ($index -gt $screens.Count) {',
  "      [Console]::Error.WriteLine(('sccapture: -D {0}: no such display' -f $index))",
  '      exit 1',
  '    }',
  '    $bounds = $screens[$index - 1].Bounds',
  '  }',
  '  if ($env:SCCAPTURE_RECT) {',
  "    $rect = [int[]]($env:SCCAPTURE_RECT -split ',')",
  '    $bounds = New-Object System.Drawing.Rectangle ($bounds.X + $rect[0]), ($bounds.Y + $rect[1]), $rect[2], $rect[3]',
  '  }',
  '  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height',
  '  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
  '  $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)',
  "  if ($env:SCCAPTURE_CURSOR -eq '1') {",
  '    $hdc = $graphics.GetHdc()',
  '    [SccaptureNative]::DrawCursor($hdc, $bounds.X, $bounds.Y)',
  '    $graphics.ReleaseHdc($hdc)',
  '  }',
  '  $graphics.Dispose()',
  "  if ($env:SCCAPTURE_CLIPBOARD -eq '1') {",
  '    [System.Windows.Forms.Clipboard]::SetImage($bitmap)',
  '  } else {',
  "    $formats = @{ png = 'Png'; jpg = 'Jpeg'; bmp = 'Bmp'; gif = 'Gif'; tiff = 'Tiff' }",
  '    $bitmap.Save($env:SCCAPTURE_FILE, [System.Drawing.Imaging.ImageFormat]::($formats[$env:SCCAPTURE_FORMAT]))',
  "    if ($env:SCCAPTURE_OPEN -eq '1') { Invoke-Item -LiteralPath $env:SCCAPTURE_FILE }",
  '  }',
  '  $bitmap.Dispose()',
  '} catch {',
  '  [Console]::Error.WriteLine($_.Exception.Message)',
  '  exit 1',
  '}',
].join('\n');

export const encoded = Buffer.from(script, 'utf16le').toString('base64');

export async function windows({ o, file, env, platform, fds, wait }) {
  const names = ['powershell.exe', 'pwsh.exe'];
  const name = names.find((candidate) => lookup(candidate, platform, env));
  if (!name) {
    say(fds[2], `sccapture: no screenshot tool found (tried ${names.join(', ')})\n`);
    return 1;
  }
  let screen = 'all';
  if (o.display) screen = o.display;
  else if (o.main) screen = 'primary';
  const data = {
    SCCAPTURE_FILE: o.clipboard ? undefined : file,
    SCCAPTURE_FORMAT: o.clipboard
      ? 'png'
      : (o.type ?? extensions[extname(file).toLowerCase()] ?? 'png'),
    SCCAPTURE_CLIPBOARD: o.clipboard ? '1' : undefined,
    SCCAPTURE_CURSOR: o.cursor ? '1' : undefined,
    SCCAPTURE_SCREEN: screen,
    SCCAPTURE_RECT: o.rect?.join(','),
    SCCAPTURE_OPEN: o.open && !o.clipboard ? '1' : undefined,
  };
  const child = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.toUpperCase().startsWith('SCCAPTURE_')) child[key] = value;
  }
  for (const [key, value] of Object.entries(data)) if (value !== undefined) child[key] = value;
  await wait(o.delay);
  const args = ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded];
  const done = await step(name, lookup(name, platform, env), args, { env: child }, fds);
  return done ? 0 : 1;
}
