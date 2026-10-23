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

In SLICC, the package declares `screencapture` and `sccapture` in `slicc.commands`, so installing it puts both in `/usr/bin`:

```sh
pnpm add -g @ai-ecoverse/slicc-capture
```

On macOS and Linux:

```sh
curl -fsSL https://get.sliccy.ai/slicc-capture | sh
```

On Windows, in PowerShell:

```powershell
irm https://get.sliccy.ai/slicc-capture.ps1 | iex
```

Or, on any machine with Node 24 or later:

```sh
npm install -g @ai-ecoverse/slicc-capture
```

or without installing, `npx -p @ai-ecoverse/slicc-capture sccapture shot.png`.

### The installers

Each release attaches `install.sh` and `install.ps1` next to the package tarball, `slicc-capture-<version>.tgz`, and a `SHA256SUMS` that lists all three. The PR that adds the installers also adds them, the tarball and `SHA256SUMS` to `@semantic-release/github`'s `assets` in `.releaserc.json`, with a test in `test/integration/repo.test.mjs`, so no release ships without them. get.sliccy.ai serves the latest release's installers. Both work like mcpcat's `install.sh`:

- **Options:** `--version <version>` installs that release instead of the latest; `--dir <dir>` puts the launcher there instead of the default; `--help` prints the usage and exits 0. An unknown option prints `slicc-capture: unknown option: <arg>` to stderr and exits 1. The environment variables `VERSION` and `INSTALL_DIR` do the same as the options. Through a pipe, `sh -s -- --dir ~/bin` passes options to `install.sh`, and `& ([scriptblock]::Create((irm https://get.sliccy.ai/slicc-capture.ps1))) --dir C:\tools` to `install.ps1`.
- **Node 24 or later:** the `node` on `PATH` if it is new enough, else the one the installer downloaded before; else it downloads the current Node LTS from nodejs.org, checks it against that release's `SHASUMS256.txt`, and keeps it in the data directory. On musl Linux, where nodejs.org has no build, it says to install Node with the package manager and exits 1.
- **Where it goes:** the tarball is checked against `SHA256SUMS`, unpacked into `<data>/<version>`, and `<data>/current` points at it. `<data>` is `${XDG_DATA_HOME:-~/.local/share}/slicc-capture` on macOS and Linux, `%LOCALAPPDATA%\slicc-capture` on Windows. The launcher, `sccapture` (`sccapture.cmd` on Windows), goes into `~/.local/bin` (`%LOCALAPPDATA%\slicc-capture\bin` on Windows) and runs that Node on `<data>/<version>/host/sccapture.mjs`, so the launcher keeps working when the `node` on `PATH` changes.
- **Output:** `sccapture <version> installed to <launcher>`, and, when the directory isn't on `PATH`, the line that adds it. Any failure (no `curl` or `wget`, a checksum mismatch, an unsupported OS or architecture) is one line on stderr and exit 1; on an unsupported OS it names `npm install -g @ai-ecoverse/slicc-capture` instead.

The get.sliccy.ai entries for `slicc-capture` and `slicc-capture.ps1` are added once the first release is out.

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

`screencapture file` asks seven's page to capture. `getDisplayMedia` needs a user gesture, so the page first shows a prompt, `screencapture wants to capture your screen`, with **Choose…** and **Cancel**; **Choose…** opens Chrome's picker. After the user picks, the command waits for `-T` seconds, if given, takes one frame, crops it to `-R`, if given, encodes it and stops the capture.

