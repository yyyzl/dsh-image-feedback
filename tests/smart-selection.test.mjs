import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';

// A data-URL import also works when the embedding project's package type is CJS.
const source = await readFile(new URL('../src/smart-selection.js', import.meta.url), 'utf8');
const { createSmartSelectionEngine } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const engine = createSmartSelectionEngine();

function rgba(width, height, color = [255, 255, 255, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(color, i);
  return { width, height, data };
}
function pixel(image, x, y, color) { image.data.set(color, (y * image.width + x) * 4); }
function box(image, x, y, width, height, color, radius = 0) {
  for (let yy = y; yy < y + height; yy++) for (let xx = x; xx < x + width; xx++) {
    const dx = Math.max(x + radius - 0.5 - xx, 0, xx - (x + width - radius - 0.5));
    const dy = Math.max(y + radius - 0.5 - yy, 0, yy - (y + height - radius - 0.5));
    if (!radius || dx * dx + dy * dy <= radius * radius) pixel(image, xx, yy, color);
  }
}
function antialiasedBox(image, rect, color, radius) {
  for (let y = rect.y - 1; y <= rect.y + rect.height; y++) for (let x = rect.x - 1; x <= rect.x + rect.width; x++) {
    let covered = 0;
    for (const sy of [0.125, 0.375, 0.625, 0.875]) for (const sx of [0.125, 0.375, 0.625, 0.875]) {
      const px = x + sx, py = y + sy;
      if (px < rect.x + 0.25 || px >= rect.x + rect.width - 0.25 || py < rect.y + 0.25 || py >= rect.y + rect.height - 0.25) continue;
      const dx = Math.max(rect.x + radius + 0.25 - px, 0, px - (rect.x + rect.width - radius - 0.25));
      const dy = Math.max(rect.y + radius + 0.25 - py, 0, py - (rect.y + rect.height - radius - 0.25));
      if (dx * dx + dy * dy <= radius * radius) covered++;
    }
    if (covered) {
      const at = (y * image.width + x) * 4, alpha = covered / 16;
      pixel(image, x, y, [0, 1, 2].map(k => Math.round(color[k] * alpha + image.data[at + k] * (1 - alpha))).concat(255));
    }
  }
}
function bordered(image, rect, border, fill, radius = 0, thickness = 1) {
  box(image, rect.x, rect.y, rect.width, rect.height, border, radius);
  box(image, rect.x + thickness, rect.y + thickness, rect.width - thickness * 2,
    rect.height - thickness * 2, fill, Math.max(0, radius - thickness));
}
function text(image, x, y, chars = 8, color = [35, 40, 45, 255], scale = 1) {
  // Disconnected, non-rectangular raster glyphs, including one-pixel stems.
  const patterns = [
    ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
    ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
    ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  ];
  for (let n = 0; n < chars; n++) {
    const pattern = patterns[n % patterns.length];
    for (let yy = 0; yy < 7; yy++) for (let xx = 0; xx < 5; xx++) {
      if (pattern[yy][xx] === '1') box(image, x + n * 7 * scale + xx * scale,
        y + yy * scale, scale, scale, color);
    }
  }
  return { x, y, width: (chars * 7 - 2) * scale, height: 7 * scale };
}
function near(actual, expected, tolerance = 2) {
  for (const key of ['x', 'y', 'width', 'height']) {
    assert.ok(Math.abs(actual[key] - expected[key]) <= tolerance,
      `${key}: ${JSON.stringify(actual)} expected ${JSON.stringify(expected)} ±${tolerance}`);
  }
}
function nearest(candidates, rect) {
  return candidates.slice().sort((a, b) => {
    const distance = c => ['x', 'y', 'width', 'height'].reduce((s, k) => s + Math.abs(c.rect[k] - rect[k]), 0);
    return distance(a) - distance(b);
  })[0];
}
function requireRect(candidates, rect, tolerance = 2) {
  assert.ok(candidates.length, `No candidates, expected ${JSON.stringify(rect)}`);
  const candidate = nearest(candidates, rect);
  near(candidate.rect, rect, tolerance);
  return candidate;
}
function random(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state >>> 24; };
}

