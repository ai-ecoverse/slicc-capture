const flags = 'abcCdgiklmMoprPsSuUvwWx';
const valued = 'BDGJlRtTV';

export const usage =
  'usage: sccapture [-acdimorvwxCW] [-t format] [-T seconds] [-R x,y,w,h] [-D display] [-J style] [file]\n';

const long = { '--clipboard': 'c', '--view': 'v' };

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
  darwin: 'gGkvV',
  linux: 'bBDgGkmMpSuUvV',
  win32: 'bBgGiJklMpsSuUvVwW',
};

const formats = {
  linux: ['png', 'jpg', 'jpeg'],
  win32: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'tiff'],
};

const checks = {
  T: [/^\d+(\.\d+)?$/, 'invalid delay'],
  R: [/^\d+,\d+,[1-9]\d*,[1-9]\d*$/, 'invalid rectangle'],
  D: [/^[1-9]\d*$/, 'invalid display'],
  J: [/^(selection|window|video)$/, 'invalid style'],
  l: [/^(\d+|0x[0-9a-fA-F]+)$/, 'invalid window'],
};

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
  const style = options.find((option) => option.letter === 'J' && option.value === 'video');
  if (style) return `-J video: not supported ${where}`;
  if (options.some((option) => option.letter === 'c')) return undefined;
  const type = options.find(
    (option) => option.letter === 't' && !formats[platform].includes(option.value.toLowerCase())
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
  };
}
