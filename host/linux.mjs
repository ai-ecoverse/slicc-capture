import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { lookup, say, step } from './tools.mjs';

const extensions = { '.png': 'png', '.jpg': 'jpg', '.jpeg': 'jpg' };

const builders = {
  grim(o, file) {
    if (o.window) return { unsupported: o.windowLabel };
    if (o.id) return { unsupported: '-l' };
    const args = o.cursor ? ['-c'] : [];
    const type = o.type ?? extensions[extname(file).toLowerCase()];
    if (o.type === 'png') args.push('-t', 'png');
    else if (type === 'jpg') args.push('-t', 'jpeg');
    if (o.rect) {
      const [x, y, w, h] = o.rect;
      args.push('-g', `${x},${y} ${w}x${h}`);
    }
    return { args: [...args, file], slurp: o.select && !o.rect };
  },
  'gnome-screenshot'(o, file) {
    if (o.window) return { unsupported: o.windowLabel };
    if (o.rect) return { unsupported: '-R' };
    if (o.id) return { unsupported: '-l' };
    if (o.type && o.type !== 'png') return { unsupported: `-t ${o.last.t.value}` };
    const args = [];
    if (o.select) args.push('-a');
    if (o.cursor) args.push('-p');
    return { args: [...args, '-f', file] };
  },
  import(o, file) {
    if (o.cursor) return { unsupported: '-C' };
    const args = [];
    if (o.id) args.push('-window', o.id);
    else if (!o.select && !o.window) args.push('-window', 'root');
    if (o.rect) {
      const [x, y, w, h] = o.rect;
      args.push('-crop', `${w}x${h}+${x}+${y}`, '+repage');
    }
    return { args: [...args, o.type ? `${o.type}:${file}` : file] };
  },
  scrot(o, file) {
    if (o.id) return { unsupported: '-l' };
    if (o.type && extensions[extname(file).toLowerCase()] !== o.type) {
      return { unsupported: `-t ${o.last.t.value}` };
    }
    const args = [];
    if (o.select || o.window) args.push('-s');
    if (o.rect) args.push('-a', o.rect.join(','));
    if (o.cursor) args.push('-p');
    return { args: [...args, '-o', file] };
  },
};

function pick(names, o, file, platform, env) {
  let first;
  for (const name of names) {
    const path = lookup(name, platform, env);
    if (!path) continue;
    const built = builders[name](o, file);
    if (!built.unsupported) return { name, path, ...built };
    first ??= `${built.unsupported}: not supported with ${name}`;
  }
  return { error: first };
}

function clipboard(wayland, platform, env) {
  const xclip = { name: 'xclip', args: ['-selection', 'clipboard', '-t', 'image/png'] };
  const clips = wayland ? [{ name: 'wl-copy', args: ['--type', 'image/png'] }, xclip] : [xclip];
  for (const clip of clips) {
    const path = lookup(clip.name, platform, env);
    if (path) return { ...clip, path };
  }
  return { error: `no clipboard tool found (tried ${clips.map((c) => c.name).join(', ')})` };
}

export async function linux({ o, file, env, platform, fds, wait }) {
  const wayland = Boolean(env.WAYLAND_DISPLAY);
  const names = wayland ? ['grim', 'gnome-screenshot'] : ['gnome-screenshot', 'import', 'scrot'];
  const scratch = o.clipboard ? mkdtempSync(join(tmpdir(), 'sccapture-')) : undefined;
  const target = scratch ? join(scratch, 'capture.png') : file;
  try {
    const tool = pick(names, o, target, platform, env);
    if (!tool.name) {
      if (tool.error) {
        say(fds[2], `sccapture: ${tool.error}\n`);
        return 2;
      }
      say(fds[2], `sccapture: no screenshot tool found (tried ${names.join(', ')})\n`);
      return 1;
    }
    const clip = o.clipboard ? clipboard(wayland, platform, env) : undefined;
    if (clip?.error) {
      say(fds[2], `sccapture: ${clip.error}\n`);
      return 1;
    }
    const slurp = tool.slurp ? lookup('slurp', platform, env) : undefined;
    if (tool.slurp && !slurp) {
      say(fds[2], 'sccapture: no region selector found (tried slurp)\n');
      return 1;
    }
    await wait(o.delay);
    let args = tool.args;
    if (slurp) {
      const region = await step('slurp', slurp, [], { env, capture: true }, fds);
      if (!region) return 1;
      args = ['-g', region.stdout.trim(), ...args];
    }
    if (!(await step(tool.name, tool.path, args, { env }, fds))) return 1;
    if (clip) {
      const fd = openSync(target, 'r');
      try {
        if (!(await step(clip.name, clip.path, clip.args, { env, stdin: fd }, fds))) return 1;
      } finally {
        closeSync(fd);
      }
      return 0;
    }
    if (!o.open) return 0;
    const viewer = lookup('xdg-open', platform, env);
    if (!viewer) {
      say(fds[2], 'sccapture: no viewer found (tried xdg-open)\n');
      return 1;
    }
    return (await step('xdg-open', viewer, [file], { env }, fds)) ? 0 : 1;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}