function fixtureInside(shape, x, y, w, h) {
  if (shape.type === 'ellipse') return ((x - w / 2) / (w / 2)) ** 2 + ((y - h / 2) / (h / 2)) ** 2 <= 1;
  if (shape.type === 'capsule') {
    const radius = Math.min(w, h) / 2;
    const cx = Math.max(radius, Math.min(w - radius, x)), cy = Math.max(radius, Math.min(h - radius, y));
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  }
  let inside = false;
  for (let i = 0, j = shape.vertices.length - 1; i < shape.vertices.length; j = i++) {
    const a = shape.vertices[j], b = shape.vertices[i];
    if ((a[1] * h > y) !== (b[1] * h > y) && x < (b[0] - a[0]) * w * (y - a[1] * h) / ((b[1] - a[1]) * h) + a[0] * w) inside = !inside;
  }
  return inside;
}
function fixtureDepth(shape, x, y, w, h) {
  if (shape.type === 'ellipse') {
    const rx = w / 2, ry = h / 2, u = (x - rx) / rx, v = (y - ry) / ry;
    return (1 - Math.hypot(u, v)) / Math.max(0.00001, Math.hypot(u / rx, v / ry));
  }
  if (shape.type === 'capsule') {
    const r = Math.min(w, h) / 2;
    return r - Math.hypot(x - Math.max(r, Math.min(w - r, x)), y - Math.max(r, Math.min(h - r, y)));
  }
  let nearest = Infinity;
  for (let i = 0; i < shape.vertices.length; i++) {
    const a = shape.vertices[i], b = shape.vertices[(i + 1) % shape.vertices.length];
    const ax = a[0] * w, ay = a[1] * h, dx = (b[0] - a[0]) * w, dy = (b[1] - a[1]) * h;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    nearest = Math.min(nearest, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return nearest;
}
function paintShape(image, rect, shape, color, options = {}) {
  for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
    let coverage = 0;
    for (const sy of [0.125, 0.375, 0.625, 0.875]) for (const sx of [0.125, 0.375, 0.625, 0.875]) {
      const px = x + sx - rect.x, py = y + sy - rect.y;
      if (!fixtureInside(shape, px, py, rect.width, rect.height)) continue;
      if (options.stroke && fixtureDepth(shape, px, py, rect.width, rect.height) > options.stroke) continue;
      if (options.arcGap) {
        const angle = (Math.atan2(py - rect.height / 2, px - rect.width / 2) + Math.PI * 2) % (Math.PI * 2);
        if (angle > options.arcGap[0] && angle < options.arcGap[1]) continue;
      }
      coverage++;
    }
    if (!coverage) continue;
    const at = (y * image.width + x) * 4, alpha = coverage / 16;
    const paint = options.texture ? options.texture(x, y) : color;
    pixel(image, x, y, [0, 1, 2].map(k => Math.round(paint[k] * alpha + image.data[at + k] * (1 - alpha))).concat(255));
  }
}
const commonShapes = [
  { name: 'circle', type: 'ellipse', width: 48, height: 48 },
  { name: 'ellipse', type: 'ellipse', width: 80, height: 50 },
  { name: 'capsule', type: 'capsule', width: 112, height: 42 },
  { name: 'diamond', type: 'polygon', width: 80, height: 64, vertices: [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]] },
  { name: 'triangle', type: 'polygon', width: 80, height: 66, vertices: [[0.5, 0], [1, 1], [0, 1]] },
  { name: 'hexagon', type: 'polygon', width: 88, height: 60, vertices: [[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]] },
  { name: 'trapezoid', type: 'polygon', width: 88, height: 60, vertices: [[0.25, 0], [0.75, 0], [1, 1], [0, 1]] },
  { name: 'parallelogram', type: 'polygon', width: 88, height: 60, vertices: [[0.25, 0], [1, 0], [0.75, 1], [0, 1]] },
];

test('light and dark rounded fills keep input-pixel bounds, labels are not targets', () => {
  for (const dark of [false, true]) {
    const image = rgba(360, 180, dark ? [23, 26, 32, 255] : [250, 250, 250, 255]);
    const rect = { x: 57, y: 63, width: 146, height: 42 };
    box(image, rect.x, rect.y, rect.width, rect.height, dark ? [67, 117, 205, 255] : [24, 93, 207, 255], 10);
    text(image, 77, 77, 7, [255, 255, 255, 255], 2);
    const candidates = engine.detect(image);
    const found = requireRect(candidates, rect);
    assert.equal(found.kind, 'control');
    assert.equal(engine.pick(candidates, { x: 95, y: 84 })?.id, found.id);
    assert.ok(!candidates.some(c => c.kind === 'text'), JSON.stringify(candidates));
  }
});

