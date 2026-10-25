# slicc-capture

Screen capture for SLICC: `screencapture`, with the options of macOS's `screencapture(1)` wherever they make sense in a browser, `-c` (to the clipboard) and `-P` (inline in the agent's tool result, the closest a browser has to Preview). Seven's page shows a prompt, the user picks a screen, window or tab in Chrome's `getDisplayMedia` picker, and the command writes a PNG (or JPEG or WebP), or, with `-v` or `-V`, records a WebM or MP4 video. A file named `-` is standard output.

`sccapture` is the same command under a name that works everywhere: in SLICC it is `screencapture`, and on macOS, Linux and Windows it hands off to the platform's own screenshot tool (see [On a host](#on-a-host)). A host's own `screencapture` is never shadowed.

```sh
screencapture shot.png
screencapture -c
screencapture -P
screencapture -T 3 -R 0,0,800,600 -t jpg crop.jpg
screencapture -V 10 -g talk.webm
screencapture - | upload
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

Without get.sliccy.ai, the same installer comes straight from the release:

```sh
curl -fsSL https://github.com/ai-ecoverse/slicc-capture/releases/latest/download/install.sh | sh
```

Options reach `install.sh` after `sh -s --`, for example `curl -fsSL https://get.sliccy.ai/slicc-capture | sh -s -- --version 1.2.0 --dir ~/bin`, and `install.ps1` through a script block: `& ([scriptblock]::Create((irm https://get.sliccy.ai/slicc-capture.ps1))) -Version 1.2.0`. On Windows the launchers are `sccapture.ps1` and `sccapture.cmd`, and the bin directory is added to the user's `PATH`. [The installer](#the-installer) has the details.

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
usage: screencapture [-acdgimorvwxACPW] [-t format] [-T seconds] [-R x,y,w,h] [-D display] [-J style] [-V seconds] [-G id] [file | -]
```

Short options may be grouped (`-xc`), an option's value may be attached or separate (`-T3`, `-T 3`), and `--` ends the options. `--clipboard` is `-c` and `--view` is `-P`. slicc 6's `-v` (inline) is now `-P`, and `-v` records a video, as on macOS. `-h` or `--help` anywhere prints the help to stdout and exits 0: the usage line, one line on what the command captures with, a line for each option it takes, `--version`, `--upgrade` and `--help`, a line on `-`, and then the no-ops (`-a, -d, -i, -o, -r, -x` in SLICC). `--version` and `--upgrade` are described [below](#--upgrade); either must be the only argument, else `<cmd>: <opt>: takes no other arguments` and the usage to stderr, exit 2. An option without its value prints `<cmd>: <opt>: option requires a value` and the usage to stderr, exit 2.

### In SLICC

`screencapture file` asks seven's page to capture, as a `capture.screen` request on `/dev/embedder` ([below](#the-request)). `getDisplayMedia` needs a user gesture, so the page first shows a prompt, `screencapture wants to capture your screen`, with **Choose…** and **Cancel**; **Choose…** opens Chrome's picker. After the user picks, the page waits for `-T` seconds, if given, takes one frame, crops it to `-R`, if given, encodes it and stops the capture. The command writes the bytes it gets back unchanged; an existing file is replaced only once the capture has arrived.

- **The file:** written as PNG, JPEG or WebP: `-t` decides, else the file's extension (`.png`, `.jpg` or `.jpeg`, `.webp`), else PNG. JPEG and WebP use quality 0.92. On success it prints `captured <n> KB to <file>`.
- **`-c`:** captures a PNG and copies it to the clipboard as `image/png`, with a `clipboard.write` request on `/dev/embedder`, which seven's embedder (slicc-bios) answers; [slicc-clipboard](https://github.com/ai-ecoverse/slicc-clipboard)'s `/dev/clipboard` stays text only. It prints `captured <n> KB to clipboard`. A file named with `-c` is ignored, as with macOS's `-c`, and so is `-t`. The `clipboard.write` request is sent before the prompt, so a page that doesn't answer it fails at once, without a capture.
- **`-P`:** shows the capture inline in the agent's tool result, by printing one line `<img:<absolute path>>` on stdout, the marker of [ai-ecoverse/slicc-agent#713](https://github.com/ai-ecoverse/slicc-agent/issues/713), which needs `@ai-ecoverse/slicc-agent` 7.7.0 or later (see its README's ["Images from command output"](https://github.com/ai-ecoverse/slicc-agent#readme)): the agent reads that file with the caller's own permissions, detects PNG, JPEG, GIF or WebP by its magic bytes, fits the image to 1600 px wide and at most 1 MB of base64, and replaces the line with `<path> (<mime>, <bytes> bytes)` and the image in the tool result, at most 4 images per command. It doesn't honour relative paths, markers on stderr, lines over 4 KB, or markers from runs that a guest started (or that inherited guest or lick taint); each of those gets a one-line note instead of the image. With a file, `-P` writes it and prints only the marker for it; without one, it writes the capture to a new `${TMPDIR:-/tmp}/screencapture-XXXXXX.<type>`, which it leaves there for the agent, and prints the marker for that; with `-c`, it copies, prints `captured <n> KB to clipboard`, and then the marker of such a file. slicc 6's `<img:data:<type>;base64,<data>>` is gone: base64 on stdout is scrubbed and cut by the output tail. With an older agent, the marker shows as the line itself. Images only: `-P` with `-v` is `screencapture: -P: not with -v in SLICC`, exit 2.
- **`-v`, `-V <seconds>`, `-J video`:** record a video of what the user picks, with the browser's `MediaRecorder`, as WebM (VP9, else VP8, with Opus) or MP4 (H.264, with AAC, else Opus): `-t webm` or `mkv`, `-t mp4`, `mov` or `m4v`, else the file's extension, else WebM. A `.mov` is an MP4, which QuickTime plays. A file with an image's extension (`.png`, `.jpg`, `.jpeg`, `.webp`) is refused, since slicc 6's `-v shot.png` meant the inline view: `screencapture: -v: shot.png is an image: record to a .webm or .mp4, or use -P to show a capture inline`, exit 2. `-V` records for that many seconds (a positive number, else `-V: invalid duration: <value>`) and implies `-v`; `-v` alone records until the user clicks **Stop sharing**, or the command gets `SIGINT` (^C), `SIGTERM` (`timeout`) or `SIGHUP`, which stop the recording and keep what arrived: the page sends the video in 250 ms chunks, so up to the last quarter second is lost, and the WebM has no duration in its header. A signal before anything arrived is `screencapture: interrupted`, exit `128 + n`, as for an image. `-T` waits after the picker, before the recording starts. `-C` and `-m`, `-D`, `-w`, `-W` are hints as for an image; `-R` isn't supported with `-v` (`-R: not with -v in SLICC`), and neither is `-c` (`-c: not with -v`). On success it prints `captured <n> KB to <file>`. A page that sends nothing is `screencapture: the page sent no video`, exit 1.
- **Audio:** `-A` asks the picker for the shared tab's or screen's audio (`getDisplayMedia`'s `audio: true`; Chrome shows a **Share audio** switch, and when the user leaves it off the page says `no audio was shared` and records without), `-g` records the default microphone too, and `-G <id>` the microphone with that `deviceId` (letters, digits and `+/=_.-`, else `-G: invalid audio input: <value>`). Two audio sources are mixed into one track. Each needs `-v` (`<opt>: needs -v`, exit 2). The microphone needs the page's permission, which a refusal makes `user cancelled, permission denied, or the surface is protected`. In seven today, slicc-bios (which pins slicc-capture 1.3.4) answers with a guarded `display` that forces `audio: false` and passes no `userMedia`, so `-A` records without audio (`no audio was shared`) and `-g` and `-G` are refused (`this page does not record the microphone`) until bios passes the audio through and adds a guarded `userMedia`.
- **`-` (standard output):** a file named `-` (`-- -` too) writes the image or the video to stdout and prints nothing else there. On a terminal it is `screencapture: refusing to write to a terminal: redirect standard output or name a file`, exit 2, before anything is asked, and so is `-P` with it (`-P: not with -`). With `-c`, `-` is ignored like any file.
- **No file:** without a file, `-c` or `-P`: `screencapture: output file required (or use -c for clipboard)` and the usage to stderr, exit 2.

Errors, on stderr, from slicc 6 where they still apply:

| error | exit |
| --- | --- |
| `screencapture: user cancelled, permission denied, or the surface is protected` (`EACCES`: **Cancel**, the picker closed, the capture refused, or the embedder refused the surface the user picked) | 1 |
| `screencapture: timed out waiting for the picker` (no answer within 5 minutes; the page's message) | 1 |
| `screencapture: browser APIs are unavailable in this environment` (`ENOTSUP` for the header: no page answers `capture.screen`) | 1 |
| `screencapture: screen capture is not supported in this browser` (`ENOTSUP` from the page, without a message of its own: no `getDisplayMedia`) | 1 |
| `screencapture: -R: rectangle outside the capture` (the page's message) | 1 |
| `screencapture: <message>` (any other error of the page, `EIO` or `ENOENT`: the first line of its message, else the errno's text, such as `I/O error`) | 1 |
| `screencapture: the page sent no image` (an empty reply), or `the page sent no video` | 1 |
| `screencapture: interrupted` (`SIGHUP`, `SIGINT` or `SIGTERM` during the request: the command stops the reader, so the page's `signal` aborts with `interrupted`, removes its temporary files and writes no file) | `128 + n` |
| `screencapture: failed to write file: <file>: <message>` | 1 |
| `screencapture: failed to create a temporary directory in <dir>` (before the request: `mktemp -d` failed in `$TMPDIR`, else `/tmp`; nothing is sent or written) | 1 |
| `screencapture: failed to create a temporary file in <dir>` (`-P` without a file, after the capture: `mktemp` failed; no file is written and no marker is printed; with `-c`, the clipboard copy has already been made) | 1 |
| `screencapture: failed to copy to clipboard: this page does not copy images (no clipboard.write)` (`ENOTSUP`: no page answers `clipboard.write`) | 1 |
| `screencapture: failed to copy to clipboard: <message>` (the page's message, else the errno's text) | 1 |
| `screencapture: /dev/embedder not available (needs slicc-kernel >= 1.153.0)` (a kernel that runs the commands without the device) | 1 |
| `screencapture: unknown option: <arg>`, then the usage | 2 |
| `screencapture: <opt>: not supported in SLICC` | 2 |
| `screencapture: -t <format>: not supported in SLICC` | 2 |
| `screencapture: -T: invalid delay: <value>`, `-R: invalid rectangle: <value>`, `-D: invalid display: <value>`, `-J: invalid style: <value>` | 2 |
| `screencapture: more than one file: not supported in SLICC` | 2 |
| `screencapture: -V: invalid duration: <value>`, `-G: invalid audio input: <value>` | 2 |
| `screencapture: -g: needs -v` (and `-G`, `-A`), `-c: not with -v`, `-P: not with -v in SLICC`, `-R: not with -v in SLICC` | 2 |
| `screencapture: refusing to write to a terminal: redirect standard output or name a file`, `-P: not with -` | 2 |
| `screencapture: failed to write to standard output` | 1 |

As `sccapture`, the messages start with `sccapture:`. A line of progress from the page (`progress(line)`) reaches stderr as `<cmd>: <line>` while the command waits.

### The request

The commands run in a kernel worker, which has no `getDisplayMedia`, so they ask seven's page over [`/dev/embedder`](https://github.com/ai-ecoverse/slicc-kernel#devembedder) (slicc-kernel 1.153.0, [#1527](https://github.com/ai-ecoverse/slicc-kernel/issues/1527)): one open file description per request, a JSON header line `{ kind, …options }`, then the body, and the reply read to end-of-file. The page side, the prompt, `getDisplayMedia`, the frame, the crop and the encoding, is [a page module](#the-page-module) that slicc-bios registers for `capture.screen` and wraps with its own prompt, user activation, `selfBrowserSurface: 'exclude'` and a check of the picked surface against protected origins; it answers this contract:

- **`capture.screen`:** the header is plain JSON, with no body, and the reply is the encoded image's bytes, nothing else. The command opens the device read-write (`exec 3<>/dev/embedder`), writes the header from a child `sh` that stays until the reply is read (so the page's progress reaches stderr), and reads the reply with a `cat <&3` that it starts in the background, so that a signal to the command can stop it.

| header field | value | from |
| --- | --- | --- |
| `kind` | `"capture.screen"` | |
| `type` | `"image/png"`, `"image/jpeg"` or `"image/webp"`; with `-v`, `"video/webm"` or `"video/mp4"` | `-t`, else the file's extension, else PNG (WebM with `-v`); always PNG with `-c` |
| `quality` | `0.92`, only for JPEG and WebP | |
| `cursor` | `"always"` or `"never"`, for `getDisplayMedia`'s `cursor` | `-C` |
| `surface` | `"monitor"` or `"window"`, absent without one, for `displaySurface` (a hint: the user still picks) | `-m` and `-D` give `"monitor"`; `-w`, `-W` and `-J window` give `"window"`; the last one wins |
| `delay` | seconds as a JSON number (`3`, `0.5`), absent without `-T`; the page waits that long after the picker | `-T` |
| `rect` | `{ "x", "y", "width", "height" }`, whole numbers in the frame's pixels, absent without `-R`; outside the frame, the page rejects with `-R: rectangle outside the capture`; not with a video type | `-R` |
| `duration` | seconds as a JSON number, absent without `-V`; the page stops the recording after that long | `-V` |
| `system` | `true`, absent without `-A`: `audio: true` for `getDisplayMedia` | `-A` |
| `microphone` | `true` for the default microphone, or a `deviceId` string, absent without `-g` and `-G` | `-g`, `-G` (the last one wins) |

For a video type, the reply is a stream: the page answers as soon as the recording starts, with `progress('recording…')` (`recording for <n> s…` with a `duration`), and sends each chunk of the `MediaRecorder` as it comes, then ends the reply when the recording stops (the `duration`, **Stop sharing**). The command reads it to end-of-file in the background, so a signal stops the reader, which aborts the request (`interrupted`), and the page stops the recorder. `screencapture -V 5 -g talk.webm` sends `{"kind":"capture.screen","type":"video/webm","cursor":"never","duration":5,"microphone":true}`.

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

- **The exports:** `kinds` is `{ 'capture.screen': {} }`, with no policy; `handle(request)` is a [`/dev/embedder` hook](https://github.com/ai-ecoverse/slicc-kernel#devembedder)'s `handle`; the default export is `{ kinds, handle }`. `create({ ImageCapture, OffscreenCanvas, document, MediaRecorder, MediaStream, AudioContext, timeout })` returns another `{ kinds, handle }` that uses those instead of the page's globals, and `timeout` (in ms, 5 minutes by default) for the picker; the tests inject fakes through it.
- **`display` is required:** the request is the kernel's (`{ kind, options, body, stamp, signal, progress }`) plus `display(constraints)`, the embedder's `getDisplayMedia`, which resolves to a `MediaStream`. The module never calls `navigator.mediaDevices.getDisplayMedia` itself; without `display`, or without `OffscreenCanvas` and a way to grab a frame (`ImageCapture`, else `document`), it rejects with a `NotSupportedError` `screen capture is not supported in this browser` (`ENOTSUP`).
- **`userMedia` is required for a microphone:** a header with `microphone` also needs `userMedia(constraints)` in the request, the embedder's `getUserMedia`, guarded as `display` is, which resolves to a `MediaStream`. The module never calls `navigator.mediaDevices.getUserMedia` either; without `userMedia` it rejects, before `display` is called, with a `NotSupportedError` `this page does not record the microphone` (`ENOTSUP`), which the command prints as `screencapture: this page does not record the microphone`.
- **The header:** `type` (PNG by default), `quality`, `cursor`, `surface`, `delay`, `rect`, `duration`, `system` and `microphone` as in [the table above](#the-request); other keys are ignored. `rect` with a video type rejects with a `NotSupportedError` `rect: not with video`. A `type` it doesn't encode rejects with a `NotSupportedError` `unsupported type: <type>`, and a value of the wrong shape with a `TypeError` `invalid <field>: <json>` (`EIO`), before `display` is called.
- **The capture:** it calls `display({ video: { cursor, displaySurface }, audio: false })` (each field only when the header has it: `cursor` as is, `surface` as `displaySurface`) after `progress('waiting for the picker…')`. No stream within the timeout rejects with a `TimeoutError` `timed out waiting for the picker`, one without a video track with a `NotFoundError` `the capture has no video track` (`ENOENT`), and one whose track has ended, or ends before the frame (the user's **Stop sharing**), with an `AbortError` `the capture was stopped` (`EACCES`). With a `delay`, it says `waiting <delay> s…` and waits that long. It grabs one frame with `ImageCapture.grabFrame()`, else from a muted `<video>` once it has data, crops it to `rect` (outside the frame: a `RangeError` `-R: rectangle outside the capture`), draws it on an `OffscreenCanvas` and encodes it with `convertToBlob({ type, quality })`. A browser that encodes another type than asked rejects with a `NotSupportedError` `<type> is not supported by this browser`. It resolves with the bytes, a `Uint8Array`.
- **Recording:** for `video/webm` or `video/mp4`, it needs `MediaRecorder` and `MediaStream` (else `screen capture is not supported in this browser`) and a `mimeType` `MediaRecorder.isTypeSupported` takes, checked before the picker (else `<type> is not supported by this browser`): `video/webm;codecs=vp9`, `vp8`, then `video/webm`, or `video/mp4;codecs=avc1`, then `video/mp4`, and with audio the same with `,opus` (MP4: `,mp4a.40.2`, then `,opus`). It asks for `audio: true` with `system`, and for `microphone` calls the request's `userMedia(constraints)`, the embedder's guarded `getUserMedia`, with `{ audio: true, video: false }` or `{ audio: { deviceId: { exact: id } }, video: false }`; more than one audio track is mixed through an `AudioContext`. It resolves with a `ReadableStream` of the recording's chunks (`start(250)`), which ends after the recorder's `stop`, at the `duration`, when the video track ends, or when the reader cancels; a recorder `error` errors the stream (`the recording failed` without a message of its own). Every track, the microphone's included, is stopped, and the `AudioContext` closed, when the recording ends, and when `signal` aborts.
- **Stopping:** every track of the stream is stopped when `handle` settles, whether it resolved, failed or was aborted, and so is a stream that `display` delivers after the timeout or an abort. When `signal` aborts, `handle` rejects with an `AbortError` carrying the reason's message (`interrupted`, `closed`, or the embedder's own).

**What slicc-bios does around it:** bios registers its own `kinds` table, of which the module's is a subset, and ignores the module's policies. It owns the prompt (`screencapture wants to capture your screen`, **Choose…**, **Cancel**), the user activation `getDisplayMedia` needs, the session tag and the protected origins, and calls `handle` only after its checks pass. Its `display` is a guarded `getDisplayMedia`: it adds `selfBrowserSurface: 'exclude'`, checks the picked surface's capture handle against the protected origins, and rejects with a `NotAllowedError` on a match. Its `signal` also aborts when its prompt is withdrawn.

### Options

Every option of macOS's `screencapture`, and what it does in SLICC and with `sccapture` on each host. On macOS, `sccapture` passes the options through to `screencapture` unchanged, except the ones the macOS column names. "No-op" means the option is accepted and changes nothing. "Not supported" means `<cmd>: <opt>: not supported in SLICC` (or `on Linux`, `on Windows`, `on macOS`) on stderr, exit 2, before anything is captured; "not with `<tool>`" means `sccapture: <opt>: not supported with <tool>`, exit 2, when no tool on `PATH` supports every option given (it names the first one tried).

| option | macOS `screencapture` | SLICC | macOS `sccapture` | Linux `sccapture` | Windows `sccapture` |
| --- | --- | --- | --- | --- | --- |
| `-a` | don't capture attached windows | no-op | passed | no-op | no-op |
| `-A` | with `-v`, record the system audio | the shared audio (`system`) | passed | `@DEFAULT_MONITOR@` (see [Linux](#linux)) | not supported |
| `-b` | capture the Touch Bar | not supported | passed | not supported | not supported |
| `-B <bundleid>` | open in that app | not supported | passed | not supported | not supported |
| `-c` | to the clipboard | a `clipboard.write` request, as `image/png` | passed | see [Linux](#linux) | `Clipboard.SetImage` |
| `-C` | include the cursor | `"cursor": "always"` (else `"never"`), which the browser may not honour | passed | see [Linux](#linux) | draws the cursor into the image |
| `-d` | show errors graphically | no-op | passed | no-op | no-op |
| `-D <display>` | that display (1 is main) | prefers `displaySurface: 'monitor'`; the user picks the screen | passed | not supported | screen *n*: 1 is the primary, then the others in `AllScreens` order; no such screen is `sccapture: -D <n>: no such display`, exit 1 |
| `-g` | with `-v`, record the default audio input | the default microphone | passed | the PulseAudio source `default` | not supported |
| `-G <id>` | with `-v`, record that audio source | the microphone with that `deviceId` | passed | that PulseAudio source | that DirectShow audio device |
| `-i` | interactive, by selection or window | no-op: the picker is the interaction | passed | see [Linux](#linux) | not supported |
| `-J <style>` | start in `selection`, `window` or `video` | `window` as `-W`, `video` as `-v`; `selection` not supported | passed | `selection` as `-s`, `window` as `-w`, `video` as `-v` | not supported |
| `-k` | show clicks in a recording | not supported | passed | not supported | not supported |
| `-l <windowid>` | that window | not supported | passed | see [Linux](#linux) | not supported |
| `-m` | the main monitor only | prefers `displaySurface: 'monitor'`; the user picks the screen | passed | not supported | the primary screen |
| `-M` | open in a new Mail message | not supported | passed | not supported | not supported |
| `-o` | no window shadow | no-op: the browser captures none | passed | no-op | no-op |
| `-p` | default settings, file ignored | not supported | passed | not supported | not supported |
| `-P` | open in Preview | inline in the tool result, as an `<img:<path>>` line ([slicc-agent#713](https://github.com/ai-ecoverse/slicc-agent/issues/713), slicc-agent 7.7.0 or later); also `--view` | passed | `xdg-open <file>` afterwards; without it, `sccapture: no viewer found (tried xdg-open)`, exit 1, after the file is written | `Invoke-Item <file>` afterwards |
| `-r` | no dpi metadata | no-op: none is written | passed | no-op | no-op |
| `-R <x,y,w,h>` | that rectangle | crops the frame, in its pixels | passed | see [Linux](#linux) | that rectangle of the virtual screen |
| `-s` | mouse selection only | not supported: use `-R` | passed | see [Linux](#linux) | not supported |
| `-S` | the screen, in window mode | not supported | passed | not supported | not supported |
| `-t <format>` | the image format, `png` by default | `png`, `jpg` or `jpeg`, `webp`; with `-v`, `webm`, `mkv`, `mp4`, `mov`, `m4v`; others not supported | passed | see [Linux](#linux); with `-v`, `mp4`, `mov`, `mkv`, `webm` | `png`, `jpg` or `jpeg`, `bmp`, `gif`, `tiff`; with `-v`, `mp4`, `mov`, `mkv`, `webm`; others not supported |
| `-T <seconds>` | wait before capturing | waits after the picker | passed | `sccapture` waits, then runs the tool | `sccapture` waits, then captures |
| `-u` | show the UI afterwards, file ignored | not supported | passed | not supported | not supported |
| `-U` | the interactive toolbar | not supported | passed | not supported | not supported |
| `-v` | record a video | `MediaRecorder`, until **Stop sharing** or a signal | passed | `wf-recorder` under Wayland, `ffmpeg` (x11grab) under X11, until a signal | `ffmpeg.exe` (gdigrab), until a signal |
| `-V <seconds>` | record a video for that long | the page stops after that long; implies `-v` | passed, with `-v` added | `ffmpeg -t`, or `SIGINT` to `wf-recorder` after that long; implies `-v` | `ffmpeg -t`; implies `-v` |
| `-w` | window selection only | prefers `displaySurface: 'window'` | passed | see [Linux](#linux) | not supported |
| `-W` | start in window selection | prefers `displaySurface: 'window'` | passed | as `-w` | not supported |
| `-x` | no sounds | no-op | passed | no-op | no-op |
| `file ...` | one file per screen | one file; more not supported | passed | one file; more not supported | one file; more not supported |
| `-` | | standard output | a temporary file, then standard output | the same | the same |

`--clipboard` and `--view` are `-c` and `-P` on every platform; on macOS, `sccapture` passes them on as `-c` and `-P`. On Linux and Windows, `-c` with `-v` is `sccapture: -c: not with -v`, and `-g`, `-G` and `-A` without it `sccapture: <opt>: needs -v`, exit 2.

## On a host

Only `sccapture` is installed on a host (the package's `bin`, a small Node script, `host/sccapture.mjs`); the host's own `screencapture`, `grim` and the rest are never shadowed. It runs the platform's tool with a fixed argv and no shell: of the tools below, in this order, the first one on `PATH` that supports every option given (so on GNOME under X11, `-l` picks `import` over `gnome-screenshot`):

| platform | tool | `-c` |
| --- | --- | --- |
| macOS | `screencapture`, with the options passed through as above | `screencapture -c` |
| Linux, under Wayland (`WAYLAND_DISPLAY` set) | `grim` (with `slurp` to select), else `gnome-screenshot` | `wl-copy --type image/png`, else `xclip -selection clipboard -t image/png` |
| Linux, X11 | `gnome-screenshot`, else ImageMagick `import`, else `scrot` | `xclip -selection clipboard -t image/png` |
| Windows | PowerShell, `powershell.exe` else `pwsh.exe`, with System.Drawing and System.Windows.Forms | `Clipboard.SetImage` |

Videos (`-v`, `-V`, `-J video`) have their own tools: `screencapture -v` on macOS, `wf-recorder` under Wayland and `ffmpeg` (x11grab) under X11, and `ffmpeg.exe` (gdigrab) on Windows. With none on `PATH`, `sccapture: no screen recorder found (tried wf-recorder)` (or `ffmpeg`, `ffmpeg.exe`), exit 1.

- **The file and its format:** without `-t`, the file's extension picks the format (on macOS, `sccapture` adds `-t` for `.jpg`, `.jpeg`, `.pdf`, `.tiff`, `.gif` and `.bmp`), else PNG. `-c` copies PNG; a file, `-t` and `-P` are then ignored, except on macOS, where `screencapture` decides. Success prints nothing, as `screencapture` does.
- **Videos:** without `-V`, a recording runs until `sccapture` gets `SIGINT` (^C), `SIGTERM` or `SIGHUP`, which stop the tool the way it finalizes the file: `q` on `ffmpeg`'s stdin, `SIGINT` to `wf-recorder` and `screencapture` (whose own stop, any key, works too: it gets `sccapture`'s stdin). `-V` is `ffmpeg`'s `-t`, `screencapture`'s own `-V`, or `SIGINT` to `wf-recorder` after that long. A stopped recording succeeds, exit 0, once the file isn't empty, whatever the tool's exit code; a tool that fails otherwise has its stderr passed through, exit 1. Without `-t` and an extension, it is an MP4 (`-f mp4`, `-m mp4`), and `.webm` gets VP9 from `wf-recorder` (`-c libvpx-vp9`), with Opus audio (`-C libopus`) when it records any. `ffmpeg` gets `-hide_banner -loglevel error -nostats -y`, then its input, the audio inputs, `-t`, `-vf scale=trunc(iw/2)*2:trunc(ih/2)*2 -pix_fmt yuv420p` (so any `-R` plays everywhere), `-f` for `-t` or a file without an extension, and the file. `-P` opens the movie afterwards.
- **`-` (standard output):** the capture goes to a temporary file (`capture.<-t>`, else `capture.png`; `capture.mp4` for a video, `capture.mov` on macOS), which is then copied to stdout and removed. A terminal is `sccapture: refusing to write to a terminal: redirect standard output or name a file`, exit 2, before anything runs; so are `-P` with it (`-P: not with -`) and another file (`-: standard output takes no other file`). A tool that succeeds without writing the file is `sccapture: nothing was captured`, exit 1.
- **A file is required**, as in SLICC (`sccapture: output file required (or use -c for clipboard)`, exit 2), except on macOS with `-p`, `-u`, `-P`, `-M` or `-B`, which `screencapture` handles without one.
- **Errors:** with no tool on `PATH`, `sccapture: no screenshot tool found (tried grim, gnome-screenshot)` (the names tried on that platform) to stderr, exit 1; with `-c` and no clipboard tool, `sccapture: no clipboard tool found (tried wl-copy, xclip)`, exit 1. A tool that fails, a cancelled selection included, has its stderr passed through, exit 1. An unknown option prints `sccapture: unknown option: <arg>` and the usage to stderr, exit 2; an option the table marks as not supported on that platform prints `sccapture: <opt>: not supported on <platform>`, exit 2. The values of `-T`, `-R`, `-D` and `-J` are checked as in SLICC, and `-l` takes a window id in decimal or `0x` hex, else `sccapture: -l: invalid window: <value>`, exit 2. The usage, on errors and as the first line of the help, names only the options the platform takes:

```
usage: sccapture [-abcdgikmoprsuvwxACMPSUW] [-t format] [-T seconds] [-R x,y,w,h] [-D display] [-J style] [-l windowid] [-B bundleid] [-V seconds] [-G id] [file ... | -]
usage: sccapture [-acdgiorsvwxACPW] [-t format] [-T seconds] [-R x,y,w,h] [-J style] [-l windowid] [-V seconds] [-G id] [file | -]
usage: sccapture [-acdmorvxCP] [-t format] [-T seconds] [-R x,y,w,h] [-D display] [-V seconds] [-G id] [file | -]
```

on macOS, Linux and Windows. `-h` and `--help` print the help to stdout and exit 0, as in SLICC: the usage, `Captures the screen with <tool>.`, a line for each option the platform takes, and, on Linux and Windows, `-a, -d, -o, -r, -x`, which do nothing there.
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

Videos, with `-v`:

| option | `wf-recorder` (Wayland) | `ffmpeg` (X11) |
| --- | --- | --- |
| none | `wf-recorder -y -f <file>` | `ffmpeg … -f x11grab -draw_mouse 0 -i $DISPLAY <file>` (`:0` without `DISPLAY`) |
| `-i`, `-s` | `-g <slurp's output>` | `-select_region 1` |
| `-w`, `-W`, `-J window` | not with `wf-recorder` | not with `ffmpeg` |
| `-R x,y,w,h` | `-g "x,y wxh"` | `-video_size wxh -i $DISPLAY+x,y` |
| `-C` | not with `wf-recorder` | `-draw_mouse 1` |
| `-l <windowid>` | not with `wf-recorder` | `-window_id <windowid>` |
| `-g`, `-G <source>` | `-a`, `--audio=<source>` | `-f pulse -i default`, `-f pulse -i <source>` |
| `-A` | `--audio=@DEFAULT_MONITOR@`; not with `-g` or `-G` | `-f pulse -i @DEFAULT_MONITOR@`, mixed with `-g` or `-G` by `amix` |
| `-t` | `-m mp4`, `mov`, `matroska`, `webm`; a WebM gets `-c libvpx-vp9`, and `-C libopus` with audio | `-f mp4`, `mov`, `matroska`, `webm` |

