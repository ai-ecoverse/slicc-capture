import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { lookup, record, say, step } from './tools.mjs';

const extensions = { '.png': 'png', '.jpg': 'jpg', '.jpeg': 'jpg' };

const containers = { '.mp4': 'mp4', '.mov': 'mov', '.mkv': 'mkv', '.webm': 'webm' };

const muxers = { mp4: 'mp4', mov: 'mov', mkv: 'matroska', webm: 'webm' };

export function container(o, file) {
  const ext = extname(file).toLowerCase();
  const type = o.type ?? containers[ext] ?? (ext ? undefined : 'mp4');
  return { type, muxer: o.type || !ext ? muxers[type] : undefined };
}

export function ffmpeg(o, file, input, sources) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-y', ...input];
  for (const source of sources) args.push(...source);
  if (sources.length === 2) {
    args.push('-filter_complex', '[1:a][2:a]amix=inputs=2[a]', '-map', '0:v', '-map', '[a]');
  }
  if (o.duration !== undefined) args.push('-t', String(o.duration));
  args.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-pix_fmt', 'yuv420p');
  const { muxer } = container(o, file);
  if (muxer) args.push('-f', muxer);
  return [...args, file];
}

const recorders = {
  'wf-recorder'(o, file) {
    if (o.window) return { unsupported: o.windowLabel };
    if (o.id) return { unsupported: '-l' };
    if (o.cursor) return { unsupported: '-C' };
    if (o.microphone && o.system) return { unsupported: '-A' };
    const args = ['-y'];
    if (o.rect) {
      const [x, y, w, h] = o.rect;
      args.push('-g', `${x},${y} ${w}x${h}`);
    }
    if (o.microphone) args.push(o.microphone === 'default' ? '-a' : `--audio=${o.microphone}`);
    if (o.system) args.push('--audio=@DEFAULT_MONITOR@');
    const { type, muxer } = container(o, file);
    if (muxer) args.push('-m', muxer);
    if (type === 'webm') args.push('-c', 'libvpx-vp9');
    if (type === 'webm' && (o.microphone || o.system)) args.push('-C', 'libopus');
    args.push('-f', file);
    return { args, slurp: o.select && !o.rect, stop: 'SIGINT' };
  },
  ffmpeg(o, file, env) {
    if (o.window) return { unsupported: o.windowLabel };
    const display = env.DISPLAY || ':0';
    const input = ['-f', 'x11grab', '-draw_mouse', o.cursor ? '1' : '0'];
    let screen = display;
    if (o.rect) {
      const [x, y, w, h] = o.rect;
      input.push('-video_size', `${w}x${h}`);
      screen = `${display}+${x},${y}`;
    } else if (o.select) input.push('-select_region', '1');
    if (o.id) input.push('-window_id', o.id);
    input.push('-i', screen);
    const sources = [o.microphone, o.system && '@DEFAULT_MONITOR@']
      .filter(Boolean)
      .map((source) => ['-f', 'pulse', '-i', source]);
    return { args: ffmpeg(o, file, input, sources), stop: 'q' };
  },
};

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
    const type = o.type ?? (extname(file) ? undefined : 'png');
    return { args: [...args, type ? `${type}:${file}` : file] };
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
  const table = o.video ? recorders : builders;
  for (const name of names) {
    const path = lookup(name, platform, env);
    if (!path) continue;
    const built = table[name](o, file, env);
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

function shoot(o, tool, args, options, fds) {
  if (o.video) return record(tool.name, tool.path, args, options, fds);
  return step(tool.name, tool.path, args, { env: options.env }, fds);
}

async function view(file, platform, env, fds) {
  const viewer = lookup('xdg-open', platform, env);
  if (!viewer) {
    say(fds[2], 'sccapture: no viewer found (tried xdg-open)\n');
    return 1;
  }
  return (await step('xdg-open', viewer, [file], { env }, fds)) ? 0 : 1;
}

function tools(wayland, video) {
  if (video) return wayland ? ['wf-recorder'] : ['ffmpeg'];
  return wayland ? ['grim', 'gnome-screenshot'] : ['gnome-screenshot', 'import', 'scrot'];
}

export async function linux({ o, file, env, platform, fds, wait, signals }) {
  const wayland = Boolean(env.WAYLAND_DISPLAY);
  const names = tools(wayland, o.video);
  const scratch = o.clipboard ? mkdtempSync(join(tmpdir(), 'sccapture-')) : undefined;
  const target = scratch ? join(scratch, 'capture.png') : file;
  try {
    const tool = pick(names, o, target, platform, env);
    if (!tool.name) {
      if (tool.error) {
        say(fds[2], `sccapture: ${tool.error}\n`);
        return 2;
      }
      const what = o.video ? 'screen recorder' : 'screenshot tool';
      say(fds[2], `sccapture: no ${what} found (tried ${names.join(', ')})\n`);
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
    const options = { env, stop: tool.stop, file, duration: o.duration, wait, signals };
    if (!(await shoot(o, tool, args, options, fds))) return 1;
    if (clip) {
      const fd = openSync(target, 'r');
      try {
        if (!(await step(clip.name, clip.path, clip.args, { env, stdin: fd }, fds))) return 1;
      } finally {
        closeSync(fd);
      }
      return 0;
    }
    return o.open ? view(file, platform, env, fds) : 0;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}