test('white-on-white thin bordered card and dark thin border', () => {
  for (const dark of [false, true]) {
    const background = dark ? [26, 29, 35, 255] : [255, 255, 255, 255];
    const image = rgba(400, 300, background);
    const rect = { x: 49, y: 38, width: 278, height: 211 };
    bordered(image, rect, dark ? [56, 60, 68, 255] : [221, 224, 228, 255], background, 9);
    requireRect(engine.detect(image), rect, 2);
  }
});

test('faint one-pixel outlines, large panels and antialiased rounded silhouettes survive', () => {
  const large = rgba(1280, 800);
  const panel = { x: 87, y: 63, width: 1060, height: 652 };
  bordered(large, panel, [250, 250, 250, 255], [255, 255, 255, 255], 10);
  requireRect(engine.detect(large), panel, 2);
  for (const dark of [false, true]) {
    const image = rgba(340, 170, dark ? [24, 27, 32, 255] : [255, 255, 255, 255]);
    const button = { x: 61, y: 57, width: 151, height: 43 };
    antialiasedBox(image, button, dark ? [65, 124, 225, 255] : [26, 101, 212, 255], 11);
    requireRect(engine.detect(image), button, 3);
  }
});

test('nested card, heading and labeled button choose button rather than card/glyph', () => {
  const image = rgba(480, 360, [247, 248, 250, 255]);
  const card = { x: 42, y: 35, width: 370, height: 278 };
  const button = { x: 221, y: 234, width: 145, height: 44 };
  bordered(image, card, [214, 218, 224, 255], [255, 255, 255, 255], 12);
  text(image, 72, 70, 11, [30, 37, 47, 255], 2);
  text(image, 72, 112, 14, [94, 99, 108, 255]);
  box(image, button.x, button.y, button.width, button.height, [35, 104, 220, 255], 8);
  text(image, 244, 249, 7, [255, 255, 255, 255], 2);
  const candidates = engine.detect(image);
  const outer = requireRect(candidates, card);
  const inner = requireRect(candidates, button);
  assert.equal(engine.pick(candidates, { x: 286, y: 255 })?.id, inner.id);
  assert.equal(engine.pick(candidates, { x: 286, y: 255 }, outer)?.id, inner.id);
  assert.equal(engine.pick(candidates, { x: 389, y: 290 })?.id, outer.id);
});

test('standalone foreground glyphs become a word/line group, never separate glyph targets', () => {
  for (const dark of [false, true]) {
    const image = rgba(420, 130, dark ? [22, 24, 29, 255] : [255, 255, 255, 255]);
    const ink = text(image, 47, 53, 12, dark ? [226, 231, 238, 255] : [40, 45, 52, 255], 2);
    const candidates = engine.detect(image);
    const group = requireRect(candidates, { x: ink.x - 2, y: ink.y - 2, width: ink.width + 4, height: ink.height + 4 });
    assert.equal(group.kind, 'text');
    assert.equal(candidates.length, 1);
    assert.equal(engine.pick(candidates, { x: 80, y: 58 })?.id, group.id);
    assert.equal(engine.pick(candidates, { x: 20, y: 20 }), null);
  }
});

test('two nearly touching controls remain separate rather than merged into a group', () => {
  const image = rgba(350, 160);
  const a = { x: 40, y: 55, width: 109, height: 41 };
  const b = { x: 152, y: 55, width: 109, height: 41 };
  for (const rect of [a, b]) box(image, rect.x, rect.y, rect.width, rect.height, [42, 108, 211, 255], 8);
  const candidates = engine.detect(image);
  const ca = requireRect(candidates, a), cb = requireRect(candidates, b);
  assert.notEqual(ca.id, cb.id);
  assert.equal(engine.pick(candidates, { x: 95, y: 75 })?.id, ca.id);
  assert.equal(engine.pick(candidates, { x: 200, y: 75 })?.id, cb.id);
  assert.equal(engine.pick(candidates, { x: 150, y: 75 }), null);
});

