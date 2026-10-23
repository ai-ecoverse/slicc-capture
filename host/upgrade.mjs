import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { dirs, lookup, say, step } from './tools.mjs';

const base = 'https://github.com/ai-ecoverse/slicc-capture/releases/latest/download';

function version(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
}

function home(platform, env) {
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? homedir(), 'slicc-capture');
  return join(env.XDG_DATA_HOME || join(env.HOME ?? homedir(), '.local', 'share'), 'slicc-capture');
}

function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function launcher(platform, env, data) {
  const fallback =
    platform === 'win32'
      ? join(home(platform, env), 'bin')
      : join(env.HOME ?? homedir(), '.local', 'bin');
  const name = platform === 'win32' ? 'sccapture.cmd' : 'sccapture';
  const marks = [data];
  if (real(home(platform, env)) === data) marks.push(home(platform, env));
  for (const dir of [...dirs(platform, env), fallback]) {
    let text;
    try {
      text = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    if (marks.some((mark) => text.includes(mark))) return dir;
  }
  return fallback;
}

export function installed(entry) {
  const data = dirname(dirname(dirname(real(entry))));
  if (basename(data) !== 'slicc-capture' || !existsSync(join(data, 'current'))) return undefined;
  return data;
}

export async function upgrade({ entry, env, platform, fds }) {
  const root = dirname(dirname(entry));
  const old = version(root);
  const data = installed(entry);
  if (!data) {
    say(fds[1], 'npm install -g @ai-ecoverse/slicc-capture@latest\n');
    return 0;
  }
  const windows = platform === 'win32';
  const getters = windows ? ['curl.exe'] : ['curl', 'wget'];
  const getter = getters
    .map((name) => ({ name, path: lookup(name, platform, env) }))
    .find((g) => g.path);
  if (!getter) {
    say(fds[2], `sccapture: no downloader found (tried ${getters.join(', ')})\n`);
    return 1;
  }
  const shells = windows ? ['powershell.exe', 'pwsh.exe'] : ['sh'];
  const shell =
    shells.map((name) => lookup(name, platform, env)).find(Boolean) ??
    (windows ? undefined : '/bin/sh');
  if (!shell) {
    say(fds[2], `sccapture: no PowerShell found (tried ${shells.join(', ')})\n`);
    return 1;
  }
  const child = {};
  for (const [key, value] of Object.entries(env)) {
    if (!['VERSION', 'INSTALL_DIR'].includes(key.toUpperCase())) child[key] = value;
  }
  const scratch = mkdtempSync(join(tmpdir(), 'sccapture-upgrade-'));
  try {
    const name = windows ? 'install.ps1' : 'install.sh';
    const script = join(scratch, name);
    const url = `${base}/${name}`;
    const fetch = getter.name === 'wget' ? ['-q', '-O', script, url] : ['-fsSL', '-o', script, url];
    if (!(await step(getter.name, getter.path, fetch, { env: child }, fds))) return 1;
    const dir = launcher(platform, env, data);
    const args = windows
      ? [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
          '--dir',
          dir,
        ]
      : [script, '--dir', dir];
    if (!(await step(name, shell, args, { env: child }, fds))) return 1;
    const now = version(join(data, 'current'));
    say(
      fds[1],
      now === old ? `sccapture: already up to date (${old})\n` : `sccapture: ${old} → ${now}\n`
    );
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
