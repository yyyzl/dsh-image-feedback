import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';

// Synthetic fixtures only: no private screenshots, fonts, DOM or native UI tree.
const source = await readFile(new URL('../src/smart-selection.js', import.meta.url), 'utf8');
const { createSmartSelectionEngine } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const engine = createSmartSelectionEngine();
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
function rgba(width, height, color = [255, 255, 255, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(color, i);
  return { width, height, data };
}
function pixel(image, x, y, color, alpha = 1) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const at = (y * image.width + x) * 4;
  for (let c = 0; c < 3; c++) image.data[at + c] = Math.round(color[c] * alpha + image.data[at + c] * (1 - alpha));
  image.data[at + 3] = 255;
}
function box(image, x, y, width, height, color) {
  for (let yy = y; yy < y + height; yy++) for (let xx = x; xx < x + width; xx++) pixel(image, xx, yy, color);
}
function softRow(image, rect, color) {
  const r = 9, feather = 3;
  for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
    const dx = Math.max(rect.x + r - 0.5 - x, 0, x - (rect.x + rect.width - r - 0.5));
    const dy = Math.max(rect.y + r - 0.5 - y, 0, y - (rect.y + rect.height - r - 0.5));
    const edge = Math.min(x - rect.x + 0.5, rect.x + rect.width - x - 0.5,
      y - rect.y + 0.5, rect.y + rect.height - y - 0.5, r - Math.hypot(dx, dy));
    pixel(image, x, y, color, clamp(edge / feather, 0, 1));
  }
}
function glyph(image, x, y, color, variant, bold = false, small = false) {
  const width = small ? 7 : 12, height = small ? 10 : 16, mask = new Uint8Array(width * height);
  const thick = bold ? 2 : 1;
  const put = (xx, yy) => { if (xx >= 0 && xx < width && yy >= 0 && yy < height) mask[yy * width + xx] = 1; };
  for (let yy = 1; yy < height - 1; yy++) for (let t = 0; t < thick; t++) {
    put(1 + t, yy); put(width - 2 - t, yy);
    if (variant % 2 === 0 && yy > 4 && yy < height - 3) put(Math.floor(width / 2) + t, yy);
  }
  for (const yy of [1, Math.floor(height / 2), height - 2]) for (let xx = 2; xx < width - 2; xx++) {
    for (let t = 0; t < thick; t++) put(xx, yy + t);
  }
  // Detached radicals/diagonal tips resemble dense CJK raster components rather
  // than connected Latin glyph blobs; the engine must not rely on glyph color CC.
  put(4, 4); put(5, 3); put(width - 5, height - 5);
  for (let yy = 0; yy < height; yy++) for (let xx = 0; xx < width; xx++) {
    if (mask[yy * width + xx]) pixel(image, x + xx, y + yy, color);
    else {
      let adjacent = false;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = xx + dx, ny = yy + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height && mask[ny * width + nx]) adjacent = true;
      }
      if (adjacent) pixel(image, x + xx, y + yy, color, 0.28);
    }
  }
}
function line(image, x, y, count, color, options = {}) {
  const advance = options.small ? 9 : 15;
  for (let i = 0; i < count; i++) glyph(image, x + i * advance, y, color, i,
    options.bold || (options.mixed && i > count / 3 && i < count * 0.7), options.small);
  return { x, y, width: count * advance - 3, height: options.small ? 10 : 16 };
}
function scaled(image, factor) {
  const width = Math.round(image.width * factor), height = Math.round(image.height * factor), result = rgba(width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = (x + 0.5) * image.width / width - 0.5, sy = (y + 0.5) * image.height / height - 0.5;
    const x0 = clamp(Math.floor(sx), 0, image.width - 1), y0 = clamp(Math.floor(sy), 0, image.height - 1);
    const x1 = Math.min(image.width - 1, x0 + 1), y1 = Math.min(image.height - 1, y0 + 1);
    const fx = clamp(sx - Math.floor(sx), 0, 1), fy = clamp(sy - Math.floor(sy), 0, 1);
    const at = (y * width + x) * 4;
    for (let c = 0; c < 4; c++) result.data[at + c] =
      image.data[(y0 * image.width + x0) * 4 + c] * (1 - fx) * (1 - fy) +
      image.data[(y0 * image.width + x1) * 4 + c] * fx * (1 - fy) +
      image.data[(y1 * image.width + x0) * 4 + c] * (1 - fx) * fy +
      image.data[(y1 * image.width + x1) * 4 + c] * fx * fy;
  }
  return result;
}
function fixture(dark = false) {
  const background = dark ? [24, 27, 33, 255] : [255, 255, 255, 255];
  const sidebar = dark ? [31, 35, 42, 255] : [249, 250, 251, 255];
  const ink = dark ? [230, 233, 239, 255] : [16, 18, 23, 255];
  const muted = dark ? [146, 152, 164, 255] : [150, 153, 159, 255];
  const image = rgba(1280, 600, background);
  box(image, 0, 0, 290, 600, sidebar);
  const rows = [];
  for (let i = 0; i < 7; i++) {
    const rect = { x: 14, y: 70 + i * 48, width: 260, height: 44 };
    if (i === 1) softRow(image, rect, dark ? [44, 48, 55, 255] : [236, 238, 240, 255]);
    line(image, 40, 84 + i * 48, i % 2 ? 10 : 8, ink);
    line(image, 232, 87 + i * 48, 3, muted, { small: true });
    rows.push(rect);
  }
  for (const y of [105, 225, 345]) {
    line(image, 360, y, 51, ink, { mixed: true });
    line(image, 360, y + 28, y === 225 ? 7 : 15, ink);
  }
  return { image, rows };
}
function pickAt(candidates, point, factor) { return engine.pick(candidates, { x: point.x * factor, y: point.y * factor }); }
function sameTarget(candidates, points, factor, kind) {
  const picks = points.map(p => pickAt(candidates, p, factor));
  assert.ok(picks.every(Boolean), `missing target for ${kind}: ${JSON.stringify(picks)}`);
  assert.equal(picks[0].kind, kind, JSON.stringify(picks));
  assert.ok(picks.every(p => p.id === picks[0].id), JSON.stringify(picks));
  return picks[0];
}
function sourceRect(candidate, factor) {
  return Object.fromEntries(Object.entries(candidate.rect).map(([key, value]) => [key, value / factor]));
}

