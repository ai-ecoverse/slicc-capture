const types = ['image/png', 'image/jpeg', 'image/webp'];
const cursors = ['always', 'motion', 'never'];
const surfaces = ['monitor', 'window', 'browser'];
const unsupported = 'screen capture is not supported in this browser';

export const kinds = { 'capture.screen': {} };

function fail(name, message) {
  return new DOMException(message, name);
}

function aborted(signal) {
  const reason = signal.reason;
  if (reason?.name === 'AbortError') return reason;
  return fail('AbortError', String(reason?.message ?? reason));
}

function race(promise, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => reject(aborted(signal));
    if (signal.aborted) stop();
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', stop));
  });
}

function sleep(ms, signal) {
  let timer;
  const wait = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return race(wait, signal).finally(() => clearTimeout(timer));
}

function stopAll(stream) {
  for (const track of stream?.getTracks?.() ?? []) track.stop();
}

function invalid(field, value) {
  return new TypeError(`invalid ${field}: ${JSON.stringify(value)}`);
}

const whole = (value, least) => Number.isInteger(value) && value >= least;

function parse(options = {}) {
  const { type = 'image/png', quality, cursor, surface, delay, rect } = options;
  if (!types.includes(type)) throw fail('NotSupportedError', `unsupported type: ${type}`);
  if (quality !== undefined && !(typeof quality === 'number' && quality >= 0 && quality <= 1)) {
    throw invalid('quality', quality);
  }
  if (cursor !== undefined && !cursors.includes(cursor)) throw invalid('cursor', cursor);
  if (surface !== undefined && !surfaces.includes(surface)) throw invalid('surface', surface);
  if (delay !== undefined && !(Number.isFinite(delay) && delay >= 0)) throw invalid('delay', delay);
  if (
    rect !== undefined &&
    !(whole(rect?.x, 0) && whole(rect?.y, 0) && whole(rect?.width, 1) && whole(rect?.height, 1))
  ) {
    throw invalid('rect', rect);
  }
  const video = {};
  if (cursor !== undefined) video.cursor = cursor;
  if (surface !== undefined) video.displaySurface = surface;
  return {
    constraints: { video, audio: false },
    type,
    quality,
    delay: delay ?? 0,
    rect,
  };
}

async function pick(display, constraints, signal, timeout) {
  const pending = Promise.resolve().then(() => display(constraints));
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(fail('TimeoutError', 'timed out waiting for the picker')),
      timeout
    );
  });
  try {
    return await race(Promise.race([pending, late]), signal);
  } catch (error) {
    pending.then(stopAll, () => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function grab(stream, track, env, signal) {
  const ImageCapture = env('ImageCapture');
  if (ImageCapture) {
    const pending = Promise.resolve(new ImageCapture(track).grabFrame());
    let bitmap;
    try {
      bitmap = await race(pending, signal);
    } catch (error) {
      pending.then(
        (late) => late?.close?.(),
        () => {}
      );
      throw error;
    }
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close?.(),
    };
  }
  const video = env('document').createElement('video');
  const close = () => {
    video.pause();
    video.srcObject = null;
  };
  const ready = new Promise((resolve, reject) => {
    video.onloadedmetadata = () => video.play().catch(reject);
    video.onloadeddata = resolve;
    video.onerror = () => reject(new Error('the capture could not be played'));
  });
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    await race(ready, signal);
  } catch (error) {
    close();
    throw error;
  }
  return { source: video, width: video.videoWidth, height: video.videoHeight, close };
}

async function encode(frame, request, env, signal) {
  const { type, quality, rect } = request;
  const { x, y, width, height } = rect ?? { x: 0, y: 0, width: frame.width, height: frame.height };
  if (!(frame.width > 0 && frame.height > 0)) throw new Error('the capture has no frame');
  if (x + width > frame.width || y + height > frame.height) {
    throw new RangeError('-R: rectangle outside the capture');
  }
  const canvas = new (env('OffscreenCanvas'))(width, height);
  canvas.getContext('2d').drawImage(frame.source, x, y, width, height, 0, 0, width, height);
  const blob = await race(
    canvas.convertToBlob(quality === undefined ? { type } : { type, quality }),
    signal
  );
  if (blob.type !== type)
    throw fail('NotSupportedError', `${type} is not supported by this browser`);
  return new Uint8Array(await race(blob.arrayBuffer(), signal));
}

export function create(overrides = {}) {
  const env = (name) => (name in overrides ? overrides[name] : globalThis[name]);
  const timeout = overrides.timeout ?? 300000;

  async function handle({
    options,
    signal = new AbortController().signal,
    progress = () => {},
    display,
  }) {
    const request = parse(options);
    if (typeof display !== 'function') throw fail('NotSupportedError', unsupported);
    if (!env('OffscreenCanvas') || !(env('ImageCapture') || env('document'))) {
      throw fail('NotSupportedError', unsupported);
    }
    const local = new AbortController();
    const forward = () => local.abort(signal.reason);
    if (signal.aborted) forward();
    signal.addEventListener('abort', forward, { once: true });
    let stream;
    let frame;
    try {
      if (local.signal.aborted) throw aborted(local.signal);
      progress('waiting for the picker…');
      stream = await pick(display, request.constraints, local.signal, timeout);
      const track = stream?.getVideoTracks?.()[0];
      if (!track) throw fail('NotFoundError', 'the capture has no video track');
      if (track.readyState === 'ended') throw fail('AbortError', 'the capture was stopped');
      track.addEventListener(
        'ended',
        () => local.abort(fail('AbortError', 'the capture was stopped')),
        {
          once: true,
        }
      );
      if (request.delay > 0) {
        progress(`waiting ${request.delay} s…`);
        await sleep(request.delay * 1000, local.signal);
      }
      frame = await grab(stream, track, env, local.signal);
      return await encode(frame, request, env, local.signal);
    } finally {
      signal.removeEventListener('abort', forward);
      frame?.close();
      stopAll(stream);
    }
  }

  return { kinds, handle };
}

const page = create();

export const handle = page.handle;

export default page;