test('blank, transparent hidden RGB, random noise, and smooth photo-like paint abstain', () => {
  assert.deepEqual(engine.detect(rgba(200, 140)), []);
  assert.deepEqual(engine.detect(rgba(200, 140, [20, 22, 25, 255])), []);
  const transparent = rgba(200, 140, [50, 100, 150, 0]);
  const rng = random(123);
  for (let i = 0; i < transparent.data.length; i += 4) {
    transparent.data[i] = rng(); transparent.data[i + 1] = rng(); transparent.data[i + 2] = rng();
  }
  assert.deepEqual(engine.detect(transparent), []);
  const noise = rgba(240, 180);
  for (let i = 0; i < noise.data.length; i += 4) {
    noise.data[i] = rng(); noise.data[i + 1] = rng(); noise.data[i + 2] = rng();
  }
  assert.deepEqual(engine.detect(noise), []);
  const photo = rgba(320, 200);
  for (let y = 0; y < photo.height; y++) for (let x = 0; x < photo.width; x++) {
    pixel(photo, x, y, [Math.round(90 + 60 * Math.sin(x / 30) * Math.cos(y / 21)),
      Math.round(110 + x * 0.2 + 30 * Math.sin(y / 13)), Math.round(70 + y * 0.5), 255]);
  }
  assert.deepEqual(engine.detect(photo), []);
});

test('validation rejects hostile dimensions, storage, options and budgets before allocation', () => {
  for (const dimensions of [[NaN, 80], [Infinity, 80], [80.5, 80], ['80', 80]]) {
    assert.throws(() => engine.detect({ width: dimensions[0], height: dimensions[1], data: new Uint8ClampedArray() }), TypeError);
  }
  for (const dimensions of [[0, 80], [-1, 80], [7, 80], [1601, 80], [1600, 1600], [Number.MAX_SAFE_INTEGER, 80]]) {
    assert.throws(() => engine.detect({ width: dimensions[0], height: dimensions[1], data: new Uint8ClampedArray() }), RangeError);
  }
  assert.throws(() => engine.detect(null), TypeError);
  assert.throws(() => engine.detect({ width: 8, height: 8, data: new Uint8Array(256) }), TypeError);
  assert.throws(() => engine.detect({ width: 8, height: 8, data: new Uint8ClampedArray(255) }), RangeError);
  assert.throws(() => engine.detect({ width: 8, height: 8, data: new Uint8ClampedArray(257) }), RangeError);
  for (const options of [{ scale: NaN }, { scale: 0 }, { scale: 5 }, { maxCandidates: 401 }, { maxCandidates: 0 },
    { maxCandidates: 2.5 }, { preferredSize: 'huge' }, { preferredSize: Infinity }]) {
    assert.throws(() => engine.detect(rgba(8, 8), options), RangeError);
  }
  assert.throws(() => engine.detect(rgba(8, 8), null), TypeError);
});

test('stable ids, JSON roundtrip, no source/candidate mutation, self-contained worker factory', async () => {
  const image = rgba(280, 170);
  box(image, 55, 50, 135, 45, [23, 110, 220, 255], 8);
  paintShape(image, { x: 212, y: 52, width: 48, height: 48 }, { type: 'ellipse' }, [45, 115, 220, 255]);
  paintShape(image, { x: 65, y: 112, width: 70, height: 42 }, commonShapes.find(s => s.name === 'diamond'), [45, 115, 220, 255]);
  const before = image.data.slice();
  const first = engine.detect(image), second = engine.detect(image);
  assert.deepEqual(first, second);
  assert.deepEqual(image.data, before);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  const snapshot = JSON.stringify(first);
  assert.ok(engine.pick(JSON.parse(snapshot), { x: 100, y: 70 }));
  assert.equal(JSON.stringify(first), snapshot);
  const factoryText = createSmartSelectionEngine.toString();
  const worker = new Worker(`const { parentPort } = require('node:worker_threads');
    const engine = (${factoryText})();
    parentPort.on('message', image => parentPort.postMessage(engine.detect(image)));`, { eval: true });
  try {
    const result = await new Promise((resolve, reject) => {
      worker.once('message', resolve); worker.once('error', reject); worker.postMessage(image);
    });
    assert.deepEqual(result, first);
  } finally { await worker.terminate(); }
});

