const flags = 'aAbcCdgiklmMoprPsSuUvwWx';
const valued = 'BDGJlRtTV';

const args = {
  t: 'format',
  T: 'seconds',
  R: 'x,y,w,h',
  D: 'display',
  J: 'style',
  l: 'windowid',
  B: 'bundleid',
  V: 'seconds',
  G: 'id',
};

const noop = 'adorx';

const said = {
  darwin: {
    tool: "macOS's screencapture, which gets the options as given",
    a: "don't capture windows attached to the window",
    A: 'with -v, record the system audio too',
    b: 'capture the Touch Bar',
    B: 'open the capture in that app',
    c: 'copy to the clipboard instead of a file',
    C: 'include the cursor',
    d: 'show errors graphically',
    D: 'capture that display (1 is the main one)',
    g: 'with -v, record the default audio input too',
    G: 'with -v, record that audio input too',
    i: 'select a region or a window interactively',
    J: 'start in selection, window or video mode',
    k: 'with -v, show the clicks',
    l: 'capture that window',
    m: 'capture the main monitor only',
    M: 'open the capture in a new Mail message',
    o: "leave out the window's shadow",
    p: 'use the screenshot settings; no file needed',
    P: 'open the capture in Preview',
    r: "don't add dpi metadata",
    R: 'capture that rectangle',
    s: 'select a region with the mouse only',
    S: 'in window mode, capture the screen, not the window',
    t: 'png (the default), jpg, pdf, tiff, gif, bmp, ...',
    T: 'wait that long before capturing',
    u: 'show the screenshot UI afterwards; no file needed',
    U: 'show the interactive toolbar',
    v: 'record a video (.mov) until stopped: any key or ^C',
    V: 'record a video for that long',
    w: 'select a window only',
    W: 'start in window selection',
    x: "don't play sounds",
  },
  linux: {
    tool: 'grim, gnome-screenshot, import or scrot, and videos with wf-recorder or ffmpeg',
    A: 'with -v, record the system audio too',
    c: 'copy to the clipboard (PNG) instead of a file',
    C: 'include the cursor',
    g: 'with -v, record the default audio input too',
    G: 'with -v, record that PulseAudio source too',
    i: 'select a region or a window interactively',
    J: 'selection (as -s), window (as -w) or video (as -v)',
    l: 'capture that window (import, or ffmpeg with -v)',
    P: 'open the file afterwards, with xdg-open',
    R: 'capture that rectangle',
    s: 'select a region with the mouse',
    t: "png or jpg; with -v mp4, mov, mkv or webm; else the file's extension",
    T: 'wait that long before capturing',
    v: 'record a video until stopped with ^C',
    V: 'record a video for that long',
    w: 'select a window with the mouse',
    W: 'as -w',
  },
  win32: {
    tool: 'PowerShell, and videos with ffmpeg',
    c: 'copy to the clipboard (PNG) instead of a file',
    C: 'draw the cursor into the image',
    D: 'capture that screen (1 is the primary one)',
    G: 'with -v, record that DirectShow audio device too',
    m: 'capture the primary screen only',
    P: 'open the file afterwards',
    R: 'capture that rectangle of the screen (all of them, or -m or -D)',
    t: 'png, jpg, bmp, gif or tiff; with -v mp4, mov, mkv or webm',
    T: 'wait that long before capturing',
    v: 'record a video until stopped with ^C',
    V: 'record a video for that long',
  },
};

export function usage(platform) {
  const own = (letter) => !unsupported[platform].includes(letter);
  const letters = [...flags].filter((letter) => own(letter) && !valued.includes(letter));
  const lower = letters.filter((letter) => letter === letter.toLowerCase()).join('');
  const upper = letters.filter((letter) => letter !== letter.toLowerCase()).join('');
  const values = Object.keys(args)
    .filter(own)
    .map((letter) => ` [-${letter} ${args[letter]}]`)
    .join('');
  const files = platform === 'darwin' ? '[file ... | -]' : '[file | -]';
  return `usage: sccapture [-${lower}${upper}]${values} ${files}\n`;
}

export function help(platform) {
  const text = said[platform];
  const rows = Object.keys(text)
    .filter((key) => key.length === 1)
    .map((letter) => {
      const name =
        letter === 'c' ? '-c, --clipboard' : `-${letter}${args[letter] ? ` ${args[letter]}` : ''}`;
      return [name, text[letter]];
    });
  rows.push(
    ['--version', 'print the version'],
    ['--upgrade', 'upgrade to the latest release'],
    ['-h, --help', 'print this help']
  );
  const lines = rows.map(([name, what]) => `  ${name.padEnd(17)} ${what}\n`).join('');
  const quiet =
    platform === 'darwin'
      ? ''
      : `${[...noop].map((letter) => `-${letter}`).join(', ')}: accepted, as macOS's screencapture takes them, and do nothing.\n`;
  const out = 'A file named - is standard output, which must not be a terminal.\n';
  return `${usage(platform)}\nCaptures the screen with ${text.tool}.\n\n${lines}\n${out}${quiet}`;
}

