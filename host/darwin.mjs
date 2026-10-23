import { extname } from 'node:path';
import { lookup, say, step } from './tools.mjs';

const extensions = {
  '.jpg': 'jpg',
  '.jpeg': 'jpg',
  '.pdf': 'pdf',
  '.tiff': 'tiff',
  '.gif': 'gif',
  '.bmp': 'bmp',
};

export async function darwin({ parsed, o, env, platform, fds }) {
  const path = lookup('screencapture', platform, env);
  if (!path) {
    say(fds[2], 'sccapture: no screenshot tool found (tried screencapture)\n');
    return 1;
  }
  const args = [...parsed.tokens];
  const type =
    !o.last.t && parsed.files.length && extensions[extname(parsed.files[0]).toLowerCase()];
  if (type) args.push('-t', type);
  if (parsed.files.some((file) => file.startsWith('-'))) args.push('--');
  args.push(...parsed.files);
  return (await step('screencapture', path, args, { env }, fds)) ? 0 : 1;
}
