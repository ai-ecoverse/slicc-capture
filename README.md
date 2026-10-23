# slicc-capture

Screen capture for SLICC: `screencapture`, with the options of macOS's `screencapture(1)` wherever they make sense in a browser, and slicc 6's `-c` (to the clipboard) and `-v` (inline in the agent's tool result). Seven's page shows a prompt, the user picks a screen, window or tab in Chrome's `getDisplayMedia` picker, and the command writes a PNG (or JPEG or WebP).

`sccapture` is the same command under a name that works everywhere: in SLICC it is `screencapture`, and on macOS, Linux and Windows it hands off to the platform's own screenshot tool (see [On a host](#on-a-host)). A host's own `screencapture` is never shadowed.

```sh
screencapture shot.png
screencapture -c
screencapture -v
screencapture -T 3 -R 0,0,800,600 -t jpg crop.jpg
```

## Install

In SLICC, the package declares `screencapture` and `sccapture` in `slicc.commands` (POSIX `sh` scripts in `bin/`), so installing it puts both in `/usr/bin`. They need slicc-kernel 1.153.0 or later, for [`/dev/embedder`](#the-request) (`engines.slicc-kernel` is `>=1.153.0`; an older kernel refuses them with exit 126 and `<cmd>: @ai-ecoverse/slicc-capture@<version> needs slicc-kernel >=1.153.0; this kernel is <version>`):

```sh
pnpm add -g @ai-ecoverse/slicc-capture
```

On a host, the installer puts `sccapture` in `~/.local/bin`, with Node 24 or later, which it downloads (`node-<version>-<os>-<arch>.tar.gz`, or the `.zip` on Windows, checked against nodejs.org's `SHASUMS256.txt`) when none is on `PATH`:

```sh
curl -fsSL https://get.sliccy.ai/slicc-capture | sh
```

On Windows, in PowerShell:

```powershell
irm https://get.sliccy.ai/slicc-capture.ps1 | iex
```

The installers are `install.sh` and `install.ps1`, attached to every [GitHub release](https://github.com/ai-ecoverse/slicc-capture/releases) with the package tarball (`slicc-capture-<version>.tgz`) and `SHA256SUMS`, which lists the tarball, `install.sh` and `install.ps1`, in the style of [mcpcat's](https://github.com/ai-ecoverse/mcpcat) `install.sh`. `@semantic-release/npm` packs the tarball into `release/` (`tarballDir`), and `@semantic-release/exec` runs `scripts/assets.mjs`, which renames it and writes `SHA256SUMS`. They check the tarball against `SHA256SUMS`, unpack it into a versioned directory (`${XDG_DATA_HOME:-~/.local/share}/slicc-capture/<version>`, or `%LOCALAPPDATA%\slicc-capture\<version>` on Windows), and write a `sccapture` launcher that runs it with that Node. Without get.sliccy.ai, the same installer comes straight from the release:

```sh
curl -fsSL https://github.com/ai-ecoverse/slicc-capture/releases/latest/download/install.sh | sh
```

| `install.sh` | `install.ps1` | |
| --- | --- | --- |
| `--version VERSION` | `-Version VERSION` | the release to install (default: the latest) |
| `--dir DIR` | `-Dir DIR` | where the launcher goes (default: `~/.local/bin`; on Windows `%LOCALAPPDATA%\slicc-capture\bin`, added to the user's `PATH`) |
| `--help` | `-Help` | print the usage and exit 0 |

Options reach `install.sh` after `sh -s --`, for example `curl -fsSL https://get.sliccy.ai/slicc-capture | sh -s -- --version 1.2.0 --dir ~/bin`, and `install.ps1` through a script block: `& ([scriptblock]::Create((irm https://get.sliccy.ai/slicc-capture.ps1))) -Version 1.2.0`. An unknown option, or `--dir` or `--version` without a value, prints `install.sh: <problem>` and the usage to stderr and exits 2; there are no environment overrides for the options. A failure is `install.sh: <problem>` (`install.ps1: <problem>`) on stderr and exit 1. `SLICC_INSTALL_BASE_URL` replaces the release download directory (by default `https://github.com/ai-ecoverse/slicc-capture/releases/latest/download`, or `…/download/v<version>` with `--version`), and `SLICC_NODE_DIST_BASE` replaces `https://nodejs.org/dist`. The installed command must answer `--version` with the version it was installed as (or the older `sccapture <version>`). On Windows the launcher is `sccapture.ps1`, next to a `sccapture.cmd` for `cmd.exe`; both only start `node.exe` with the entry script and the arguments, and `sccapture` itself never runs `cmd.exe`.

The get.sliccy.ai entries for `slicc-capture` and `slicc-capture.ps1` are added once the first release is out.

With npm, on a machine with Node 24 or later:

```sh
npm install -g @ai-ecoverse/slicc-capture
sccapture shot.png
```

or without installing, `npx -p @ai-ecoverse/slicc-capture sccapture shot.png`.

## Commands

| command | where | what |
| --- | --- | --- |
| `screencapture` | SLICC | captures through seven's page, as below |
| `sccapture` | SLICC | the same as `screencapture` |
| `sccapture` | macOS, Linux, Windows | hands off to the platform's tool, as in [On a host](#on-a-host) |

```
usage: screencapture [-acdimorvwxCW] [-t format] [-T seconds] [-R x,y,w,h] [-D display] [-J style] [file]
```

Short options may be grouped (`-xc`), an option's value may be attached or separate (`-T3`, `-T 3`), and `--` ends the options. `--clipboard` is `-c` and `--view` is `-v`, as in slicc 6. `-h` or `--help` anywhere prints the usage to stdout and exits 0. `--version` and `--upgrade` are described [below](#--upgrade); either must be the only argument, else `<cmd>: <opt>: takes no other arguments` and the usage to stderr, exit 2. An option without its value prints `<cmd>: <opt>: option requires a value` and the usage to stderr, exit 2.

### In SLICC

`screencapture file` asks seven's page to capture, as a `capture.screen` request on `/dev/embedder` ([below](#the-request)). `getDisplayMedia` needs a user gesture, so the page first shows a prompt, `screencapture wants to capture your screen`, with **Choose…** and **Cancel**; **Choose…** opens Chrome's picker. After the user picks, the page waits for `-T` seconds, if given, takes one frame, crops it to `-R`, if given, encodes it and stops the capture. The command writes the bytes it gets back unchanged; an existing file is replaced only once the capture has arrived.

- **The file:** written as PNG, JPEG or WebP: `-t` decides, else the file's extension (`.png`, `.jpg` or `.jpeg`, `.webp`), else PNG. JPEG and WebP use quality 0.92. On success it prints `captured <n> KB to <file>`.
- **`-c`:** captures a PNG and copies it to the clipboard as `image/png`, with a `clipboard.write` request on `/dev/embedder`, which seven's embedder (slicc-bios) answers; [slicc-clipboard](https://github.com/ai-ecoverse/slicc-clipboard)'s `/dev/clipboard` stays text only. It prints `captured <n> KB to clipboard`. A file named with `-c` is ignored, as with macOS's `-c`, and so is `-t`. The `clipboard.write` request is sent before the prompt, so a page that doesn't answer it fails at once, without a capture.
- **`-v`:** shows the capture inline in the agent's tool result, by printing one line `<img:<absolute path>>` on stdout, the marker of [ai-ecoverse/slicc-agent#713](https://github.com/ai-ecoverse/slicc-agent/issues/713), which needs `@ai-ecoverse/slicc-agent` 7.7.0 or later (see its README's ["Images from command output"](https://github.com/ai-ecoverse/slicc-agent#readme)): the agent reads that file with the caller's own permissions, detects PNG, JPEG, GIF or WebP by its magic bytes, fits the image to 1600 px wide and at most 1 MB of base64, and replaces the line with `<path> (<mime>, <bytes> bytes)` and the image in the tool result, at most 4 images per command. It doesn't honour relative paths, markers on stderr, lines over 4 KB, or markers from runs that a guest started (or that inherited guest or lick taint); each of those gets a one-line note instead of the image. With a file, `-v` writes it and prints only the marker for it; without one, it writes the capture to a new `${TMPDIR:-/tmp}/screencapture-XXXXXX.<type>`, which it leaves there for the agent, and prints the marker for that; with `-c`, it copies, prints `captured <n> KB to clipboard`, and then the marker of such a file. slicc 6's `<img:data:<type>;base64,<data>>` is gone: base64 on stdout is scrubbed and cut by the output tail. With an older agent, the marker shows as the line itself. macOS's `-v` (record a video) is out of scope everywhere.
- **No file:** without a file, `-c` or `-v`: `screencapture: output file required (or use -c for clipboard)` and the usage to stderr, exit 2.

Errors, on stderr, from slicc 6 where they still apply:

| error | exit |
| --- | --- |
| `screencapture: user cancelled, permission denied, or the surface is protected` (`EACCES`: **Cancel**, the picker closed, the capture refused, or the embedder refused the surface the user picked) | 1 |
| `screencapture: timed out waiting for the picker` (no answer within 5 minutes; the page's message) | 1 |
| `screencapture: browser APIs are unavailable in this environment` (`ENOTSUP` for the header: no page answers `capture.screen`) | 1 |
| `screencapture: screen capture is not supported in this browser` (`ENOTSUP` from the page, without a message of its own: no `getDisplayMedia`) | 1 |
| `screencapture: -R: rectangle outside the capture` (the page's message) | 1 |
| `screencapture: <message>` (any other error of the page, `EIO` or `ENOENT`: the first line of its message, else the errno's text, such as `I/O error`) | 1 |
| `screencapture: the page sent no image` (an empty reply) | 1 |
| `screencapture: interrupted` (`SIGHUP`, `SIGINT` or `SIGTERM` during the request: the command stops the reader, so the page's `signal` aborts with `interrupted`, removes its temporary files and writes no file) | `128 + n` |
| `screencapture: failed to write file: <file>: <message>` | 1 |
| `screencapture: failed to create a temporary directory in <dir>` (before the request: `mktemp -d` failed in `$TMPDIR`, else `/tmp`; nothing is sent or written) | 1 |
| `screencapture: failed to create a temporary file in <dir>` (`-v` without a file, after the capture: `mktemp` failed; the image is dropped and nothing is written) | 1 |
| `screencapture: failed to copy to clipboard: this page does not copy images (no clipboard.write)` (`ENOTSUP`: no page answers `clipboard.write`) | 1 |
| `screencapture: failed to copy to clipboard: <message>` (the page's message, else the errno's text) | 1 |
| `screencapture: /dev/embedder not available (needs slicc-kernel >= 1.153.0)` (a kernel that runs the commands without the device) | 1 |
| `screencapture: unknown option: <arg>`, then the usage | 2 |
| `screencapture: <opt>: not supported in SLICC` | 2 |
| `screencapture: -t <format>: not supported in SLICC` | 2 |
| `screencapture: -T: invalid delay: <value>`, `-R: invalid rectangle: <value>`, `-D: invalid display: <value>`, `-J: invalid style: <value>` | 2 |
| `screencapture: more than one file: not supported in SLICC` | 2 |

As `sccapture`, the messages start with `sccapture:`. A line of progress from the page (`progress(line)`) reaches stderr as `<cmd>: <line>` while the command waits.

### The request

The commands run in a kernel worker, which has no `getDisplayMedia`, so they ask seven's page over [`/dev/embedder`](https://github.com/ai-ecoverse/slicc-kernel#devembedder) (slicc-kernel 1.153.0, [#1527](https://github.com/ai-ecoverse/slicc-kernel/issues/1527)): one open file description per request, a JSON header line `{ kind, …options }`, then the body, and the reply read to end-of-file. The page side, the prompt, `getDisplayMedia`, the frame, the crop and the encoding, is [a page module](#the-page-module) that slicc-bios registers for `capture.screen` and wraps with its own prompt, user activation, `selfBrowserSurface: 'exclude'` and a check of the picked surface against protected origins; it answers this contract:

- **`capture.screen`:** the header is plain JSON, with no body, and the reply is the encoded image's bytes, nothing else. The command opens the device read-write (`exec 3<>/dev/embedder`), writes the header from a child `sh` that stays until the reply is read (so the page's progress reaches stderr), and reads the reply with a `cat <&3` that it starts in the background, so that a signal to the command can stop it.

| header field | value | from |
| --- | --- | --- |
| `kind` | `"capture.screen"` | |
| `type` | `"image/png"`, `"image/jpeg"` or `"image/webp"` | `-t`, else the file's extension, else PNG; always PNG with `-c` |
| `quality` | `0.92`, only for JPEG and WebP | |
| `cursor` | `"always"` or `"never"`, for `getDisplayMedia`'s `cursor` | `-C` |
| `surface` | `"monitor"` or `"window"`, absent without one, for `displaySurface` (a hint: the user still picks) | `-m` and `-D` give `"monitor"`; `-w`, `-W` and `-J window` give `"window"`; the last one wins |
| `delay` | seconds as a JSON number (`3`, `0.5`), absent without `-T`; the page waits that long after the picker | `-T` |
| `rect` | `{ "x", "y", "width", "height" }`, whole numbers in the frame's pixels, absent without `-R`; outside the frame, the page rejects with `-R: rectangle outside the capture` | `-R` |

For example, `screencapture -C -T 2 -R 0,0,800,600 shot.jpg` sends `{"kind":"capture.screen","type":"image/jpeg","quality":0.92,"cursor":"always","delay":2,"rect":{"x":0,"y":0,"width":800,"height":600}}`. The page rejects with a `NotAllowedError` or `AbortError` for **Cancel**, a closed picker, a refused permission or a protected surface (`EACCES`); a `NotSupportedError` without `getDisplayMedia` (`ENOTSUP`); and any other error, such as a `TimeoutError` `timed out waiting for the picker` after 5 minutes, with the message the command prints (`EIO`). It aborts the capture when its `signal` does.
- **`clipboard.write`:** `-c` sends `{"kind":"clipboard.write","type":"image/png"}` and the PNG as the body, and reads the reply, which is empty, to end-of-file. slicc-bios answers it; with no page that does, the header write fails with `ENOTSUP`. The device is opened read-write and the reply read only after the whole body is written, so a page that answers without reading the body ([slicc-kernel#1536](https://github.com/ai-ecoverse/slicc-kernel/issues/1536)) is the only way a body over 1 MiB could block; the embedder's handler reads it.

### The page module

`@ai-ecoverse/slicc-capture/page` is that page module: one plain ES module (`page/index.mjs`), with no build step and no dependencies, which runs in Chrome and loads in Node. It answers `capture.screen` and nothing else; `clipboard.write` is the embedder's own.

```js
import capture, { create, handle, kinds } from '@ai-ecoverse/slicc-capture/page';

createKernel({
  requests: {
    kinds: capture.kinds,
    handle: (request) => capture.handle({ ...request, display: guardedGetDisplayMedia }),
  },
});
```

- **The exports:** `kinds` is `{ 'capture.screen': {} }`, with no policy; `handle(request)` is a [`/dev/embedder` hook](https://github.com/ai-ecoverse/slicc-kernel#devembedder)'s `handle`; the default export is `{ kinds, handle }`. `create({ ImageCapture, OffscreenCanvas, document, timeout })` returns another `{ kinds, handle }` that uses those instead of the page's globals, and `timeout` (in ms, 5 minutes by default) for the picker; the tests inject fakes through it.
- **`display` is required:** the request is the kernel's (`{ kind, options, body, stamp, signal, progress }`) plus `display(constraints)`, the embedder's `getDisplayMedia`, which resolves to a `MediaStream`. The module never calls `navigator.mediaDevices.getDisplayMedia` itself; without `display`, or without `OffscreenCanvas` and a way to grab a frame (`ImageCapture`, else `document`), it rejects with a `NotSupportedError` `screen capture is not supported in this browser` (`ENOTSUP`).
- **The header:** `type` (PNG by default), `quality`, `cursor`, `surface`, `delay` and `rect` as in [the table above](#the-request); other keys are ignored. A `type` it doesn't encode rejects with a `NotSupportedError` `unsupported type: <type>`, and a value of the wrong shape with a `TypeError` `invalid <field>: <json>` (`EIO`), before `display` is called.
- **The capture:** it calls `display({ video: { cursor, displaySurface }, audio: false })` (each field only when the header has it: `cursor` as is, `surface` as `displaySurface`) after `progress('waiting for the picker…')`. No stream within the timeout rejects with a `TimeoutError` `timed out waiting for the picker`, one without a video track with a `NotFoundError` `the capture has no video track` (`ENOENT`), and one whose track has ended, or ends before the frame (the user's **Stop sharing**), with an `AbortError` `the capture was stopped` (`EACCES`). With a `delay`, it says `waiting <delay> s…` and waits that long. It grabs one frame with `ImageCapture.grabFrame()`, else from a muted `<video>` once it has data, crops it to `rect` (outside the frame: a `RangeError` `-R: rectangle outside the capture`), draws it on an `OffscreenCanvas` and encodes it with `convertToBlob({ type, quality })`. A browser that encodes another type than asked rejects with a `NotSupportedError` `<type> is not supported by this browser`. It resolves with the bytes, a `Uint8Array`.
- **Stopping:** every track of the stream is stopped when `handle` settles, whether it resolved, failed or was aborted, and so is a stream that `display` delivers after the timeout or an abort. When `signal` aborts, `handle` rejects with an `AbortError` carrying the reason's message (`interrupted`, `closed`, or the embedder's own).

**What slicc-bios does around it:** bios registers its own `kinds` table, of which the module's is a subset, and ignores the module's policies. It owns the prompt (`screencapture wants to capture your screen`, **Choose…**, **Cancel**), the user activation `getDisplayMedia` needs, the session tag and the protected origins, and calls `handle` only after its checks pass. Its `display` is a guarded `getDisplayMedia`: it adds `selfBrowserSurface: 'exclude'`, checks the picked surface's capture handle against the protected origins, and rejects with a `NotAllowedError` on a match. Its `signal` also aborts when its prompt is withdrawn.

### Options

Every option of macOS's `screencapture`, and what it does in SLICC and with `sccapture` on each host. On macOS, `sccapture` passes the options through to `screencapture` unchanged, except the ones the macOS column names. "No-op" means the option is accepted and changes nothing. "Not supported" means `<cmd>: <opt>: not supported in SLICC` (or `on Linux`, `on Windows`, `on macOS`) on stderr, exit 2, before anything is captured; "not with `<tool>`" means `sccapture: <opt>: not supported with <tool>`, exit 2, when no tool on `PATH` supports every option given (it names the first one tried).

| option | macOS `screencapture` | SLICC | macOS `sccapture` | Linux `sccapture` | Windows `sccapture` |
| --- | --- | --- | --- | --- | --- |
| `-a` | don't capture attached windows | no-op | passed | no-op | no-op |
| `-b` | capture the Touch Bar | not supported | passed | not supported | not supported |
| `-B <bundleid>` | open in that app | not supported | passed | not supported | not supported |
| `-c` | to the clipboard | a `clipboard.write` request, as `image/png` | passed | see [Linux](#linux) | `Clipboard.SetImage` |
| `-C` | include the cursor | `"cursor": "always"` (else `"never"`), which the browser may not honour | passed | see [Linux](#linux) | draws the cursor into the image |
| `-d` | show errors graphically | no-op | passed | no-op | no-op |
| `-D <display>` | that display (1 is main) | prefers `displaySurface: 'monitor'`; the user picks the screen | passed | not supported | screen *n*: 1 is the primary, then the others in `AllScreens` order; no such screen is `sccapture: -D <n>: no such display`, exit 1 |
| `-g` | record default audio input | not supported | not supported | not supported | not supported |
| `-G <id>` | record that audio source | not supported | not supported | not supported | not supported |
| `-i` | interactive, by selection or window | no-op: the picker is the interaction | passed | see [Linux](#linux) | not supported |
| `-J <style>` | start in `selection`, `window` or `video` | `window` as `-W`; `selection` and `video` not supported | passed | `selection` as `-s`, `window` as `-w`, `video` not supported | not supported |
| `-k` | show clicks in a recording | not supported | not supported | not supported | not supported |
| `-l <windowid>` | that window | not supported | passed | see [Linux](#linux) | not supported |
| `-m` | the main monitor only | prefers `displaySurface: 'monitor'`; the user picks the screen | passed | not supported | the primary screen |
| `-M` | open in a new Mail message | not supported | passed | not supported | not supported |
| `-o` | no window shadow | no-op: the browser captures none | passed | no-op | no-op |
| `-p` | default settings, file ignored | not supported | passed | not supported | not supported |
| `-P` | open in Preview | not supported | passed | `xdg-open <file>` afterwards; without it, `sccapture: no viewer found (tried xdg-open)`, exit 1, after the file is written | `Invoke-Item <file>` afterwards |
| `-r` | no dpi metadata | no-op: none is written | passed | no-op | no-op |
| `-R <x,y,w,h>` | that rectangle | crops the frame, in its pixels | passed | see [Linux](#linux) | that rectangle of the virtual screen |
| `-s` | mouse selection only | not supported: use `-R` | passed | see [Linux](#linux) | not supported |
| `-S` | the screen, in window mode | not supported | passed | not supported | not supported |
| `-t <format>` | the image format, `png` by default | `png`, `jpg` or `jpeg`, `webp`; others not supported | passed | see [Linux](#linux) | `png`, `jpg` or `jpeg`, `bmp`, `gif`, `tiff`; others not supported |
| `-T <seconds>` | wait before capturing | waits after the picker | passed | `sccapture` waits, then runs the tool | `sccapture` waits, then captures |
| `-u` | show the UI afterwards, file ignored | not supported | passed | not supported | not supported |
| `-U` | the interactive toolbar | not supported | passed | not supported | not supported |
| `-v` | record a video | inline in the tool result, as an `<img:<path>>` line ([slicc-agent#713](https://github.com/ai-ecoverse/slicc-agent/issues/713), slicc-agent 7.7.0 or later) | not supported | not supported | not supported |
| `-V <seconds>` | record a video for that long | not supported | not supported | not supported | not supported |
| `-w` | window selection only | prefers `displaySurface: 'window'` | passed | see [Linux](#linux) | not supported |
| `-W` | start in window selection | prefers `displaySurface: 'window'` | passed | as `-w` | not supported |
| `-x` | no sounds | no-op | passed | no-op | no-op |
| `file ...` | one file per screen | one file; more not supported | passed | one file; more not supported | one file; more not supported |

Video recording (`-v`, `-V`, `-g`, `-G`, `-k`) is out of scope on every platform, macOS included; a later release may add it, sharing an encoder with whatever replaces `ffmpeg` in SLICC. `--clipboard` and `--view` are `-c` and `-v` on every platform; on macOS, `sccapture` passes `--clipboard` on as `-c`.

## On a host

Only `sccapture` is installed on a host (the package's `bin`, a small Node script, `host/sccapture.mjs`); the host's own `screencapture`, `grim` and the rest are never shadowed. It runs the platform's tool with a fixed argv and no shell: of the tools below, in this order, the first one on `PATH` that supports every option given (so on GNOME under X11, `-l` picks `import` over `gnome-screenshot`):

| platform | tool | `-c` |
| --- | --- | --- |
| macOS | `screencapture`, with the options passed through as above | `screencapture -c` |
| Linux, under Wayland (`WAYLAND_DISPLAY` set) | `grim` (with `slurp` to select), else `gnome-screenshot` | `wl-copy --type image/png`, else `xclip -selection clipboard -t image/png` |
| Linux, X11 | `gnome-screenshot`, else ImageMagick `import`, else `scrot` | `xclip -selection clipboard -t image/png` |
| Windows | PowerShell, `powershell.exe` else `pwsh.exe`, with System.Drawing and System.Windows.Forms | `Clipboard.SetImage` |

- **The file and its format:** without `-t`, the file's extension picks the format (on macOS, `sccapture` adds `-t` for `.jpg`, `.jpeg`, `.pdf`, `.tiff`, `.gif` and `.bmp`), else PNG. `-c` copies PNG; a file, `-t` and `-P` are then ignored, except on macOS, where `screencapture` decides. Success prints nothing, as `screencapture` does.
- **A file is required**, as in SLICC (`sccapture: output file required (or use -c for clipboard)`, exit 2), except on macOS with `-p`, `-u`, `-P`, `-M` or `-B`, which `screencapture` handles without one.
- **Errors:** with no tool on `PATH`, `sccapture: no screenshot tool found (tried grim, gnome-screenshot)` (the names tried on that platform) to stderr, exit 1; with `-c` and no clipboard tool, `sccapture: no clipboard tool found (tried wl-copy, xclip)`, exit 1. A tool that fails, a cancelled selection included, has its stderr passed through, exit 1. An unknown option prints `sccapture: unknown option: <arg>` and the usage to stderr, exit 2; an option the table marks as not supported on that platform prints `sccapture: <opt>: not supported on <platform>`, exit 2. The values of `-T`, `-R`, `-D` and `-J` are checked as in SLICC, and `-l` takes a window id in decimal or `0x` hex, else `sccapture: -l: invalid window: <value>`, exit 2. `-h` and `--help` print the usage to stdout and exit 0.
- **Other Unix systems** are treated as Linux.

### Linux

How each option reaches the tool. "Not with `<tool>`" is the error only when no tool on `PATH` supports every option given, and it names the first one tried. `<file>` is the file, or a temporary PNG that is then copied with `-c` and deleted.

| option | `grim` | `gnome-screenshot` | `import` | `scrot` |
| --- | --- | --- | --- | --- |
| none | `grim <file>` | `gnome-screenshot -f <file>` | `import -window root <file>` | `scrot -o <file>` |
| `-i`, `-s` | `grim -g <slurp's output> <file>`; without `slurp`, `sccapture: no region selector found (tried slurp)`, exit 1 | `-a` | `import <file>`: click a window or drag a region | `-s` |
| `-w`, `-W` | not with `grim` | not with `gnome-screenshot` | `import <file>` | `-s` |
| `-R x,y,w,h` | `-g "x,y wxh"` | not with `gnome-screenshot` | `-crop wxh+x+y +repage` | `-a x,y,w,h` |
| `-C` | `-c` | `-p` | not with `import` | `-p` |
| `-l <windowid>` | not with `grim` | not with `gnome-screenshot` | `-window <windowid>` | not with `scrot` |
| `-t png`, `jpg` | `-t png`, `-t jpeg`; without `-t`, `-t jpeg` for a `.jpg` or `.jpeg` file, since grim writes PNG whatever the extension | `png` only, else not with `gnome-screenshot` | `png:<file>`, `jpg:<file>`; without `-t`, `png:<file>` for a file without an extension, which `import` can't guess | by the file's extension; a `-t` that differs from it is not with `scrot` |

Under Wayland, `grim` needs a compositor with wlr-screencopy (sway, Hyprland and other wlroots ones); elsewhere it fails with its own message, so install `gnome-screenshot` there. `import` and `scrot` aren't tried under Wayland, where they would see only XWayland windows.

### Windows

`sccapture` runs `powershell.exe` (else `pwsh.exe`) with `-NoProfile -NonInteractive -STA -EncodedCommand` and a fixed script; the file name and the option values reach it as data, in `SCCAPTURE_*` environment variables, never as script. (PowerShell reads a script on stdin line by line, as if typed, so a multi-line block in it can stop at the first blank line; `-EncodedCommand` is what slicc-clipboard uses.) The process is made per-monitor DPI-aware first (system DPI-aware before Windows 10 1703), so a scaled display is captured at its real resolution, even when the monitors' scales differ. It copies the virtual screen (every monitor), or the screen `-m`/`-D` names, or the `-R` rectangle of that (its `x,y` from the top left of the virtual screen, or of the screen `-m`/`-D` names), with `Graphics.CopyFromScreen`, draws the cursor for `-C`, and saves with the `-t` format's `ImageFormat`, or `Clipboard.SetImage` for `-c`.

### In SLICC, the SLICC commands win

The package has both `bin` and `slicc.commands`, and both name `sccapture`. As with slicc-clipboard, the kernel ignores a package's `bin` entry when the same package declares that name in `slicc.commands`, and bios removes the `$PNPM_HOME/bin` link pnpm makes for it, so the Node script, which SLICC has no Node to run, never shadows the SLICC command.

## `--upgrade`

Every host command takes `--upgrade`. It runs the latest release's installer (`install.sh`, or `install.ps1` on Windows) with `--dir` set to the directory the command is installed in, so the new version replaces the old one in place, then prints `<cmd>: <old> → <new>` (for example `sccapture: 1.2.0 → 1.3.0`), or `<cmd>: already up to date (<version>)`, to stdout and exits 0. If the installer fails, its stderr is passed through and the command exits 1. A command installed with npm prints `npm install -g @ai-ecoverse/slicc-capture@latest` to run instead, and exits 0. In SLICC, `--upgrade` prints `pnpm add -g @ai-ecoverse/slicc-capture@latest` to run, and exits 0; it installs nothing itself. `--upgrade` takes no other arguments.

For slicc-capture, the commands are `sccapture` on a host and `screencapture` and `sccapture` in SLICC.

The launcher the installer writes sets `SCCAPTURE_INSTALL_DIR` to its own directory; that is how `sccapture` knows the installer put it there (it removes the variable before it starts anything else), and without it `sccapture` counts as installed with npm. The installer is downloaded with Node's `fetch` from `https://github.com/ai-ecoverse/slicc-capture/releases/latest/download/` and run as `sh install.sh --dir DIR`, or `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File install.ps1 -Dir DIR` (else `pwsh.exe`); its stderr is passed through, and the line it prints, `sccapture <version> installed to <launcher>`, names the new version. Without `sh` (or PowerShell) it prints `sccapture: no shell found to run install.sh (tried sh)`, and a failed download `sccapture: could not download <url>: <reason>`, and exits 1. `SLICC_INSTALL_BASE_URL`, when set, replaces that release URL for `--upgrade` and for the installers' own downloads.

`--version` prints the version (`0.1.0`) to stdout and exits 0, on a host and in SLICC; the installers run the installed command with it and check it reports the version they installed. It takes no other arguments either.

## Development

```sh
npm install
npm run lint
npm test
npm run test:unit
```

- `npm install` also installs the git hooks into this worktree's own `node_modules/` through slicc-shared-web's `slicc-install-hooks` and the committed `.githooks/`.
- `npm run lint`: Biome, the no-comment check and the other [slicc-shared-web](https://github.com/ai-ecoverse/slicc-shared-web) checks, then `shellcheck -s sh` and `dash -n` on `install.sh` and `bin/*`.
- `npm test`: the integration tests in `test/integration/`. `commands.test.mjs` runs `screencapture` and `sccapture` on `@ai-ecoverse/slicc-kernel/node` (the version `engines.slicc-kernel` names, pinned) with wasm-bash and wasm-coreutils, and a fake `capture.screen` and `clipboard.write` handler (`createNodeKernel({ requests })`): every option's header, the bytes written unchanged, the errnos and their messages, `-c`, `-v`, and slicc-kernel 1.152.2, which has no `/dev/embedder`. `test/integration/repo.test.mjs` checks the workflow, the release config, the pinned devDependencies and what `npm pack` ships. The host tests run `host/` against fake `screencapture`, `grim`, `slurp`, `gnome-screenshot`, `import`, `scrot`, `wl-copy`, `xclip`, `xdg-open`, `powershell.exe` and `pwsh.exe` on a temporary `PATH`, and `--upgrade` against installers served from a local HTTP server, with the platform forced, so each branch is checked on any machine; only CI touches a real screen. `install.test.mjs` runs `install.sh` on a tarball packed from the tree, with the Node on `PATH` and with a Node download from a fake `nodejs.org`, and `--upgrade` against a release served from a local directory; `install.ps1` is checked statically, and run when `pwsh` is on `PATH`.
- `page.test.mjs` registers [the page module](#the-page-module) through `createNodeKernel({ requests })`, with a fake `display` and fake `ImageCapture`, `OffscreenCanvas` and `<video>` injected through `create`, and runs the real `screencapture`: the constraints, the crop, the type and quality, the delay and its progress, an interrupt in the picker and in the delay, **Stop sharing**, the picker's timeout, the errnos and their messages end to end, and that every track is stopped. `browser.test.mjs` runs the module in Chrome, through slicc-shared-web's harness, with a `display` that returns a canvas's `captureStream()`: PNG, JPEG and WebP, the crop, the `<video>` fallback, an abort and the stopped track. It runs on CI only, and is skipped without `CI`.
- `npm run test:unit`: the unit tests in the gitignored `test/unit/`, with coverage in `coverage/unit/lcov.info`. `npm run test:sh` runs the `test/unit/*.sh.mjs` ones, which trace `bin/` with `set -x` in the node kernel, and writes `coverage/sh/lcov.info`. The pre-commit hook wants 100% coverage of the changed lines of both, and runs `diff-cover` through `uvx`, so install [uv](https://docs.astral.sh/uv/) once.

CI is `.github/workflows/ci.yml`, the only workflow, which runs [slicc-shared-web's pipeline](https://github.com/ai-ecoverse/slicc-shared-web#pipeline) at the devDependency's version: `npm run lint`, then `npm test`, then on a pull request the Claude and Codex reviews. The merge queue requires `ci / integration` and `ci / review`. On a push to `main`, semantic-release releases and publishes to npm through trusted publishing, with provenance from `ci.yml`, and attaches the installers.

## License

Apache-2.0
