import { extname, resolve } from 'node:path';
import { lookup, record, say, step } from './tools.mjs';

const extensions = {
  '.jpg': 'jpg',
  '.jpeg': 'jpg',
  '.pdf': 'pdf',
  '.tiff': 'tiff',
  '.gif': 'gif',
  '.bmp': 'bmp',
};

export async function darwin({ parsed, o, env, platform, fds, signals }) {
  const path = lookup('screencapture', platform, env);
  if (!path) {
    say(fds[2], 'sccapture: no screenshot tool found (tried screencapture)\n');
    return 1;
  }
  const args = [...parsed.tokens];
  if (o.last.V && !o.last.v) args.unshift('-v');
  const type =
    !o.video &&
    !o.last.t &&
    parsed.files.length &&
    extensions[extname(parsed.files[0]).toLowerCase()];
  if (type) args.push('-t', type);
  if (parsed.files.some((file) => file.startsWith('-'))) args.push('--');
  args.push(...parsed.files);
  if (!o.video) return (await step('screencapture', path, args, { env }, fds)) ? 0 : 1;
  const file = parsed.files[0] && resolve(parsed.files[0]);
  const options = { env, stdin: fds[0], stop: 'SIGINT', file, signals };
  return (await record('screencapture', path, args, options, fds)) ? 0 : 1;
}