test('pick validates candidates/points and uses true containment, stable ties and limited hysteresis', () => {
  const candidate = (id, rect, score = 0.9, kind = 'control') => ({ id, rect, score, kind });
  const a = candidate('a', { x: 10, y: 20, width: 100, height: 40 });
  const b = candidate('b', { x: 13, y: 20, width: 100, height: 40 }, 0.94);
  const panel = candidate('panel', { x: 0, y: 0, width: 300, height: 200 }, 0.98, 'panel');
  assert.equal(engine.pick([a, b], { x: 50, y: 40 }), b);
  assert.equal(engine.pick([a, b], { x: 50, y: 40 }, JSON.parse(JSON.stringify(a))), a);
  assert.equal(engine.pick([a, b], { x: 111, y: 40 }, a), b);
  assert.equal(engine.pick([a, b], { x: 113, y: 40 }, b), null);
  assert.equal(engine.pick([panel, b], { x: 50, y: 40 }, panel), b);
  assert.equal(engine.pick([b], { x: 50, y: 40 }, a), b);
  const tie = candidate('z', { ...a.rect });
  assert.equal(engine.pick([tie, a], { x: 50, y: 40 }), a);
  assert.equal(engine.pick([a, tie], { x: 50, y: 40 }), a);
  for (const point of [null, { x: NaN, y: 1 }, { x: Infinity, y: 2 }, { x: -1, y: 20 }, { x: 20, y: -1 }]) {
    assert.equal(engine.pick([a], point, a), null);
  }
  assert.equal(engine.pick(null, { x: 2, y: 2 }), null);
  assert.equal(engine.pick([null, {}, candidate('bad', { x: 0, y: 0, width: Infinity, height: 20 }),
    candidate('negative', { x: -1, y: 0, width: 20, height: 20 }), candidate('nan', a.rect, NaN)], { x: 15, y: 25 }), null);
});

test('scale and optional size preferences preserve raster geometry', () => {
  const image = rgba(360, 220);
  const rect = { x: 50, y: 60, width: 220, height: 66 };
  box(image, rect.x, rect.y, rect.width, rect.height, [30, 100, 210, 255], 12);
  for (const options of [{ scale: 1.5 }, { preferredSize: 'large' }, { preferredSize: 120 }]) {
    requireRect(engine.detect(image, options), rect);
  }
});

test('optional desired-size scoring can deliberately favor the outer panel', () => {
  const image = rgba(500, 360, [245, 247, 250, 255]);
  const panel = { x: 40, y: 35, width: 380, height: 270 };
  const button = { x: 240, y: 225, width: 130, height: 40 };
  bordered(image, panel, [210, 215, 225, 255], [255, 255, 255, 255], 10);
  box(image, button.x, button.y, button.width, button.height, [26, 100, 210, 255], 8);
  const point = { x: 300, y: 245 };
  const normal = engine.detect(image);
  near(engine.pick(normal, point).rect, button);
  for (const preferredSize of ['large', Math.sqrt(panel.width * panel.height)]) {
    const preferred = engine.detect(image, { preferredSize });
    near(engine.pick(preferred, point).rect, panel);
  }
});

test('1280x800 repeated screenshot fixture: deterministic cap and performance observation', t => {
  const image = rgba(1280, 800, [242, 244, 248, 255]);
  const buttons = [];
  for (let row = 0; row < 4; row++) for (let col = 0; col < 5; col++) {
    const x = 18 + col * 253, y = 18 + row * 193;
    bordered(image, { x, y, width: 233, height: 173 }, [215, 220, 228, 255], [255, 255, 255, 255], 10);
    text(image, x + 15, y + 18, 10, [42, 48, 59, 255], 2);
    text(image, x + 15, y + 58, 17, [100, 108, 120, 255]);
    const button = { x: x + 102, y: y + 117, width: 114, height: 38 };
    box(image, button.x, button.y, button.width, button.height, [29, 99, 219, 255], 8);
    text(image, button.x + 13, button.y + 12, 6, [255, 255, 255, 255], 2);
    buttons.push(button);
  }
  const timings = [];
  let candidates;
  for (let iteration = 0; iteration < 3; iteration++) {
    const started = performance.now(); candidates = engine.detect(image); timings.push(performance.now() - started);
  }
  for (const button of buttons) {
    const found = requireRect(candidates, button, 2);
    assert.equal(engine.pick(candidates, { x: button.x + 50, y: button.y + 18 })?.id, found.id);
  }
  assert.ok(candidates.length <= 400);
  assert.deepEqual(engine.detect(image), candidates);
  assert.ok(engine.detect(image, { maxCandidates: 9 }).length <= 9);
  t.diagnostic(`1280x800 fixture: ${candidates.length} candidates; detect milliseconds ${timings.map(n => n.toFixed(1)).join(', ')} (observation only)`);
});

