import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { isatty } from 'node:tty';
import { fileURLToPath } from 'node:url';
import { darwin } from './darwin.mjs';
import { linux } from './linux.mjs';
import { check, help, names, parse, settings, usage } from './options.mjs';
import { say, written } from './tools.mjs';
import { upgrade } from './upgrade.mjs';
import { windows } from './windows.mjs';

const optional = 'puPMB';

export async function run({
  argv = process.argv.slice(2),
  env = process.env,
  platform = process.platform,
  fds = [0, 1, 2],
  entry = fileURLToPath(new URL('sccapture.mjs', import.meta.url)),
  wait = (seconds, signal) => setTimeout(seconds * 1000, undefined, { signal }),
  signals = process,
  tty = isatty,
  timeout = 60000,
} = {}) {
  const os = names[platform] ? platform : 'linux';
  const parsed = parse(argv);
  if (parsed.help) {
    say(fds[1], help(os));
    return 0;
  }
  if (parsed.error) {
    say(fds[2], `sccapture: ${parsed.error}\n${usage(os)}`);
    return 2;
  }
  if (parsed.special.length) {
    if (argv.length > 1) {
      say(fds[2], `sccapture: ${parsed.special[0]}: takes no other arguments\n${usage(os)}`);
      return 2;
    }
    if (parsed.special[0] === '--upgrade')
      return upgrade({ entry, env, platform: os, fds, timeout });
    const pkg = JSON.parse(readFileSync(join(dirname(dirname(entry)), 'package.json'), 'utf8'));
    say(fds[1], `${pkg.version}\n`);
    return 0;
  }
  const problem = check(parsed.options, os);
  if (problem) {
    say(fds[2], `sccapture: ${problem}\n`);
    return 2;
  }
  const o = settings(parsed.options);
  const free = os === 'darwin' && parsed.options.some((option) => optional.includes(option.letter));
  if (!parsed.files.length && !o.clipboard && !free) {
    say(fds[2], `sccapture: output file required (or use -c for clipboard)\n${usage(os)}`);
    return 2;
  }
  if (os !== 'darwin' && parsed.files.length > 1 && !o.clipboard) {
    say(fds[2], `sccapture: more than one file: not supported on ${names[os]}\n`);
    return 2;
  }
  const context = { parsed, o, env, platform: os, fds, wait, signals };
  if (o.clipboard || !parsed.files.includes('-')) return capture(context);
  const refusal = piping(parsed, o, fds, tty);
  if (refusal) {
    say(fds[2], `sccapture: ${refusal}\n`);
    return 2;
  }
  const scratch = mkdtempSync(join(tmpdir(), 'sccapture-'));
  const ext = o.type ?? (o.video ? (os === 'darwin' ? 'mov' : 'mp4') : 'png');
  const file = join(scratch, `capture.${ext}`);
  try {
    const code = await capture({ ...context, parsed: { ...parsed, files: [file] } });
    if (code !== 0) return code;
    if (!written(file)) {
      say(fds[2], 'sccapture: nothing was captured\n');
      return 1;
    }
    pour(file, fds[1]);
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function piping(parsed, o, fds, tty) {
  if (parsed.files.length > 1) return '-: standard output takes no other file';
  if (o.open) return `${o.last.P.label}: not with -`;
  if (tty(fds[1]))
    return 'refusing to write to a terminal: redirect standard output or name a file';
  return undefined;
}

function put(fd, chunk) {
  let at = 0;
  while (at < chunk.length) {
    try {
      at += writeSync(fd, chunk, at, chunk.length - at);
    } catch (error) {
      if (error.code !== 'EAGAIN') throw error;
    }
  }
}

function pour(file, fd) {
  const source = openSync(file, 'r');
  const chunk = Buffer.alloc(1 << 20);
  try {
    for (let n = readSync(source, chunk); n > 0; n = readSync(source, chunk)) {
      put(fd, chunk.subarray(0, n));
    }
  } finally {
    closeSync(source);
  }
}

function capture(context) {
  const { parsed, platform } = context;
  if (platform === 'darwin') return darwin(context);
  const file = parsed.files.length ? resolve(parsed.files[0]) : undefined;
  const run = { ...context, file };
  return platform === 'win32' ? windows(run) : linux(run);
}
