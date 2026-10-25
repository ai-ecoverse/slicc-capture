import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { darwin } from './darwin.mjs';
import { linux } from './linux.mjs';
import { check, help, names, parse, settings, usage } from './options.mjs';
import { say } from './tools.mjs';
import { upgrade } from './upgrade.mjs';
import { windows } from './windows.mjs';

const optional = 'puPMB';

export async function run({
  argv = process.argv.slice(2),
  env = process.env,
  platform = process.platform,
  fds = [0, 1, 2],
  entry = fileURLToPath(new URL('sccapture.mjs', import.meta.url)),
  wait = (seconds) => setTimeout(seconds * 1000),
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
  if (os === 'darwin') return darwin({ parsed, o, env, platform: os, fds });
  if (parsed.files.length > 1 && !o.clipboard) {
    say(fds[2], `sccapture: more than one file: not supported on ${names[os]}\n`);
    return 2;
  }
  const file = parsed.files.length ? resolve(parsed.files[0]) : undefined;
  const context = { o, file, env, platform: os, fds, wait };
  return os === 'win32' ? windows(context) : linux(context);
}