const long = { '--clipboard': 'c', '--view': 'P' };

function group(argv, i, result, fail) {
  const arg = argv[i];
  let at = i;
  for (let j = 1; j < arg.length; j++) {
    const letter = arg[j];
    if (letter === 'h') result.help = true;
    else if (valued.includes(letter)) {
      const value = j + 1 < arg.length ? arg.slice(j + 1) : argv[++at];
      if (value === undefined) fail(`-${letter}: option requires a value`);
      else result.options.push({ letter, label: `-${letter}`, value });
      break;
    } else if (flags.includes(letter)) result.options.push({ letter, label: `-${letter}` });
    else fail(`unknown option: -${letter}`);
  }
  result.tokens.push(...argv.slice(i, at + 1));
  return at;
}

export function parse(argv) {
  const result = { help: false, error: undefined, special: [], options: [], files: [], tokens: [] };
  const fail = (message) => {
    result.error ??= message;
  };
  let ended = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (ended) result.files.push(arg);
    else if (arg === '--') ended = true;
    else if (arg === '--help') result.help = true;
    else if (arg === '--version' || arg === '--upgrade') result.special.push(arg);
    else if (long[arg]) {
      result.options.push({ letter: long[arg], label: arg });
      result.tokens.push(`-${long[arg]}`);
    } else if (arg.startsWith('--')) fail(`unknown option: ${arg}`);
    else if (arg.startsWith('-') && arg.length > 1) i = group(argv, i, result, fail);
    else result.files.push(arg);
  }
  return result;
}

const unsupported = {
  darwin: '',
  linux: 'bBDkmMpSuU',
  win32: 'AbBgiJklMpsSuUwW',
};

const formats = {
  linux: ['png', 'jpg', 'jpeg'],
  win32: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'tiff'],
};

const movies = ['mp4', 'mov', 'mkv', 'webm'];

const recording = 'AgGk';

const checks = {
  T: [/^\d+(\.\d+)?$/, 'invalid delay'],
  R: [/^\d+,\d+,[1-9]\d*,[1-9]\d*$/, 'invalid rectangle'],
  D: [/^[1-9]\d*$/, 'invalid display'],
  J: [/^(selection|window|video)$/, 'invalid style'],
  l: [/^(\d+|0x[0-9a-fA-F]+)$/, 'invalid window'],
  V: [/^(?=.*[1-9])\d+(\.\d+)?$/, 'invalid duration'],
  G: [/\S/, 'invalid audio input'],
};

export const video = (options) =>
  options.some(
    (option) => 'vV'.includes(option.letter) || (option.letter === 'J' && option.value === 'video')
  );

export const names = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };

export function check(options, platform) {
  const where = `on ${names[platform]}`;
  const own = options.find((option) => unsupported[platform].includes(option.letter));
  if (own) return `${own.label}: not supported ${where}`;
  for (const option of options) {
    const rule = checks[option.letter];
    if (rule && !rule[0].test(option.value))
      return `-${option.letter}: ${rule[1]}: ${option.value}`;
  }
  if (platform === 'darwin') return undefined;
  const moving = video(options);
  const audio = options.find((option) => recording.includes(option.letter));
  if (audio && !moving) return `${audio.label}: needs -v`;
  const clip = options.find((option) => option.letter === 'c');
  if (clip && moving) return `${clip.label}: not with -v`;
  if (clip) return undefined;
  const allowed = moving ? movies : formats[platform];
  const type = options.find(
    (option) => option.letter === 't' && !allowed.includes(option.value.toLowerCase())
  );
  if (type) return `-t ${type.value}: not supported ${where}`;
  return undefined;
}

export function settings(options) {
  const last = {};
  for (const option of options) last[option.letter] = option;
  const style = last.J?.value;
  const label = (...letters) => letters.map((letter) => last[letter]?.label).find(Boolean);
  const rect = last.R?.value.split(',').map(Number);
  return {
    last,
    clipboard: Boolean(last.c),
    cursor: Boolean(last.C),
    open: Boolean(last.P),
    main: Boolean(last.m),
    display: last.D?.value,
    delay: last.T ? Number(last.T.value) : 0,
    rect,
    id: last.l?.value,
    type: last.c ? undefined : last.t?.value.toLowerCase().replace('jpeg', 'jpg'),
    select: Boolean(last.s || last.i || style === 'selection'),
    window: Boolean(last.w || last.W || style === 'window'),
    windowLabel: label('w', 'W') ?? (style === 'window' ? '-J window' : undefined),
    video: video(options),
    duration: last.V ? Number(last.V.value) : undefined,
    microphone: last.G?.value ?? (last.g ? 'default' : undefined),
    microphoneLabel: label('G', 'g'),
    system: Boolean(last.A),
  };
}