test('eight closed common shapes: AA filled/one-pixel outline, light/dark and labels', () => {
  for (const shape of commonShapes) for (const dark of [false, true]) for (const outlined of [false, true]) {
    const image = rgba(260, 180, dark ? [24, 27, 32, 255] : [255, 255, 255, 255]);
    const rect = { x: 64, y: 52, width: shape.width, height: shape.height };
    paintShape(image, rect, shape, dark ? [100, 157, 238, 255] : [37, 105, 210, 255], outlined ? { stroke: 1 } : {});
    text(image, rect.x + Math.floor((rect.width - 19) / 2), rect.y + Math.floor((rect.height - 7) / 2), 3,
      outlined ? (dark ? [220, 230, 245, 255] : [40, 45, 55, 255]) : [255, 255, 255, 255]);
    const candidates = engine.detect(image);
    const found = requireRect(candidates, rect, 3);
    assert.equal(found.shape, shape.type, `${shape.name} dark=${dark} outlined=${outlined} ${JSON.stringify(candidates)}`);
    if (shape.type === 'polygon') {
      assert.equal(found.shapeName, shape.name);
      assert.deepEqual(found.outline, shape.vertices);
      assert.ok(found.outline.every(p => p.every(v => Number.isFinite(v) && v >= 0 && v <= 1)));
    }
    assert.equal(engine.pick(candidates, { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })?.id, found.id,
      `${shape.name} dark=${dark} outlined=${outlined}: ${JSON.stringify(candidates)}`);
    assert.equal(engine.pick([found], { x: found.rect.x + 0.5, y: found.rect.y + 0.5 }, found), null,
      `${shape.name} must not own an empty bbox corner`);
    assert.ok(!candidates.some(c => c.kind === 'text'), `internal label ${JSON.stringify(candidates)}`);
  }
});

test('bounded polygon orientations and vertical capsule metadata match the actual silhouette', () => {
  const variants = [
    { name: 'capsule', type: 'capsule', width: 42, height: 110 },
    { name: 'triangle', type: 'polygon', vertices: [[0, 0], [1, 0], [0.5, 1]] },
    { name: 'triangle', type: 'polygon', vertices: [[0, 0.5], [1, 0], [1, 1]] },
    { name: 'triangle', type: 'polygon', vertices: [[0, 0], [1, 0.5], [0, 1]] },
    { name: 'hexagon', type: 'polygon', vertices: [[0.5, 0], [1, 0.25], [1, 0.75], [0.5, 1], [0, 0.75], [0, 0.25]] },
    { name: 'trapezoid', type: 'polygon', vertices: [[0, 0], [1, 0], [0.75, 1], [0.25, 1]] },
    { name: 'trapezoid', type: 'polygon', vertices: [[0.15, 0], [0.85, 0], [1, 1], [0, 1]] },
    { name: 'parallelogram', type: 'polygon', vertices: [[0, 0], [0.75, 0], [1, 1], [0.25, 1]] },
    { name: 'parallelogram', type: 'polygon', vertices: [[0.15, 0], [1, 0], [0.85, 1], [0, 1]] },
  ];
  for (const shape of variants) {
    const image = rgba(240, 210), rect = { x: 67, y: 45, width: shape.width || 86, height: shape.height || 68 };
    paintShape(image, rect, shape, [38, 104, 209, 255], { stroke: 1 });
    const candidate = requireRect(engine.detect(image), rect, 3);
    assert.equal(candidate.shape, shape.type);
    if (shape.vertices) { assert.equal(candidate.shapeName, shape.name); assert.deepEqual(candidate.outline, shape.vertices); }
  }
});

test('textured clipped circular avatars on light/dark backgrounds use closed radial edges', () => {
  for (const dark of [false, true]) {
    const image = rgba(330, 190, dark ? [23, 26, 32, 255] : [255, 255, 255, 255]);
    const rect = { x: 98, y: 54, width: 64, height: 64 };
    const rng = random(2468);
    const texture = (x, y) => [35 + (rng() % 170), 45 + (rng() % 155), 40 + (rng() % 165), 255];
    paintShape(image, rect, { type: 'ellipse' }, [0, 0, 0, 255], { texture });
    const before = image.data.slice(), candidates = engine.detect(image);
    const avatar = requireRect(candidates, rect, 3);
    assert.equal(avatar.shape, 'ellipse');
    assert.equal(engine.pick(candidates, { x: 130, y: 86 })?.id, avatar.id);
    assert.deepEqual(image.data, before);
  }
});

