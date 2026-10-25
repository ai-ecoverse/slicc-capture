import { spawn } from 'node:child_process';
import { accessSync, constants, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export function say(fd, text) {
  writeSync(fd, text);
}

function runnable(path, platform) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function dirs(platform, env) {
  const path = (platform === 'win32' ? (env.PATH ?? env.Path) : env.PATH) ?? '';
  return path.split(platform === 'win32' ? ';' : ':').filter(Boolean);
}

export function lookup(file, platform, env) {
  for (const dir of dirs(platform, env)) {
    if (runnable(join(dir, file), platform)) return join(dir, file);
  }
  return undefined;
}

export function spawned(path, args, { env, stdin = 'ignore', capture = false }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(path, args, {
        env: { ...env, SCCAPTURE_INSTALL_DIR: undefined },
        stdio: [stdin, capture ? 'pipe' : 'ignore', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      resolve({ error });
      return;
    }
    const out = [];
    const errors = [];
    let code;
    let outClosed = !capture;
    let errClosed = false;
    const settle = () => {
      if (code === undefined || !outClosed) return;
      if (code === 0) {
        child.stderr.destroy();
        resolve({ code, stdout: Buffer.concat(out).toString('utf8') });
      } else if (errClosed) resolve({ code, stderr: Buffer.concat(errors) });
    };
    if (capture) {
      child.stdout.on('data', (chunk) => out.push(chunk));
      child.stdout.on('close', () => {
        outClosed = true;
        settle();
      });
    }
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.stderr.on('close', () => {
      errClosed = true;
      settle();
    });
    child.on('error', (error) => resolve({ error }));
    child.on('exit', (status) => {
      code = status ?? 1;
      settle();
    });
  });
}

export async function step(name, path, args, options, fds) {
  const result = await spawned(path, args, options);
  if (result.error) {
    say(fds[2], `sccapture: ${name}: ${result.error.message}\n`);
    return undefined;
  }
  if (result.code === 0) return result;
  if (result.stderr.length) say(fds[2], result.stderr);
  else say(fds[2], `sccapture: ${name} failed\n`);
  return undefined;
}

const stops = ['SIGINT', 'SIGTERM', 'SIGHUP'];

export function record(name, path, args, options, fds) {
  const { env, stdin = 'ignore', stop, file, duration, wait, signals } = options;
  return new Promise((resolve) => {
    const child = spawn(path, args, {
      env: { ...env, SCCAPTURE_INSTALL_DIR: undefined },
      stdio: [stop === 'q' ? 'pipe' : stdin, 'ignore', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let halted = false;
    const halt = () => {
      if (halted) return;
      halted = true;
      if (stop === 'q') child.stdin.end('q');
      else child.kill('SIGINT');
    };
    child.stdin?.on('error', () => {});
    const timer = new AbortController();
    const done = () => {
      timer.abort();
      for (const signal of stops) signals.off(signal, halt);
    };
    for (const signal of stops) signals.on(signal, halt);
    if (duration !== undefined && stop !== 'q') wait(duration, timer.signal).then(halt, () => {});
    const errors = [];
    child.stderr.on('data', (chunk) => errors.push(chunk));
    let failed = false;
    child.on('error', (error) => {
      failed = true;
      done();
      say(fds[2], `sccapture: ${name}: ${error.message}\n`);
      resolve(false);
    });
    child.on('close', (code) => {
      done();
      if (failed) return;
      if (code === 0 || (halted && written(file))) {
        resolve(true);
        return;
      }
      const stderr = Buffer.concat(errors);
      say(fds[2], stderr.length ? stderr : `sccapture: ${name} failed\n`);
      resolve(false);
    });
  });
}

export function written(file) {
  try {
    return statSync(file).size > 0;
  } catch {
    return false;
  }
}