- **The file:** written as PNG, JPEG or WebP: `-t` decides, else the file's extension (`.png`, `.jpg` or `.jpeg`, `.webp`), else PNG. JPEG and WebP use quality 0.92. On success it prints `captured <n> KB to <file>`.
- **`-c`:** copies the capture to the clipboard as `image/png`, through [slicc-clipboard](https://github.com/ai-ecoverse/slicc-clipboard), and prints `captured <n> KB to clipboard`. A file named with `-c` is ignored, as with macOS's `-c`, and so is `-t`. slicc-clipboard's device is text only today; `-c` needs its image path, which is being added there.
- **`-v`:** shows the capture inline in the agent's tool result. With a file, it writes the file and prints `<path> (<n> KB)` followed by the image; without one, it prints only the image; with `-c`, it copies and shows. slicc 6 printed the image as `<img:data:<type>;base64,<data>>`; seven's marker for an inline image is being agreed with slicc-agent, and `-v` uses whatever that is. macOS's `-v` (record a video) is out of scope everywhere.
- **No file:** without a file, `-c` or `-v`: `screencapture: output file required (or use -c for clipboard)` and the usage to stderr, exit 2.

Errors, on stderr, from slicc 6 where they still apply:

| error | exit |
| --- | --- |
| `screencapture: user cancelled or permission denied` (**Cancel**, the picker closed, or the capture refused) | 1 |
| `screencapture: timed out waiting for the picker` (no answer within 5 minutes) | 1 |
| `screencapture: browser APIs are unavailable in this environment` (an embedder that doesn't answer capture requests) | 1 |
| `screencapture: screen capture is not supported in this browser` (no `getDisplayMedia`) | 1 |
| `screencapture: -R: rectangle outside the capture` | 1 |
| `screencapture: failed to write file: <message>` | 1 |
| `screencapture: failed to copy to clipboard: <message>` | 1 |
| `screencapture: unknown option: <arg>`, then the usage | 2 |
| `screencapture: <opt>: not supported in SLICC` | 2 |
| `screencapture: -t <format>: not supported in SLICC` | 2 |
| `screencapture: -T: invalid delay: <value>`, `-R: invalid rectangle: <value>`, `-D: invalid display: <value>`, `-J: invalid style: <value>` | 2 |
| `screencapture: more than one file: not supported in SLICC` | 2 |

As `sccapture`, the messages start with `sccapture:`.

**The bridge from the kernel to the page is not settled yet.** The commands run in a kernel worker, which has no `getDisplayMedia`, so a request has to reach seven's page and the frame has to come back. slicc-clipboard does this with a kernel character device that the kernel answers from its embedder's hook; slicc-open, slicc-capture and slicc-audio are agreeing one pattern for all three in [ai-ecoverse/slicc-kernel#1527](https://github.com/ai-ecoverse/slicc-kernel/issues/1527) (pending), with the kernel and seven's embedder (slicc-bios). Until then this section describes only what the user sees. The page side (the prompt, `getDisplayMedia`, the frame, the crop and the encoding) ships in this package for the embedder; its entry point, the transport and the `engines.slicc-kernel` it needs are added here once the pattern is agreed.

### Options

Every option of macOS's `screencapture`, and what it does in SLICC and with `sccapture` on each host. On macOS, `sccapture` passes the options through to `screencapture` unchanged, except the ones the macOS column names. "No-op" means the option is accepted and changes nothing. "Not supported" means `<cmd>: <opt>: not supported in SLICC` (or `on Linux`, `on Windows`, `on macOS`) on stderr, exit 2, before anything is captured; "not with `<tool>`" means `sccapture: <opt>: not supported with <tool>`, exit 2, when no tool on `PATH` supports every option given (it names the first one tried).

| option | macOS `screencapture` | SLICC | macOS `sccapture` | Linux `sccapture` | Windows `sccapture` |
| --- | --- | --- | --- | --- | --- |
| `-a` | don't capture attached windows | no-op | passed | no-op | no-op |
| `-b` | capture the Touch Bar | not supported | passed | not supported | not supported |
| `-B <bundleid>` | open in that app | not supported | passed | not supported | not supported |
| `-c` | to the clipboard | through slicc-clipboard, as `image/png` | passed | see [Linux](#linux) | `Clipboard.SetImage` |
| `-C` | include the cursor | asks for `cursor: 'always'` (else `'never'`), which the browser may not honour | passed | see [Linux](#linux) | draws the cursor into the image |
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
| `-v` | record a video | inline in the tool result (slicc 6's `-v`) | not supported | not supported | not supported |
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
- **`--upgrade`:** the command counts as installed by the installer when it runs from `<data>/<version>/host/sccapture.mjs` with a `<data>/current` next to it, and as installed with npm otherwise. `--dir` is the directory on `PATH` whose `sccapture` (`sccapture.cmd` on Windows) names `<data>`, else the installer's default. It downloads the installer with `curl`, else `wget` (`curl.exe` on Windows), and without one prints `sccapture: no downloader found (tried curl, wget)`, exit 1; a failed download has its stderr passed through, exit 1. The installer runs with `sh` (`powershell.exe`, else `pwsh.exe`, with `-ExecutionPolicy Bypass -File` on Windows), without `VERSION` and `INSTALL_DIR` in its environment, so it installs the latest release where the command is; the new version is read from `<data>/current/package.json`.
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
| `-t png`, `jpg` | `-t png`, `-t jpeg` | `png` only, else not with `gnome-screenshot` | `png:<file>`, `jpg:<file>` | by the file's extension; a `-t` that differs from it is not with `scrot` |

Under Wayland, `grim` needs a compositor with wlr-screencopy (sway, Hyprland and other wlroots ones); elsewhere it fails with its own message, so install `gnome-screenshot` there. `import` and `scrot` aren't tried under Wayland, where they would see only XWayland windows.

### Windows

`sccapture` runs `powershell.exe` (else `pwsh.exe`) with `-NoProfile -NonInteractive -STA -EncodedCommand` and a fixed script; the file name and the option values reach it as data, in `SCCAPTURE_*` environment variables, never as script. (PowerShell reads a script on stdin line by line, as if typed, so a multi-line block in it can stop at the first blank line; `-EncodedCommand` is what slicc-clipboard uses.) The process is made DPI-aware first, so a scaled display is captured at its real resolution. It copies the virtual screen (every monitor), or the screen `-m`/`-D` names, or the `-R` rectangle of that (its `x,y` from the top left of the virtual screen, or of the screen `-m`/`-D` names), with `Graphics.CopyFromScreen`, draws the cursor for `-C`, and saves with the `-t` format's `ImageFormat`, or `Clipboard.SetImage` for `-c`.

### In SLICC, the SLICC commands win

The package has both `bin` and `slicc.commands`, and both name `sccapture`. As with slicc-clipboard, the kernel ignores a package's `bin` entry when the same package declares that name in `slicc.commands`, and bios removes the `$PNPM_HOME/bin` link pnpm makes for it, so the Node script, which SLICC has no Node to run, never shadows the SLICC command.

## `--upgrade`

Every host command takes `--upgrade`. It runs the latest release's installer (`install.sh`, or `install.ps1` on Windows) with `--dir` set to the directory the command is installed in, so the new version replaces the old one in place, then prints `<cmd>: <old> → <new>` (for example `sccapture: 1.2.0 → 1.3.0`), or `<cmd>: already up to date (<version>)`, to stdout and exits 0. If the installer fails, its stderr is passed through and the command exits 1. A command installed with npm prints `npm install -g @ai-ecoverse/slicc-capture@latest` to run instead, and exits 0. In SLICC, `--upgrade` prints `pnpm add -g @ai-ecoverse/slicc-capture@latest` to run, and exits 0; it installs nothing itself. `--upgrade` takes no other arguments.

For slicc-capture, the commands are `sccapture` on a host and `screencapture` and `sccapture` in SLICC.

`--version` prints the version (`0.1.0`) to stdout and exits 0, on a host and in SLICC; the installers call the launcher with it. It takes no other arguments either.

## Development

```sh
npm install
npm run lint
npm test
npm run test:unit
```

- `npm install` also installs the git hooks into this worktree's own `node_modules/` through slicc-shared-web's `slicc-install-hooks` and the committed `.githooks/`.
- `npm run lint`: Biome, the no-comment check and the other [slicc-shared-web](https://github.com/ai-ecoverse/slicc-shared-web) checks.
- `npm test`: the integration tests in `test/integration/`. `test/integration/repo.test.mjs` checks the workflow, the release config, the pinned devDependencies and what `npm pack` ships. The host tests run `host/` against fake `screencapture`, `grim`, `slurp`, `gnome-screenshot`, `import`, `scrot`, `wl-copy`, `xclip`, `xdg-open`, `powershell.exe`, `pwsh.exe`, `curl`, `wget` and a fake installer on a temporary `PATH`, with the platform forced, so each branch is checked on any machine; only CI touches a real screen.
- `npm run test:unit`: the unit tests in the gitignored `test/unit/`, with coverage in `coverage/unit/lcov.info`. The pre-commit hook wants 100% coverage of the changed lines, and runs `diff-cover` through `uvx`, so install [uv](https://docs.astral.sh/uv/) once.

CI is `.github/workflows/ci.yml`, the only workflow, which runs [slicc-shared-web's pipeline](https://github.com/ai-ecoverse/slicc-shared-web#pipeline) at the devDependency's version: `npm run lint`, then `npm test`, then on a pull request the Claude and Codex reviews. The merge queue requires `ci / integration` and `ci / review`. On a push to `main`, semantic-release releases and publishes to npm through trusted publishing, with provenance from `ci.yml`, and attaches the installers.

## License

Apache-2.0
