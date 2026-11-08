import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

const skip = process.env.CI ? false : 'runs a real Chrome on CI only';

async function capture({ options, fallback, abortAfter, outside }) {
  const { create } = await import(new URL('/page/index.mjs', location.href).href);
  const canvas = document.createElement('canvas');
  canvas.width = 200;
  canvas.height = 100;
  const context = canvas.getContext('2d');
  const paint = () => {
    context.fillStyle = '#ff0000';
    context.fillRect(0, 0, 100, 100);
    context.fillStyle = '#0000ff';
    context.fillRect(100, 0, 100, 100);
  };
  paint();
  const timer = setInterval(paint, 20);
  const stream = canvas.captureStream(30);
  const tracks = stream.getTracks();
  const page = create(fallback ? { ImageCapture: undefined } : {});
  const controller = new AbortController();
  const lines = [];
  let constraints;
  if (abortAfter) setTimeout(() => controller.abort('interrupted'), abortAfter);
  const result = { lines };
  try {
    const bytes = await page.handle({
      kind: 'capture.screen',
      options: outside ? { ...options, rect: { x: 150, y: 0, width: 100, height: 10 } } : options,
      signal: controller.signal,
      progress: (line) => lines.push(line),
      display: async (given) => {
        constraints = given;
        return stream;
      },
    });
    result.magic = Array.from(bytes.slice(0, 4));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: options.type }));
    const check = new OffscreenCanvas(bitmap.width, bitmap.height);
    const draw = check.getContext('2d');
    draw.drawImage(bitmap, 0, 0);
    result.size = [bitmap.width, bitmap.height];
    result.left = Array.from(draw.getImageData(2, 2, 1, 1).data);
    result.right = Array.from(draw.getImageData(bitmap.width - 3, 2, 1, 1).data);
  } catch (error) {
    result.error = { name: error.name, message: error.message };
  } finally {
    clearInterval(timer);
  }
  result.constraints = constraints;
  result.states = tracks.map((track) => track.readyState);
  return result;
}

async function record({ type, duration }) {
  const { create } = await import(new URL('/page/index.mjs', location.href).href);
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 120;
  const context = canvas.getContext('2d');
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    context.fillStyle = tick % 2 ? '#ff0000' : '#0000ff';
    context.fillRect(0, 0, 160, 120);
  }, 20);
  const stream = canvas.captureStream(30);
  const tracks = stream.getTracks();
  const lines = [];
  const result = { lines, supported: MediaRecorder.isTypeSupported(type) };
  try {
    const reply = await create().handle({
      kind: 'capture.screen',
      options: { type, duration },
      progress: (line) => lines.push(line),
      display: async () => stream,
    });
    const bytes = new Uint8Array(await new Response(reply).arrayBuffer());
    result.size = bytes.length;
    result.magic = Array.from(bytes.slice(0, 8));
  } catch (error) {
    result.error = { name: error.name, message: error.message };
  } finally {
    clearInterval(timer);
  }
  result.states = tracks.map((track) => track.readyState);
  return result;
}

async function film({ options, audio }) {
  const { create } = await import(new URL('/page/index.mjs', location.href).href);
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 120;
  const context = canvas.getContext('2d');
  const paint = () => {
    context.fillStyle = '#ff0000';
    context.fillRect(0, 0, 80, 120);
    context.fillStyle = '#0000ff';
    context.fillRect(80, 0, 80, 120);
  };
  paint();
  const timer = setInterval(paint, 20);
  const stream = canvas.captureStream(30);
  let sound;
  if (audio) {
    sound = new AudioContext();
    const oscillator = sound.createOscillator();
    const destination = sound.createMediaStreamDestination();
    oscillator.connect(destination);
    oscillator.start();
    await sound.resume();
    stream.addTrack(destination.stream.getAudioTracks()[0]);
  }
  const tracks = stream.getTracks();
  const lines = [];
  const asked = [];
  const result = { lines, asked };
  try {
    const reply = await create().handle({
      kind: 'capture.camera',
      options,
      progress: (line) => lines.push(line),
      userMedia: async (constraints) => {
        asked.push(constraints);
        return stream;
      },
    });
    if (reply instanceof Uint8Array) {
      const bitmap = await createImageBitmap(new Blob([reply], { type: options.type }));
      const check = new OffscreenCanvas(bitmap.width, bitmap.height);
      const draw = check.getContext('2d');
      draw.drawImage(bitmap, 0, 0);
      result.magic = Array.from(reply.slice(0, 4));
      result.size = [bitmap.width, bitmap.height];
      result.left = Array.from(draw.getImageData(2, 2, 1, 1).data);
      result.right = Array.from(draw.getImageData(bitmap.width - 3, 2, 1, 1).data);
    } else {
      const bytes = new Uint8Array(await new Response(reply).arrayBuffer());
      result.bytes = bytes.length;
      result.magic = Array.from(bytes.slice(0, 4));
      const head = new TextDecoder('latin1').decode(bytes.slice(0, 4096));
      result.codecs = head.match(/V_VP[89]|A_OPUS/g);
    }
  } catch (error) {
    result.error = { name: error.name, message: error.message };
  } finally {
    clearInterval(timer);
    await sound?.close();
  }
  result.states = tracks.map((track) => track.readyState);
  return result;
}