test('open arcs, open polygons and irregular paint do not become closed shape candidates', () => {
  const arc = rgba(280, 180), circle = { type: 'ellipse' };
  paintShape(arc, { x: 72, y: 48, width: 74, height: 74 }, circle, [30, 95, 205, 255],
    { stroke: 2, arcGap: [Math.PI * 0.15, Math.PI * 0.65] });
  assert.deepEqual(engine.detect(arc).filter(c => c.shape), []);
  const open = rgba(280, 180);
  box(open, 70, 55, 90, 2, [35, 90, 200, 255]);
  box(open, 70, 55, 2, 68, [35, 90, 200, 255]);
  box(open, 158, 55, 2, 68, [35, 90, 200, 255]);
  assert.deepEqual(engine.detect(open).filter(c => c.shape), []);
  const irregular = rgba(280, 180), rng = random(97531);
  for (let y = 30; y < 140; y++) for (let x = 40; x < 230; x++) {
    if ((x * 19 + y * 7) % 23 > 5) pixel(irregular, x, y, [rng(), rng(), rng(), 255]);
  }
  assert.deepEqual(engine.detect(irregular).filter(c => c.shape), []);
});

test('acute outline line-cap spurs refine the outer triangle instead of selecting its interior', () => {
  const image = rgba(260, 190), rect = { x: 70, y: 48, width: 88, height: 72 };
  const shape = commonShapes.find(s => s.name === 'triangle'), color = [40, 95, 185, 255];
  paintShape(image, rect, shape, color, { stroke: 1.5 });
  // A square line cap at each acute base junction extends beyond the base.
  pixel(image, rect.x - 1, rect.y + rect.height - 1, color);
  pixel(image, rect.x + 1, rect.y + rect.height, color);
  pixel(image, rect.x + rect.width, rect.y + rect.height - 1, color);
  pixel(image, rect.x + rect.width - 2, rect.y + rect.height, color);
  const candidates = engine.detect(image), picked = engine.pick(candidates, { x: 114, y: 90 });
  assert.ok(picked);
  assert.equal(picked.shapeName, 'triangle');
  near(picked.rect, rect, 3);
});

test('pick rejects malformed shape metadata and applies real shape containment during hysteresis', () => {
  const base = { id: 'shape', rect: { x: 20, y: 20, width: 80, height: 60 }, score: 0.95, kind: 'control' };
  for (const shape of [{ shape: 'ellipse' }, { shape: 'capsule' },
    { shape: 'polygon', shapeName: 'diamond', outline: [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]] }]) {
    const candidate = { ...base, ...shape };
    assert.equal(engine.pick([candidate], { x: 60, y: 50 }), candidate);
    assert.equal(engine.pick([candidate], { x: 21, y: 21 }, candidate), null);
    assert.equal(engine.pick([candidate], { x: 100, y: 50 }, candidate), null);
  }
  for (const metadata of [
    { shape: 'unknown' }, { shape: 'polygon' }, { shape: 'polygon', outline: [[0, 0], [1, 0]] },
    { shape: 'polygon', outline: [[0, 0], [1, 0], [NaN, 1]] },
    { shape: 'polygon', outline: [[0, 0], [1, 0], [2, 1]] },
    { shape: 'polygon', outline: [[0, 0], [1, 0], [0, 1]], shapeName: 'bogus' },
    { shape: 'polygon', outline: [[0, 0], [0, 0], [0, 0]] },
    { shape: 'polygon', outline: Array.from({ length: 9 }, () => [0, 0]) },
    { shape: 'polygon', outline: [null, [1, 0], [0, 1]] },
  ]) assert.equal(engine.pick([{ ...base, ...metadata }], { x: 60, y: 50 }), null);
});

test('dense adversarial rectangular tiling has bounded deterministic output', () => {
  const image = rgba(1280, 800);
  for (let y = 3; y + 16 < image.height; y += 20) for (let x = 3; x + 16 < image.width; x += 20) {
    box(image, x, y, 16, 16, [30, 100, 210, 255]);
  }
  const first = engine.detect(image);
  assert.equal(first.length, 400);
  assert.deepEqual(engine.detect(image), first);
});
