import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { lookup, say } from './tools.mjs';

const latest = 'https://github.com/ai-ecoverse/slicc-capture/releases/latest/download';

function fail(fds, text) {
  say(fds[2], `sccapture: ${text}\n`);
  return 1;
}

function version(entry) {
  return JSON.parse(readFileSync(join(dirname(dirname(entry)), 'package.json'), 'utf8')).version;
}

async function download(url) {
  try {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    return { text: await response.text() };
  } catch (error) {
    return { error: error.cause?.message ?? error.message };
  }
}

function first(files, platform, env) {
  for (const file of files) {
    const path = lookup(file, platform, env);
    if (path) return { file, path };
  }
  return undefined;
}

function installer(platform, env, path, dir) {
  if (platform === 'win32') {
    const tool = first(['powershell.exe', 'pwsh.exe'], platform, env);
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path];
    return tool && { tool, args: [...args, '-Dir', dir] };
  }
  const tool = first(['sh'], platform, env);
  return tool && { tool, args: [path, '--dir', dir] };
}

function wait(path, args, { env, stderr }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(path, args, {
        env,
        stdio: ['ignore', 'pipe', stderr],
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      resolve({ error });
      return;
    }
    const out = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.on('error', (error) => resolve({ error }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out) }));
  });
}

export async function upgrade({ entry, env, platform, fds }) {
  const dir = env.SCCAPTURE_INSTALL_DIR;
  if (!dir) {
    say(fds[1], 'npm install -g @ai-ecoverse/slicc-capture@latest\n');
    return 0;
  }
  const name = platform === 'win32' ? 'install.ps1' : 'install.sh';
  const url = `${(env.SLICC_INSTALL_BASE_URL || latest).replace(/\/+$/, '')}/${name}`;
  const fetched = await download(url);
  if (fetched.error) return fail(fds, `could not download ${url}: ${fetched.error}`);
  const scratch = mkdtempSync(join(tmpdir(), 'sccapture-upgrade-'));
  try {
    const path = join(scratch, name);
    writeFileSync(path, fetched.text);
    const run = installer(platform, env, path, dir);
    if (!run) {
      const tried = platform === 'win32' ? 'powershell.exe, pwsh.exe' : 'sh';
      return fail(fds, `no shell found to run ${name} (tried ${tried})`);
    }
    const child = { ...env };
    delete child.SCCAPTURE_INSTALL_DIR;
    const result = await wait(run.tool.path, run.args, { env: child, stderr: fds[2] });
    if (result.error) return fail(fds, `${run.tool.file}: ${result.error.message}`);
    if (result.code !== 0) return 1;
    const installed = /^sccapture (\S+) installed to /m.exec(result.stdout.toString())?.[1];
    if (!installed) return fail(fds, `${name} did not say which version it installed`);
    const old = version(entry);
    say(
      fds[1],
      installed === old
        ? `sccapture: already up to date (${old})\n`
        : `sccapture: ${old} → ${installed}\n`
    );
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