Under Wayland, `grim` needs a compositor with wlr-screencopy (sway, Hyprland and other wlroots ones); elsewhere it fails with its own message, so install `gnome-screenshot` there. `import` and `scrot` aren't tried under Wayland, where they would see only XWayland windows.

### Windows

`sccapture` runs `powershell.exe` (else `pwsh.exe`) with `-NoProfile -NonInteractive -STA -EncodedCommand` and a fixed script; the file name and the option values reach it as data, in `SCCAPTURE_*` environment variables, never as script. (PowerShell reads a script on stdin line by line, as if typed, so a multi-line block in it can stop at the first blank line; `-EncodedCommand` is what slicc-clipboard uses.) The process is made per-monitor DPI-aware first (system DPI-aware before Windows 10 1703), so a scaled display is captured at its real resolution, even when the monitors' scales differ. It copies the virtual screen (every monitor), or the screen `-m`/`-D` names, or the `-R` rectangle of that (its `x,y` from the top left of the virtual screen, or of the screen `-m`/`-D` names), with `Graphics.CopyFromScreen`, draws the cursor for `-C`, and saves with the `-t` format's `ImageFormat`, or `Clipboard.SetImage` for `-c`.

Videos are `ffmpeg.exe -f gdigrab -draw_mouse 0|1 -i desktop`, with `-offset_x x -offset_y y -video_size wxh` for `-R` (from the primary screen's top left, as gdigrab counts), `-f dshow -i audio=<id>` for `-G`, and `-t` for `-V`; `-m` and `-D` are `sccapture: -m: not supported with ffmpeg.exe`, exit 2. `-P` opens the movie afterwards with `Invoke-Item`, through PowerShell, the file as data.

In PowerShell, quote the rectangle: `sccapture -R '0,0,800,600' shot.png`. Unquoted, `0,0,800,600` is an array, which PowerShell passes to any program, `sccapture.ps1` included, as four arguments. In `cmd.exe` no quotes are needed. Run from PowerShell 7, `sccapture` captures through Windows PowerShell with pwsh's `PSModulePath` inherited; CI checks that this works.

### In SLICC, the SLICC commands win

The package has both `bin` and `slicc.commands`, and both name `sccapture`. As with slicc-clipboard, the kernel ignores a package's `bin` entry when the same package declares that name in `slicc.commands`, and bios removes the `$PNPM_HOME/bin` link pnpm makes for it, so the Node script, which SLICC has no Node to run, never shadows the SLICC command.

## `--upgrade`

Every host command takes `--upgrade`. It runs the latest release's installer (`install.sh`, or `install.ps1` on Windows) with `--dir` set to the directory the command is installed in, so the new version replaces the old one in place, then prints `<cmd>: <old> → <new>` (for example `sccapture: 1.2.0 → 1.3.0`), or `<cmd>: already up to date (<version>)`, to stdout and exits 0. If the installer fails, its stderr is passed through and the command exits 1. A command installed with npm prints `npm install -g @ai-ecoverse/slicc-capture@latest` to run instead, and exits 0. In SLICC, `--upgrade` prints `pnpm add -g @ai-ecoverse/slicc-capture@latest` to run, and exits 0; it installs nothing itself. `--upgrade` takes no other arguments.

For slicc-capture, the commands are `sccapture` on a host and `screencapture` and `sccapture` in SLICC. [How `--upgrade` uses it](#how---upgrade-uses-it) has the details. A download that fails prints `sccapture: could not download <url>: <reason>`, one that takes more than 60 seconds `sccapture: download timed out`, and with no `sh` (or PowerShell) it prints `sccapture: no shell found to run install.sh (tried sh)`; each exits 1.

`--version` prints the version (`0.1.0`) to stdout and exits 0, on a host and in SLICC; the installers run the installed command with it and check it reports the version they installed. It takes no other arguments either.

## The installer

This section is the installer contract that slicc-open, slicc-capture, slicc-audio and slicc-man share ([slicc-open#7](https://github.com/ai-ecoverse/slicc-open/issues/7)). [slicc-open](https://github.com/ai-ecoverse/slicc-open)'s `install.sh`, `install.ps1`, `scripts/assets.mjs` and `host/upgrade.mjs` are the reference implementation, and slicc-capture's are copies of them with the names swapped. The names below are written as placeholders; for slicc-capture:

| placeholder | slicc-capture |
| --- | --- |
| `<pkg>` | `slicc-capture` (the npm package is `@ai-ecoverse/<pkg>`, the repo `ai-ecoverse/<pkg>`) |
| `<cmd>` | `sccapture`, each of the package's host commands (its `bin`) |
| `<CMD>` | `SCCAPTURE`, `<cmd>` in upper case with `-` as `_` |

### Release assets

semantic-release's `@semantic-release/npm` packs the package into `release/` (`tarballDir`). `@semantic-release/exec` then runs `node scripts/assets.mjs release <version>`, which refuses (exit 1, leaving `release/` as it was, npm's tarball name included) when the tarball's `package.json` has no `bin` or lacks a file a `bin` entry names, and otherwise renames the tarball to `<pkg>-<version>.tgz`, copies `install.sh` and `install.ps1` next to it, and writes `SHA256SUMS`: one `<sha256>  <name>` line each for the tarball, `install.sh` and `install.ps1`, in that order. `@semantic-release/github` attaches all four files to the release. `ci.yml` needs no release step of its own.

### Options and exit codes

| `install.sh` | `install.ps1` | |
| --- | --- | --- |
| `--version VERSION` (or `--version=VERSION`; a leading `v` is dropped) | `-Version VERSION` | the release to install (default: the latest) |
| `--dir DIR` (or `--dir=DIR`) | `-Dir DIR` | where the launchers go (default: `~/.local/bin`; on Windows `%LOCALAPPDATA%\<pkg>\bin`) |
| `--help` (or `-h`) | `-Help` | print the usage to stdout and exit 0 |

Only the flags select anything: no environment variable stands in for `--version` or `--dir`. `install.sh` handles its options (`--help` and the usage errors included) before it works out any directory, so they work without `HOME`. `HOME` is needed only for the defaults: without it, and without both `--dir` and `XDG_DATA_HOME`, `install.sh` exits 1 with `install.sh: HOME is not set; give --dir and set XDG_DATA_HOME`. `install.sh` exits **0** when it installed, **1** when something failed (a download, a checksum, an archive that doesn't unpack, no Node and no way to get one), with `install.sh: <what>` on stderr, and **2** for an unknown option or a missing value, with the usage on stderr. `install.ps1` exits 0 or 1 the same way when it is run as a file, and its parameters are PowerShell's own, so an unknown one is PowerShell's error. Run through `irm … | iex` or a script block, it prints the error and returns instead of calling `exit`, so it never closes the user's PowerShell. It sets `$PSNativeCommandUseErrorActionPreference = $false` in its own scope, so a caller's `$true` (pwsh 7.4 and later) can't turn the exit code of `node`, `tar` or `npm` into an error that stops the install. It runs `node --version`, `tar` and `npm` with `$ErrorActionPreference = 'Continue'` in a child scope, because Windows PowerShell 5.1 turns each line a native command writes to a redirected stderr into an error, and under `'Stop'` the first one would end the install before its `install.ps1:` message.

### Node

The launchers run the package with Node 24 or later. The installer uses the first `node` on `PATH` when it is new enough, otherwise one it downloaded before, into `<data>/node`. Failing both, it downloads the newest LTS release of 24 or later (or the newest release, when no LTS qualifies) from `index.json`. That download is `node-<version>-<os>-<arch>.tar.gz` (`darwin` or `linux`, `x64` or `arm64`), or `node-<version>-win-<arch>.zip` on Windows, checked against that release's `SHASUMS256.txt`. An archive that doesn't unpack exits 1 with `install.sh: could not unpack node-<version>-<os>-<arch>.tar.gz` (or `install.ps1: could not unpack node-<version>-win-<arch>.zip`), and leaves neither its temporary directory nor a partial `<data>/node` behind. `.tar.gz` is used because `xz` isn't on every minimal Linux. On musl Linux, where nodejs.org has no build, the installer says to install Node with the package manager and exits 1.

### Downloads

| variable | default | |
| --- | --- | --- |
| `SLICC_INSTALL_BASE_URL` | `https://github.com/ai-ecoverse/<pkg>/releases/latest/download`, or `…/releases/download/v<version>` with `--version` | the directory holding the release assets (`SHA256SUMS`, `<pkg>-<version>.tgz`, `install.sh`, `install.ps1`) |
| `SLICC_NODE_DIST_BASE` | `https://nodejs.org/dist` | where `index.json` and `v<version>/SHASUMS256.txt` and the Node archives are |

`install.sh` fetches with `curl`, else `wget` (`curl` also reads the `file://` URLs the tests use), and checks checksums with `sha256sum`, else `shasum -a 256`. `install.ps1` uses `Invoke-WebRequest` and `Get-FileHash`. Without `--version`, the tarball is the `<pkg>-<version>.tgz` named in `SHA256SUMS`, so the version comes from the release itself. A tarball whose checksum doesn't match is refused before anything is unpacked.

### Files

The tarball is unpacked (with `tar`, `%SystemRoot%\System32\tar.exe` on Windows) into a temporary directory next to the versioned data directory `<data>/<version>`. A tarball that doesn't unpack exits 1 with `install.sh: could not unpack <pkg>-<version>.tgz` (or `install.ps1: could not unpack <pkg>-<version>.tgz`) and removes the partial directory. When its `package.json` has a non-empty `dependencies` or `optionalDependencies`, the installer removes `devDependencies` from that copy of `package.json` (npm would still resolve them against the registry, `--omit=dev` or not), then runs `npm install --omit=dev --ignore-scripts --no-audit --no-fund` there. It uses the npm that comes with the Node it picked, run by that Node (`<node dir>/../lib/node_modules/npm`, or `node_modules\npm` next to `node.exe`; `install.sh` falls back to `npm` on `PATH`). npm's output goes to stderr. Without such dependencies the step is skipped, so it needs neither npm nor the network. A failed `npm install`, or a missing npm, exits 1 and removes the partial directory. Only then does the directory replace `<data>/<version>`, so a failed install never leaves a broken version behind. `<data>` is `${XDG_DATA_HOME:-~/.local/share}/<pkg>`, or `%LOCALAPPDATA%\<pkg>` on Windows. Other versions stay where they are, and there is no `current` link. Each launcher names its version's entry script, `<data>/<version>/host/<cmd>.mjs`, and the Node it was installed with, by absolute path.

| platform | launchers in `DIR` | what they do |
| --- | --- | --- |
| macOS, Linux | `<cmd>`, a POSIX sh script | sets and exports `<CMD>_INSTALL_DIR='<DIR>'`, exports `NODE_USE_ENV_PROXY=1` unless it is already set, then `exec '<node>' '<entry>' "$@"`; every path is single-quoted, so no path is ever evaluated |
| Windows | `<cmd>.ps1` (UTF-8 with a BOM) | saves the caller's `$env:<CMD>_INSTALL_DIR` and sets it, sets `$env:NODE_USE_ENV_PROXY = '1'` when it is unset, runs `& '<node.exe>' '<entry>' @sccaptureArgs` in `try`, restores the old `<CMD>_INSTALL_DIR` in `finally` (or removes it when it was unset) and removes a `NODE_USE_ENV_PROXY` it set, then exits with node's exit code. A launcher whose `node.exe` can't start (deleted, or not a program) exits 1: it sets `$global:LASTEXITCODE = $null` before the call and keeps 1 when node left it unset, and a `catch` writes PowerShell's error to stderr with `Write-Error` and keeps 1, so neither the exit code of the caller's previous program nor a caller's `trap { continue }` makes it exit 0. A `.ps1` runs inside the caller's PowerShell session, and this keeps the variable from leaking into that session. `@sccaptureArgs` is `@args` with each array argument (`a,b`) flattened into separate arguments, as PowerShell passes them to a program, and each argument as text. When PowerShell passes arguments to programs the legacy way, which drops empty arguments and doesn't escape `"` (Windows PowerShell 5.1 whatever `$PSNativeCommandArgumentPassing` says, `$PSNativeCommandArgumentPassing = 'Legacy'`, or pwsh before 7.3 without the variable; pwsh 7.3 and later without it pass the standard way), then each `"` becomes `\"` (doubling the backslashes before it), an empty argument becomes `""`, and on Windows PowerShell an argument with whitespace gets its trailing backslashes doubled, so `node.exe` gets the arguments it was given. Since PowerShell reads an unquoted `a,b` as an array, `sccapture -R 0,0,800,600 shot.png` reaches `sccapture` as four arguments, so quote any argument with a comma in it (`sccapture -R '0,0,800,600' shot.png`). It also sets `$PSNativeCommandUseErrorActionPreference = $false` and `$ErrorActionPreference = 'Continue'` in its own scope, so neither a caller's `$true` (pwsh 7.4 and later) nor, on Windows PowerShell 5.1, a caller's `'Stop'` with stderr redirected can turn node's exit code or its stderr into an error |
| Windows | `<cmd>.cmd` (UTF-8, code page 65001 while it runs) | sets `<CMD>_INSTALL_DIR` and, when it is undefined, `NODE_USE_ENV_PROXY=1` (both local to the `.cmd` through `setlocal`), then runs `"<node.exe>" "<entry>" %* & call :done %%ERRORLEVEL%% & call exit /b %%ERRORLEVEL%%` as one line, so a `)` in an argument can't end anything early, and a launcher that `--upgrade` rewrites mid-run is never read again; `:done` restores the code page and returns node's status, and `call exit /b` exits with it explicitly, because a bare `exit /b` leaves the exit code of `cmd /c` (which PowerShell and every other program uses to run a `.cmd`) at 0. A `node.exe` that can't start leaves cmd's own non-zero code (9009 when it is missing). Arguments reach it through cmd's own parsing: `%`, `^`, `&` and `)` are safe inside `"…"`, and a `\"` inside one counts as a quote to cmd, so the quotes in an argument have to pair up |

Both Windows launchers only start `node.exe` with the entry script and the arguments, and `<cmd>` itself never runs `cmd.exe`. `NODE_USE_ENV_PROXY=1` makes Node's `fetch` (and so `--upgrade`) honour `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` the way curl does. On Windows the installer adds `DIR` to the user's `PATH` when it isn't there already, and says so, along with the PowerShell command that removes it again. When `Get-ExecutionPolicy` is `Restricted`, `AllSigned` or `Undefined`, PowerShell won't run `<cmd>.ps1`, so `install.ps1` prints to stderr that `<cmd>` needs `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or `<cmd>.cmd` instead; it never changes the policy itself. elsewhere it prints the `export PATH=…` line to add when `DIR` isn't on `PATH`. After writing the launchers, the installer runs each command's `--version` and requires the version it installed, either alone (`1.2.0`) or in the older `<cmd> 1.2.0` form, so that a `--version` naming an older release still installs. Then it prints `<cmd> <version> installed to <launcher>` to stdout for each command.

### How `--upgrade` uses it

`<CMD>_INSTALL_DIR` is how a command knows the installer put it there. When it is set, `--upgrade` uses Node's `fetch` to download `install.sh` (or `install.ps1` on Windows) from `SLICC_INSTALL_BASE_URL`, or the latest release without it, into a temporary directory. The download has 60 seconds (`AbortSignal.timeout`); after that it prints `<cmd>: download timed out` to stderr and exits 1. It runs `sh install.sh --dir <CMD>_INSTALL_DIR`, or `powershell.exe` (else `pwsh.exe`) `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File install.ps1 -Dir <CMD>_INSTALL_DIR` without `PSModulePath` in its environment, with the installer's stderr passed through. (Run from PowerShell 7, the command inherits pwsh's `PSModulePath`, and Windows PowerShell started with it loses `Get-FileHash`.) The new version is the one in the installer's `<cmd> <version> installed to` line. A download that fails (an HTTP error status prints `<cmd>: could not download <url>: HTTP <status>`, and its body is cancelled, not left open), an installer that exits non-zero or doesn't print that line, or a missing `sh` or PowerShell makes `--upgrade` exit 1. Without `<CMD>_INSTALL_DIR`, the command counts as installed with npm. Commands remove `<CMD>_INSTALL_DIR` from the environment of everything they start.

## Development

```sh
npm install
npm run lint
npm test
npm run test:unit
```

- `npm install` also installs the git hooks into this worktree's own `node_modules/` through slicc-shared-web's `slicc-install-hooks` and the committed `.githooks/`.
- `npm run lint`: Biome, the no-comment check and the other [slicc-shared-web](https://github.com/ai-ecoverse/slicc-shared-web) checks, then `shellcheck -s sh` and `dash -n` on `install.sh` and `bin/*`.
- `npm test`: the integration tests in `test/integration/`. `commands.test.mjs` runs `screencapture` and `sccapture` on `@ai-ecoverse/slicc-kernel/node` (the newest kernel, pinned exactly) with wasm-bash and wasm-coreutils, and a fake `capture.screen` and `clipboard.write` handler (`createNodeKernel({ requests })`): every option's header, the bytes written unchanged, the errnos and their messages, `-c`, `-P`, a streamed video stopped by its end, `SIGINT`, `SIGTERM` and `SIGHUP`, `-` to a pipe and refused on a terminal (`openTerminal`), and slicc-kernel 1.152.2, which has no `/dev/embedder`. `test/integration/repo.test.mjs` checks the workflow, the release config, the pinned devDependencies and what `npm pack` ships. The host tests run `host/` against fake `screencapture`, `grim`, `slurp`, `gnome-screenshot`, `import`, `scrot`, `wf-recorder`, `ffmpeg`, `ffmpeg.exe`, `wl-copy`, `xclip`, `xdg-open`, `powershell.exe` and `pwsh.exe` on a temporary `PATH`, with the signals that stop a recording sent through an injected emitter, and `--upgrade` against installers served from a local HTTP server (a 500 whose body never ends has to be closed within 2 seconds), with the platform forced, so each branch is checked on any machine; only CI touches a real screen. `install.test.mjs` runs `install.sh` on a tarball packed from the tree, with the Node on `PATH` and with a Node download from a fake `nodejs.org`, a truncated tarball and Node archive whose checksums match, and `--upgrade` against a release served from a local directory; `install.ps1` is checked statically, and run when `pwsh` is on `PATH`, also with `$PSNativeCommandUseErrorActionPreference = $true` and `$ErrorActionPreference = 'Stop'` (an install, a failed npm and the launcher's exit 2), and on a truncated tarball, including a `sccapture.ps1` pointed at a `node` that is missing or isn't a program, which must exit 1. `scripts/assets.mjs` has to leave a rejected tarball under npm's name and take one already renamed. On Windows the host tests fake a program with a copy of a small `.exe` that `csc.exe` builds from C# (`fake-windows.mjs`), which runs the fake's script with Node, so the Windows branches run for real; the macOS and Linux branches and the `sh`-based `--upgrade` tests are skipped there.
- `npm run test:windows`: on Windows, the host tests and `windows.test.mjs`, which installs a tarball packed from the tree with `install.ps1` under both Windows PowerShell and `pwsh`, from a local HTTP server into a temporary `-Dir` named `my 'bin' (x86) & 100%`; runs `sccapture.cmd` and `sccapture.ps1` with `--version`, `--help` and a usage error; checks the arguments `node` gets through both launchers (full of `)`, `&`, `%`, `^`, spaces, quotes, trailing backslashes and empty ones, in pwsh's `Standard` and `Legacy` argument passing and with `$PSNativeCommandArgumentPassing` removed, plus a comma list `a,'b c'`, through copies of the launchers that run a script printing its argv), and through them the `SCCAPTURE_*` data a fake `powershell.exe` gets for a file named `a ) & ^ 'f' b.png`; checks that neither launcher leaks `SCCAPTURE_INSTALL_DIR` or `NODE_USE_ENV_PROXY`, that both exit non-zero (the `.ps1` exits 1, after a program that exited 0, for a default, a strict, a `trap { continue }` and a redirected-stderr caller) once the copied `node.exe` they were installed with is replaced by a file that isn't a program and then deleted, that the `.cmd` restores the code page, and that the printed PATH undo works; captures the real screen to a PNG through `sccapture.cmd` (also with pwsh's `PSModulePath`) and through `sccapture.ps1` from Windows PowerShell and from `pwsh`, checked by its magic bytes and its size; installs again with `$PSNativeCommandUseErrorActionPreference = $true` and `$ErrorActionPreference = 'Stop'`, where `sccapture.ps1 --nope` exits 2 and leaves both preferences as they were, and a truncated tarball, with `2>&1`, exits 1 with `could not unpack`; upgrades in place with `--upgrade` from `sccapture.cmd`, `sccapture.ps1` and `pwsh`; and downloads Node as a `.zip` from a fake `nodejs.org`, after refusing a truncated one. CI runs it on `windows-latest` (`windows-test` in `ci.yml`); elsewhere `windows.test.mjs` is skipped.
- `page.test.mjs` registers [the page module](#the-page-module) through `createNodeKernel({ requests })`, with a fake `display` and fake `ImageCapture`, `OffscreenCanvas` and `<video>` injected through `create`, and runs the real `screencapture`: the constraints, the crop, the type and quality, the delay and its progress, an interrupt in the picker and in the delay, **Stop sharing**, the picker's timeout, the errnos and their messages end to end, and that every track is stopped; and, with a fake `MediaRecorder`, `MediaStream`, `AudioContext` and `getUserMedia`, recording: the `mimeType`, `-V`, **Stop sharing**, ^C, the microphone and its mix, a refused or late microphone, a recorder error and a cancelled reply. `browser.test.mjs` runs the module in Chrome, through slicc-shared-web's harness, with a `display` that returns a canvas's `captureStream()`: PNG, JPEG and WebP, the crop, the `<video>` fallback, an abort and the stopped track, and a WebM recorded by the real `MediaRecorder`. It runs on CI only, and is skipped without `CI`.
- `npm run test:unit`: the unit tests in the gitignored `test/unit/`, with coverage in `coverage/unit/lcov.info`. `npm run test:sh` runs the `test/unit/*.sh.mjs` ones, which trace `bin/` with `set -x` in the node kernel, and writes `coverage/sh/lcov.info`. The pre-commit hook wants 100% coverage of the changed lines of both, and runs `diff-cover` through `uvx`, so install [uv](https://docs.astral.sh/uv/) once.

CI is `.github/workflows/ci.yml`, the only workflow, which runs [slicc-shared-web's pipeline](https://github.com/ai-ecoverse/slicc-shared-web#pipeline) at the devDependency's version: `npm run lint`, then `npm test`, and on a pull request and in the merge queue `npm run test:windows` on `windows-latest`, then on a pull request the Claude and Codex reviews. The merge queue requires `ci / integration` and `ci / review`. On a push to `main`, semantic-release releases and publishes to npm through trusted publishing, with provenance from `ci.yml`, and attaches the installers.

## License

Apache-2.0