async function devices() {
  const { create } = await import(new URL('/page/index.mjs', location.href).href);
  return create().handle({ kind: 'capture.devices', options: {} });
}

const red = (pixel) => pixel[0] > 200 && pixel[1] < 60 && pixel[2] < 60;
const blue = (pixel) => pixel[0] < 60 && pixel[1] < 60 && pixel[2] > 200;

describe('the page module in Chrome', { skip }, () => {
  let chrome;

  before(async () => {
    const { launch } = await import('@ai-ecoverse/slicc-shared-web/harness');
    chrome = await launch({
      roots: [
        ['/page/', 'page/'],
        ['/', 'test/integration/browser/'],
      ],
      coverage: [],
    });
  });

  after(() => chrome?.close());

  async function run(t, args) {
    const tab = await chrome.page(t);
    await tab.goto('/');
    return tab.evaluate(capture, args);
  }

  it('captures a canvas track with ImageCapture as a PNG', async (t) => {
    const result = await run(t, { options: { type: 'image/png', cursor: 'never' } });
    assert.equal(result.error, undefined, JSON.stringify(result.error));
    assert.deepEqual(result.constraints, { video: { cursor: 'never' }, audio: false });
    assert.deepEqual(result.magic, [0x89, 0x50, 0x4e, 0x47]);
    assert.deepEqual(result.size, [200, 100]);
    assert.ok(red(result.left), String(result.left));
    assert.ok(blue(result.right), String(result.right));
    assert.deepEqual(result.states, ['ended']);
    assert.deepEqual(result.lines, ['waiting for the picker…']);
  });

  const rect = { x: 110, y: 10, width: 80, height: 50 };

  it('crops to the rectangle and encodes JPEG', async (t) => {
    const jpeg = await run(t, { options: { type: 'image/jpeg', quality: 0.92, rect } });
    assert.equal(jpeg.error, undefined, JSON.stringify(jpeg.error));
    assert.deepEqual(jpeg.magic.slice(0, 3), [0xff, 0xd8, 0xff]);
    assert.deepEqual(jpeg.size, [80, 50]);
    assert.ok(blue(jpeg.left), String(jpeg.left));
    assert.ok(blue(jpeg.right), String(jpeg.right));
    assert.deepEqual(jpeg.states, ['ended']);
  });

  it('crops to the rectangle and encodes WebP', async (t) => {
    const webp = await run(t, { options: { type: 'image/webp', quality: 0.92, rect } });
    assert.equal(webp.error, undefined, JSON.stringify(webp.error));
    assert.deepEqual(webp.magic, [0x52, 0x49, 0x46, 0x46]);
    assert.deepEqual(webp.size, [80, 50]);
    assert.ok(blue(webp.left), String(webp.left));
    assert.deepEqual(webp.states, ['ended']);
  });

  it('falls back to a video element without ImageCapture', async (t) => {
    const result = await run(t, {
      options: { type: 'image/png', surface: 'window', delay: 0.2 },
      fallback: true,
    });
    assert.equal(result.error, undefined, JSON.stringify(result.error));
    assert.deepEqual(result.constraints, { video: { displaySurface: 'window' }, audio: false });
    assert.deepEqual(result.size, [200, 100]);
    assert.ok(red(result.left), String(result.left));
    assert.ok(blue(result.right), String(result.right));
    assert.deepEqual(result.states, ['ended']);
    assert.deepEqual(result.lines, ['waiting for the picker…', 'waiting 0.2 s…']);
  });

  it('rejects a rectangle outside the frame, and stops the track', async (t) => {
    const result = await run(t, { options: { type: 'image/png' }, outside: true });
    assert.deepEqual(result.error, {
      name: 'RangeError',
      message: '-R: rectangle outside the capture',
    });
    assert.deepEqual(result.states, ['ended']);
  });

  it('records a WebM with MediaRecorder for the duration, and stops the track', async (t) => {
    const tab = await chrome.page(t);
    await tab.goto('/');
    const result = await tab.evaluate(record, { type: 'video/webm', duration: 0.6 });
    assert.equal(result.error, undefined, JSON.stringify(result.error));
    assert.deepEqual(result.magic.slice(0, 4), [0x1a, 0x45, 0xdf, 0xa3]);
    assert.ok(result.size > 100, String(result.size));
    assert.deepEqual(result.states, ['ended']);
    assert.deepEqual(result.lines, ['waiting for the picker…', 'recording for 0.6 s…']);
  });

  it('records an MP4 where this Chrome can', async (t) => {
    const tab = await chrome.page(t);
    await tab.goto('/');
    const result = await tab.evaluate(record, { type: 'video/mp4', duration: 0.6 });
    if (!result.supported) {
      assert.equal(result.error?.name, 'NotSupportedError');
      return;
    }
    assert.equal(result.error, undefined, JSON.stringify(result.error));
    assert.deepEqual(result.magic.slice(4, 8), [0x66, 0x74, 0x79, 0x70]);
    assert.deepEqual(result.states, ['ended']);
  });

  it('takes a camera still after the warmup, and stops the camera', async (t) => {
    const tab = await chrome.page(t);
    await tab.goto('/');
    const result = await tab.evaluate(film, {
      options: { type: 'image/png', warmup: 0.2, width: 160, exact: true },
    });
    assert.equal(result.error, undefined, JSON.stringify(result.error));
    assert.deepEqual(result.asked, [{ video: { width: { exact: 160 } }, audio: false }]);
    assert.deepEqual(result.magic, [0x89, 0x50, 0x4e, 0x47]);
    assert.deepEqual(result.size, [160, 120]);
    assert.ok(red(result.left), String(result.left));
    assert.ok(blue(result.right), String(result.right));
    assert.deepEqual(result.states, ['ended']);
    assert.deepEqual(result.lines, []);
  });

  it('records the camera and the microphone as one WebM, and stops both', async (t) => {
    const tab = await chrome.page(t);
    await tab.goto('/');
    await tab.enter();
    const result = await tab.evaluate(film, {
      options: { type: 'video/webm', duration: 0.6, microphone: true },
      audio: true,
    });
    assert.equal(result.error, undefined, JSON.stringify(result.error));
    assert.deepEqual(result.asked, [{ video: true, audio: true }]);
    assert.deepEqual(result.magic, [0x1a, 0x45, 0xdf, 0xa3]);
    assert.ok(result.bytes > 100, String(result.bytes));
    assert.deepEqual(result.codecs.sort(), ['A_OPUS', 'V_VP9']);
    assert.deepEqual(result.states, ['ended', 'ended']);
    assert.deepEqual(result.lines, ['recording for 0.6 s…']);
  });

  it("lists the page's devices without asking", async (t) => {
    const tab = await chrome.page(t);
    await tab.goto('/');
    const listed = await tab.evaluate(devices, {});
    const rows = listed.split('\n');
    assert.equal(rows.pop(), '');
    const kinds = rows.map((row) => row.split('\t')[0]);
    assert.deepEqual(kinds, [...kinds].sort().reverse());
    for (const row of rows) assert.match(row, /^(video|audio)\t[\w+/=.-]*\t[^\t]*$/);
  });

  it('aborts during the delay, and stops the track', async (t) => {
    const result = await run(t, { options: { type: 'image/png', delay: 30 }, abortAfter: 200 });
    assert.deepEqual(result.error, { name: 'AbortError', message: 'interrupted' });
    assert.deepEqual(result.states, ['ended']);
  });
});