test('mixed-paint AA text yields whole paragraphs and list rows at ink, timestamp and whitespace points', t => {
  for (const dark of [false, true]) for (const factor of [1, 0.7]) {
    const { image } = fixture(dark), sample = factor === 1 ? image : scaled(image, factor);
    const start = performance.now(), candidates = engine.detect(sample, { scale: factor });
    const selected = sameTarget(candidates, [{ x: 90, y: 140 }, { x: 215, y: 140 }, { x: 245, y: 140 }], factor, 'row');
    const plain = sameTarget(candidates, [{ x: 90, y: 284 }, { x: 215, y: 284 }, { x: 245, y: 284 }], factor, 'row');
    assert.notEqual(selected.id, plain.id);
    for (const c of [selected, plain]) {
      const r = sourceRect(c, factor);
      assert.ok(r.width >= 225 && r.width <= 280 && r.height >= 34 && r.height <= 55, JSON.stringify(r));
    }
    const first = sameTarget(candidates, [{ x: 430, y: 112 }, { x: 430, y: 140 }, { x: 1010, y: 140 }], factor, 'paragraph');
    const second = sameTarget(candidates, [{ x: 430, y: 232 }, { x: 390, y: 260 }, { x: 1010, y: 260 }], factor, 'paragraph');
    const third = sameTarget(candidates, [{ x: 430, y: 352 }, { x: 1010, y: 380 }], factor, 'paragraph');
    assert.notEqual(first.id, second.id); assert.notEqual(second.id, third.id);
    for (const c of [first, second, third]) {
      const r = sourceRect(c, factor);
      assert.ok(r.x > 330 && r.width > 720 && r.height >= 45 && r.height <= 85, JSON.stringify(r));
      assert.ok(c.lineCount >= 2);
    }
    assert.equal(pickAt(candidates, { x: 1000, y: 190 }, factor), null, 'blank message separator must not belong to either paragraph');
    assert.ok(!candidates.some(c => c.kind === 'paragraph' && c.rect.x < 290 * factor && c.rect.x + c.rect.width > 350 * factor), 'do not cross column gutter');
    t.diagnostic(`synthetic layout dark=${dark} scale=${factor}: ${candidates.length} candidates, ${(performance.now() - start).toFixed(1)}ms observation`);
  }
});

test('a real closed button inside paragraph whitespace wins over the paragraph, not its label', () => {
  const { image } = fixture();
  box(image, 880, 128, 100, 28, [30, 100, 210, 255]);
  line(image, 899, 137, 5, [255, 255, 255, 255], { small: true });
  const candidates = engine.detect(image);
  const paragraph = sameTarget(candidates, [{ x: 430, y: 112 }, { x: 1010, y: 140 }], 1, 'paragraph');
  const button = engine.pick(candidates, { x: 930, y: 142 }, paragraph);
  assert.ok(button); assert.equal(button.kind, 'control');
  assert.deepEqual(button.rect, { x: 880, y: 128, width: 100, height: 28 });
});

test('layout groups retain reserved candidate capacity under dense closed-control noise', () => {
  const image = rgba(1280, 800);
  for (let y = 4; y < 400; y += 20) for (let x = 4; x < 1260; x += 20) box(image, x, y, 16, 16, [35, 105, 215, 255]);
  line(image, 100, 650, 50, [20, 23, 28, 255], { mixed: true });
  line(image, 100, 678, 12, [20, 23, 28, 255]);
  const candidates = engine.detect(image);
  assert.ok(candidates.length <= 400);
  sameTarget(candidates, [{ x: 180, y: 657 }, { x: 760, y: 685 }], 1, 'paragraph');
  assert.deepEqual(engine.detect(image), candidates);
});

test('layout hierarchy is deterministic, source-immutable, JSON-safe and factory-worker self-contained', async () => {
  const image = rgba(720, 240);
  line(image, 55, 70, 39, [20, 22, 27, 255], { mixed: true });
  line(image, 55, 98, 10, [20, 22, 27, 255]);
  const before = image.data.slice(), candidates = engine.detect(image);
  assert.ok(candidates.some(c => c.kind === 'paragraph'));
  assert.deepEqual(engine.detect(image), candidates);
  assert.deepEqual(image.data, before);
  assert.deepEqual(JSON.parse(JSON.stringify(candidates)), candidates);
  const worker = new Worker(`const {parentPort}=require('node:worker_threads');
    const engine=(${createSmartSelectionEngine.toString()})();
    parentPort.on('message',image=>parentPort.postMessage(engine.detect(image)));`, { eval: true });
  try {
    const result = await new Promise((resolve, reject) => {
      worker.once('message', resolve); worker.once('error', reject); worker.postMessage(image);
    });
    assert.deepEqual(result, candidates);
  } finally { await worker.terminate(); }
});
