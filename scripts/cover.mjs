import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'coverage/sh');
const traces = join(out, 'traces');

const skip = [
  /^\s*$/,
  /^#!/,
  /^\s*(\}|fi|done|esac|;;|else|then|do|:)(\s*<\S+)?\s*$/,
  /^\s*[\w-]+\(\)\s*\{\s*$/,
  /^\s*[^()]+\)\s*(;;)?\s*$/,
];

function executable(source) {
  const lines = [];
  source.split('\n').forEach((text, index) => {
    if (!skip.some((pattern) => pattern.test(text))) lines.push(index + 1);
  });
  return lines;
}

function hits(trace, name) {
  const counts = new Map();
  for (const line of trace.split('\n')) {
    const match = /^\++([\w.-]+):(\d+):/.exec(line);
    if (match && match[1] === name) {
      const at = Number(match[2]);
      counts.set(at, (counts.get(at) ?? 0) + 1);
    }
  }
  return counts;
}

function main() {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(traces, { recursive: true });
  const tests = join(root, 'test/unit');
  const files = readdirSync(tests)
    .filter((name) => name.endsWith('.sh.mjs'))
    .map((name) => join(tests, name));
  const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, SLICC_CAPTURE_TRACE: traces },
  });
  const bin = join(root, 'bin');
  const all = readdirSync(traces).map((file) => readFileSync(join(traces, file), 'utf8'));
  let text = '';
  for (const name of readdirSync(bin)) {
    const counts = new Map();
    for (const trace of all) {
      for (const [line, count] of hits(trace, name)) {
        counts.set(line, (counts.get(line) ?? 0) + count);
      }
    }
    const lines = executable(readFileSync(join(bin, name), 'utf8'));
    const missed = lines.filter((line) => !counts.get(line));
    text += `SF:bin/${name}\n`;
    for (const line of lines) text += `DA:${line},${counts.get(line) ?? 0}\n`;
    text += `LF:${lines.length}\nLH:${lines.length - missed.length}\nend_of_record\n`;
    console.log(
      `${name}: ${lines.length - missed.length}/${lines.length}${missed.length ? ` missed ${missed.join(',')}` : ''}`
    );
  }
  writeFileSync(join(out, 'lcov.info'), text);
  process.exit(run.status ?? 1);
}

main();
