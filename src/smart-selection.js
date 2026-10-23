// Independently authored screenshot geometry heuristics, MIT-compatible.
// No DOM, dependencies, network, source image mutation, or outer-scope state.
export function createSmartSelectionEngine() {
  const MAX_PIXELS = 2000000;
  const MAX_DIMENSION = 1600;
  const MAX_CANDIDATES = 400;

  function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
  function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }
  function area(candidate) { return candidate.rect.width * candidate.rect.height; }
  function contains(rect, x, y) {
    return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
  }
  function validShape(candidate) {
    if (candidate.shape === undefined || candidate.shape === 'ellipse' || candidate.shape === 'capsule') return true;
    if (candidate.shape !== 'polygon' || !Array.isArray(candidate.outline) || candidate.outline.length < 3 || candidate.outline.length > 8) return false;
    let twiceArea = 0;
    for (let i = 0; i < candidate.outline.length; i++) {
      const p = candidate.outline[i], q = candidate.outline[(i + 1) % candidate.outline.length];
      if (!Array.isArray(p) || p.length !== 2 || !p.every(v => finite(v) && v >= 0 && v <= 1) ||
        !Array.isArray(q) || q.length !== 2 || !q.every(v => finite(v) && v >= 0 && v <= 1)) return false;
      twiceArea += p[0] * q[1] - q[0] * p[1];
    }
    return Math.abs(twiceArea) >= 0.02 && (candidate.shapeName === undefined ||
      ['triangle', 'diamond', 'hexagon', 'trapezoid', 'parallelogram'].includes(candidate.shapeName));
  }
  function inCandidate(candidate, x, y) {
    const r = candidate.rect;
    if (!contains(r, x, y)) return false;
    if (candidate.shape === 'ellipse') {
      const u = (x - r.x) / r.width * 2 - 1, v = (y - r.y) / r.height * 2 - 1;
      return u * u + v * v <= 1;
    }
    if (candidate.shape === 'capsule') {
      const radius = Math.min(r.width, r.height) / 2;
      const cx = clamp(x, r.x + radius, r.x + r.width - radius);
      const cy = clamp(y, r.y + radius, r.y + r.height - radius);
      return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
    }
    if (candidate.shape === 'polygon') {
      const u = (x - r.x) / r.width, v = (y - r.y) / r.height;
      let inside = false;
      for (let i = 0, j = candidate.outline.length - 1; i < candidate.outline.length; j = i++) {
        const a = candidate.outline[j], b = candidate.outline[i];
        const cross = (u - a[0]) * (b[1] - a[1]) - (v - a[1]) * (b[0] - a[0]);
        if (Math.abs(cross) < 1e-10 && u >= Math.min(a[0], b[0]) && u <= Math.max(a[0], b[0]) &&
          v >= Math.min(a[1], b[1]) && v <= Math.max(a[1], b[1])) return true;
        if ((a[1] > v) !== (b[1] > v) && u < (b[0] - a[0]) * (v - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
      }
      return inside;
    }
    return true;
  }
  function sameShapeContour(a, b) {
    if (!a.shape || a.shape !== b.shape || a.shapeName !== b.shapeName) return false;
    const p = a.rect, q = b.rect;
    if (Math.abs(p.x + p.width / 2 - q.x - q.width / 2) > 2 ||
      Math.abs(p.y + p.height / 2 - q.y - q.height / 2) > 2 ||
      Math.min(area(a), area(b)) / Math.max(area(a), area(b)) < 0.65) return false;
    if (a.shape !== 'polygon') return Math.abs(p.x - q.x) <= 4 && Math.abs(p.y - q.y) <= 4 &&
      Math.abs(p.x + p.width - q.x - q.width) <= 4 && Math.abs(p.y + p.height - q.y - q.height) <= 4;
    if (a.outline.length !== b.outline.length) return false;
    // Acute polygon tips can move several bbox pixels for a one-pixel stroke.
    // Compare corresponding edge-normal offsets, not the tip's bbox distance.
    for (let i = 0; i < a.outline.length; i++) {
      const j = (i + 1) % a.outline.length, u = a.outline[i], v = a.outline[j];
      if (u[0] !== b.outline[i][0] || u[1] !== b.outline[i][1]) return false;
      const ax = p.x + u[0] * p.width, ay = p.y + u[1] * p.height;
      const dx = (v[0] - u[0]) * p.width, dy = (v[1] - u[1]) * p.height, length = Math.hypot(dx, dy);
      for (const k of [i, j]) {
        const bx = q.x + b.outline[k][0] * q.width, by = q.y + b.outline[k][1] * q.height;
        if (Math.abs((bx - ax) * dy - (by - ay) * dx) / length > 4) return false;
      }
    }
    return true;
  }
  function encloses(outer, inner) {
    return inner.x >= outer.x && inner.y >= outer.y &&
      inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
  }
  function order(a, b) {
    return b.score - a.score || area(a) - area(b) || a.rect.y - b.rect.y ||
      a.rect.x - b.rect.x || a.rect.width - b.rect.width || a.rect.height - b.rect.height ||
      (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0);
  }
  function difference(a, b) {
    return Math.max(Math.abs((a & 255) - (b & 255)),
      Math.abs(((a >>> 8) & 255) - ((b >>> 8) & 255)),
      Math.abs(((a >>> 16) & 255) - ((b >>> 16) & 255)));
  }

  /**
   * Input is RGBA Uint8ClampedArray, 8..1600 on each axis, <=2,000,000 pixels.
   * Options: scale (0.25..4, pixels per UI unit), maxCandidates (1..400),
   * preferredSize ('small' default, 'large', or a desired sqrt-area in pixels).
   * Output coordinates always refer to the original input, with exclusive right/bottom.
   * Nonrectangular candidates additionally carry shape: ellipse/capsule/polygon;
   * polygons have a plain normalized outline (3..8 pairs) and shapeName. The
   * source rect remains a bounding rectangle, never a circular/polygonal crop.
   * Inferred layout groups use kind row/paragraph, role, lineCount and fontHeight;
   * these are pixel-layout hypotheses, not DOM/accessibility or OCR semantics.
   * Invalid input throws TypeError/RangeError; a valid unstructured image returns [].
   */
  function detect(image, options = {}) {
    if (!image || typeof image !== 'object') throw new TypeError('Expected an RGBA image');
    const { width, height, data } = image;
    if (!finite(width) || !finite(height) || !Number.isInteger(width) || !Number.isInteger(height)) {
      throw new TypeError('Image dimensions must be finite integers');
    }
    if (width < 8 || height < 8 || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
      throw new RangeError('Image exceeds the 8..1600 axis / 2,000,000 pixel budget');
    }
    if (!(data instanceof Uint8ClampedArray)) throw new TypeError('Expected RGBA Uint8ClampedArray');
    if (data.length !== width * height * 4) throw new RangeError('RGBA byte length does not match dimensions');
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Expected options object');
    const scale = options.scale === undefined ? 1 : options.scale;
    if (!finite(scale) || scale < 0.25 || scale > 4) throw new RangeError('scale must be 0.25..4');
    const limit = options.maxCandidates === undefined ? MAX_CANDIDATES : options.maxCandidates;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CANDIDATES) throw new RangeError('maxCandidates must be 1..400');
    const preference = options.preferredSize === undefined ? 'small' : options.preferredSize;
    if (preference !== 'small' && preference !== 'large' && (!finite(preference) || preference < 4 || preference > MAX_DIMENSION)) {
      throw new RangeError('preferredSize must be small, large, or 4..1600 pixels');
    }

    const count = width * height;
    const pixels = new Uint32Array(count);
    let visible = 0;
    for (let i = 0, j = 0; i < count; i++, j += 4) {
      const alpha = data[j + 3];
      // Composite partial coverage consistently; ignore hidden RGB entirely.
      const r = Math.round((data[j] * alpha + 255 * (255 - alpha)) / 255);
      const g = Math.round((data[j + 1] * alpha + 255 * (255 - alpha)) / 255);
      const b = Math.round((data[j + 2] * alpha + 255 * (255 - alpha)) / 255);
      pixels[i] = r | (g << 8) | (b << 16) | (alpha >= 32 ? 0x1000000 : 0);
      if (alpha >= 32) visible++;
    }
    if (visible < 32) return [];
    const horizontal = new Uint8Array(count);
    const vertical = new Uint8Array(count);
    for (let y = 0, i = 0; y < height; y++) {
      for (let x = 0; x < width; x++, i++) {
        const p = pixels[i];
        horizontal[i] = x + 1 < width ? (((p ^ pixels[i + 1]) & 0x1000000) ? 255 : difference(p, pixels[i + 1])) : 255;
        vertical[i] = y + 1 < height ? (((p ^ pixels[i + width]) & 0x1000000) ? 255 : difference(p, pixels[i + width])) : 255;
      }
    }

    const labels = new Int32Array(count);
    const queue = new Int32Array(count);
    const raw = [];
    const glyphs = [];
    const fragments = [];
    const minSide = Math.max(8, Math.round(12 * scale));
    const minArea = Math.max(96, Math.round(180 * scale * scale));
    let serial = 0;

    function add(rect, score, kind, shape) {
      const size = Math.sqrt(rect.width * rect.height);
      if (preference === 'large') score *= 0.1 + 0.9 * clamp(Math.log2(size / (32 * scale)) / 4, 0, 1);
      else if (typeof preference === 'number') score *= Math.exp(-0.9 * Math.abs(Math.log2(size / preference)));
      const candidate = { id: `${kind}${shape ? `:${shape.shapeName || shape.shape}` : ''}:${rect.x},${rect.y},${rect.width},${rect.height}`, rect,
        score: Math.round(clamp(score, 0.05, 1) * 10000) / 10000, kind };
      if (shape) {
        candidate.shape = shape.shape;
        if (shape.outline) { candidate.outline = shape.outline.map(p => p.slice()); candidate.shapeName = shape.shapeName; }
      }
      raw.push(candidate);
      // Keep sorting/deduplication bounded even on an adversarial tiled raster.
      if (raw.length >= 1600) { raw.sort(order); raw.length = 800; }
      return candidate;
    }

    function perimeterSupport(x0, y0, x1, y1, label) {
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      const insetX = Math.min(Math.floor(w * 0.22), Math.round(12 * scale));
      const insetY = Math.min(Math.floor(h * 0.22), Math.round(12 * scale));
      let top = 0, bottom = 0, left = 0, right = 0;
      let contrastTop = 0, contrastBottom = 0, contrastLeft = 0, contrastRight = 0;
      for (let x = x0 + insetX; x <= x1 - insetX; x++) {
        const t = y0 * width + x, b = y1 * width + x;
        if (labels[t] === label) { top++; if (y0 > 0 && vertical[t - width] >= 4) contrastTop++; }
        if (labels[b] === label) { bottom++; if (y1 + 1 < height && vertical[b] >= 4) contrastBottom++; }
      }
      for (let y = y0 + insetY; y <= y1 - insetY; y++) {
        const l = y * width + x0, r = y * width + x1;
        if (labels[l] === label) { left++; if (x0 > 0 && horizontal[l - 1] >= 4) contrastLeft++; }
        if (labels[r] === label) { right++; if (x1 + 1 < width && horizontal[r] >= 4) contrastRight++; }
      }
      const nx = w - 2 * insetX, ny = h - 2 * insetY;
      return { membership: Math.min(top / nx, bottom / nx, left / ny, right / ny),
        contrast: Math.min(contrastTop / nx, contrastBottom / nx, contrastLeft / ny, contrastRight / ny) };
    }

    const polygonTemplates = [
      { shape: 'polygon', shapeName: 'diamond', outline: [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]], fill: 0.5 },
      { shape: 'polygon', shapeName: 'triangle', outline: [[0.5, 0], [1, 1], [0, 1]], fill: 0.5 },
      { shape: 'polygon', shapeName: 'triangle', outline: [[0, 0], [1, 0], [0.5, 1]], fill: 0.5 },
      { shape: 'polygon', shapeName: 'triangle', outline: [[0, 0.5], [1, 0], [1, 1]], fill: 0.5 },
      { shape: 'polygon', shapeName: 'triangle', outline: [[0, 0], [1, 0.5], [0, 1]], fill: 0.5 },
      { shape: 'polygon', shapeName: 'hexagon', outline: [[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]], fill: 0.75 },
      { shape: 'polygon', shapeName: 'hexagon', outline: [[0.5, 0], [1, 0.25], [1, 0.75], [0.5, 1], [0, 0.75], [0, 0.25]], fill: 0.75 },
    ];
    // A small explicit family, not a search over arbitrary convex hulls.
    for (const inset of [0.15, 0.25]) {
      polygonTemplates.push(
        { shape: 'polygon', shapeName: 'trapezoid', outline: [[inset, 0], [1 - inset, 0], [1, 1], [0, 1]], fill: 1 - inset },
        { shape: 'polygon', shapeName: 'trapezoid', outline: [[0, 0], [1, 0], [1 - inset, 1], [inset, 1]], fill: 1 - inset },
        { shape: 'polygon', shapeName: 'parallelogram', outline: [[inset, 0], [1, 0], [1 - inset, 1], [0, 1]], fill: 1 - inset },
        { shape: 'polygon', shapeName: 'parallelogram', outline: [[0, 0], [1 - inset, 0], [1, 1], [inset, 1]], fill: 1 - inset },
      );
    }
    let templateChecks = 0;
    const shapeMinSide = Math.max(18, Math.round(18 * scale));

    function boundary(template, w, h) {
      const points = [];
      if (template.shape === 'ellipse') {
        for (let i = 0; i < 72; i++) {
          const angle = (i + 0.5) * Math.PI * 2 / 72, c = Math.cos(angle), s = Math.sin(angle);
          const nx = c / w, ny = s / h, length = Math.hypot(nx, ny);
          points.push([w / 2 + w / 2 * c, h / 2 + h / 2 * s, nx / length, ny / length]);
        }
      } else if (template.shape === 'capsule') {
        const horizontal = w >= h, long = Math.max(w, h), short = Math.min(w, h), r = short / 2;
        function put(x, y, nx, ny) { points.push(horizontal ? [x, y, nx, ny] : [y, x, ny, nx]); }
        for (let i = 0; i < 18; i++) { const t = (i + 0.5) / 18; put(r + (long - short) * t, 0, 0, -1); }
        for (let i = 0; i < 18; i++) {
          const a = -Math.PI / 2 + (i + 0.5) * Math.PI / 18;
          put(long - r + r * Math.cos(a), r + r * Math.sin(a), Math.cos(a), Math.sin(a));
        }
        for (let i = 0; i < 18; i++) { const t = (i + 0.5) / 18; put(long - r - (long - short) * t, short, 0, 1); }
        for (let i = 0; i < 18; i++) {
          const a = Math.PI / 2 + (i + 0.5) * Math.PI / 18;
          put(r + r * Math.cos(a), r + r * Math.sin(a), Math.cos(a), Math.sin(a));
        }
      } else {
        const vertices = template.outline, perSide = 72 / vertices.length;
        for (let i = 0; i < vertices.length; i++) {
          const a = vertices[i], b = vertices[(i + 1) % vertices.length];
          const dx = (b[0] - a[0]) * w, dy = (b[1] - a[1]) * h, length = Math.hypot(dx, dy);
          for (let j = 0; j < perSide; j++) {
            const t = (j + 0.5) / perSide;
            points.push([a[0] * w + dx * t, a[1] * h + dy * t, dy / length, -dx / length]);
          }
        }
      }
      return points;
    }

    function refinePolygonRect(rect, observations) {
      // Fit only four bbox parameters to an already closed boundary. This
      // removes raster line-cap spurs, not arbitrary free-form polygon vertices.
      const matrix = Array.from({ length: 4 }, () => [0, 0, 0, 0, 0]);
      for (const o of observations) {
        const row = [o[2], o[3], o[2] * o[0], o[3] * o[1]];
        for (let i = 0; i < 4; i++) {
          for (let j = 0; j < 4; j++) matrix[i][j] += row[i] * row[j];
          matrix[i][4] += row[i] * o[4];
        }
      }
      for (let i = 0; i < 4; i++) matrix[i][i] += 0.0001;
      for (let col = 0; col < 4; col++) {
        let pivot = col;
        for (let row = col + 1; row < 4; row++) if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) pivot = row;
        [matrix[col], matrix[pivot]] = [matrix[pivot], matrix[col]];
        const divisor = matrix[col][col];
        if (Math.abs(divisor) < 1e-8) return null;
        for (let j = col; j < 5; j++) matrix[col][j] /= divisor;
        for (let row = 0; row < 4; row++) if (row !== col) {
          const factor = matrix[row][col];
          for (let j = col; j < 5; j++) matrix[row][j] -= factor * matrix[col][j];
        }
      }
      const [dx, dy, dw, dh] = matrix.map(row => row[4]);
      if (![dx, dy, dx + dw, dy + dh].every(v => finite(v) && Math.abs(v) <= 3)) return null;
      const x = Math.round(rect.x + dx), y = Math.round(rect.y + dy);
      const right = Math.round(rect.x + rect.width + dx + dw), bottom = Math.round(rect.y + rect.height + dy + dh);
      if (x === rect.x && y === rect.y && right === rect.x + rect.width && bottom === rect.y + rect.height) return null;
      if (x < 1 || y < 1 || right >= width || bottom >= height || right - x < shapeMinSide || bottom - y < shapeMinSide) return null;
      return { x, y, width: right - x, height: bottom - y };
    }

    function closedTemplate(rect, label, template, allowRefine = false) {
      // Fixed templates/samples and a shared cap bound work even on tiled input.
      if (++templateChecks > 6000) return null;
      const points = boundary(template, rect.width, rect.height), referenceX = rect.x - 3, referenceY = rect.y - 3;
      if (referenceX < 0 || referenceY < 0) return null;
      const background = pixels[referenceY * width + referenceX];
      const sectors = Array.from({ length: 8 }, () => ({ total: 0, support: 0, offsets: 0, flat: 0 }));
      const offsets = [], observations = [];
      let supported = 0, exterior = 0;
      for (let i = 0; i < points.length; i++) {
        const [px, py, nx, ny] = points[i], x = rect.x + px, y = rect.y + py;
        const sector = sectors[Math.floor(i * 8 / points.length)]; sector.total++;
        const ox = Math.floor(x + nx * 4), oy = Math.floor(y + ny * 4);
        const fx = Math.floor(x + nx * 7), fy = Math.floor(y + ny * 7);
        if (ox < 0 || ox >= width || oy < 0 || oy >= height || fx < 0 || fx >= width || fy < 0 || fy >= height) continue;
        const at = oy * width + ox, outside = pixels[at];
        if (difference(outside, background) <= 16 && difference(outside, pixels[fy * width + fx]) <= 12 &&
          horizontal[at] <= 12 && vertical[at] <= 12) { exterior++; sector.flat++; }
        let member = false, first = null;
        for (let d = 2; d >= -2; d -= 0.5) {
          const xx = Math.floor(x + nx * d), yy = Math.floor(y + ny * d);
          if (xx < 0 || xx >= width || yy < 0 || yy >= height) continue;
          const p = yy * width + xx;
          if (labels[p] === label) member = true;
          if (first === null && difference(pixels[p], outside) >= 4) first = d;
        }
        if (member && first !== null) {
          supported++; sector.support++; sector.offsets += first; offsets.push(first);
          if (allowRefine) observations.push([px / rect.width, py / rect.height, nx, ny, first]);
        }
      }
      const coverage = supported / points.length, uniform = exterior / points.length;
      if (coverage < 0.94 || uniform < 0.90 || sectors.some(s => s.support / s.total < 0.85 || s.flat / s.total < 0.75)) return null;
      const mean = offsets.reduce((sum, value) => sum + value, 0) / offsets.length;
      const deviation = offsets.reduce((sum, value) => sum + Math.abs(value - mean), 0) / offsets.length;
      const sectorOffsets = sectors.map(s => s.offsets / s.support);
      // A square/rounded rectangle can intersect an inscribed ellipse at a few
      // angles, but its boundary offset varies strongly around the perimeter.
      if (deviation > 0.80 || Math.max(...sectorOffsets) - Math.min(...sectorOffsets) > 1.8) {
        if (allowRefine && template.shape === 'polygon') {
          const refined = refinePolygonRect(rect, observations);
          if (refined) return closedTemplate(refined, label, template, false);
        }
        return null;
      }
      return { coverage, uniform, fit: 1 - Math.min(1, deviation), rect };
    }

    function matchShape(rect, label, occupancy, edgeOnly) {
      const w = rect.width, h = rect.height;
      if (w < shapeMinSide || h < shapeMinSide || w > h * 4 || h > w * 4 ||
        w * h > count * 0.70 || templateChecks >= 6000) return null;
      const templates = [{ shape: 'ellipse', fill: Math.PI / 4 }];
      if (Math.max(w, h) / Math.min(w, h) >= 1.35) templates.push({ shape: 'capsule',
        fill: 1 - (1 - Math.PI / 4) * Math.min(w, h) / Math.max(w, h) });
      templates.push(...polygonTemplates);
      let best = null;
      for (const template of templates) {
        if (!edgeOnly && occupancy >= 0.35 && (occupancy > template.fill + 0.07 || occupancy < template.fill * 0.55)) continue;
        const evidence = closedTemplate(rect, label, template, edgeOnly);
        if (!evidence) continue;
        const quality = evidence.coverage + evidence.uniform + evidence.fit * 0.15;
        if (!best || quality > best.quality) best = { template, evidence, quality };
      }
      return best;
    }

    // Two chromatic-connectivity thresholds: the low pass preserves one-pixel
    // borders, the second tolerates antialiasing and gentle UI gradients. Every
    // pixel/edge is visited a constant number of times (no recursive flood fill).
    for (const threshold of [3, 18]) {
      labels.fill(0);
      for (let seed = 0; seed < count; seed++) {
        if (labels[seed] || !(pixels[seed] & 0x1000000)) continue;
        const label = ++serial;
        let head = 0, tail = 1;
        queue[0] = seed;
        labels[seed] = label;
        let x0 = width, y0 = height, x1 = 0, y1 = 0, flat = 0;
        let minR = 255, minG = 255, minB = 255, maxR = 0, maxG = 0, maxB = 0;
        while (head < tail) {
          const at = queue[head++];
          const y = Math.floor(at / width), x = at - y * width, p = pixels[at];
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
          const r = p & 255, g = (p >>> 8) & 255, b = (p >>> 16) & 255;
          if (r < minR) minR = r; if (r > maxR) maxR = r;
          if (g < minG) minG = g; if (g > maxG) maxG = g;
          if (b < minB) minB = b; if (b > maxB) maxB = b;
          if (horizontal[at] <= 4 && vertical[at] <= 4) flat++;
          if (x && !labels[at - 1] && horizontal[at - 1] <= threshold) { labels[at - 1] = label; queue[tail++] = at - 1; }
          if (x + 1 < width && !labels[at + 1] && horizontal[at] <= threshold) { labels[at + 1] = label; queue[tail++] = at + 1; }
          if (y && !labels[at - width] && vertical[at - width] <= threshold) { labels[at - width] = label; queue[tail++] = at - width; }
          if (y + 1 < height && !labels[at + width] && vertical[at] <= threshold) { labels[at + width] = label; queue[tail++] = at + width; }
        }
        const w = x1 - x0 + 1, h = y1 - y0 + 1;
        const range = Math.max(maxR - minR, maxG - minG, maxB - minB);
        const frame = x0 === 0 || y0 === 0 || x1 === width - 1 || y1 === height - 1;
        // Glyph hypotheses are not emitted individually. Grouping below demands
        // multiple baseline-aligned pieces and flat, coherent surrounding paint.
        if (threshold === 3 && !frame && range <= 80 && h <= 48 * scale && w <= 64 * scale &&
          tail >= 2 && tail <= 1600 * scale * scale && tail / (w * h) >= 0.10) {
          const piece = { x: x0, y: y0, width: w, height: h, color: pixels[seed], pixels: tail };
          if (h >= Math.max(5, 5 * scale) && w <= h * 2.8 && glyphs.length < 6000) glyphs.push(piece);
          else if (fragments.length < 6000) fragments.push(piece);
        }
        if (frame || w < minSide || h < minSide || w * h < minArea ||
          w > h * 24 || h > w * 12 || range > 80 || w * h > count * 0.88) continue;
        const support = perimeterSupport(x0, y0, x1, y1, label);
        const occupancy = tail / (w * h);
        // A closed border may have very low occupancy but must support all four
        // straight sides. Filled regions also need locally flat interior paint.
        const isBorder = occupancy < 0.42;
        const rectangular = support.membership >= 0.66 && support.contrast >= 0.60 &&
          (isBorder ? (support.membership >= 0.84 && tail >= (w + h) * 0.8) : (occupancy >= 0.50 && flat / tail >= 0.48));
        const kind = h <= 80 * scale && w <= 480 * scale ? 'control' : 'panel';
        const rect = { x: x0, y: y0, width: w, height: h };
        if (rectangular) {
          const score = 0.67 + 0.13 * support.membership + 0.13 * support.contrast +
            (isBorder ? 0.045 : 0.035 * Math.min(1, flat / tail));
          add(rect, score, kind);
        } else {
          const match = matchShape(rect, label, occupancy, false);
          if (!match) continue;
          add(rect, 0.83 + 0.10 * match.evidence.coverage + 0.04 * match.evidence.uniform +
            0.015 * match.evidence.fit, kind, match.template);
        }
        const last = glyphs[glyphs.length - 1];
        if (threshold === 3 && last && last.x === x0 && last.y === y0 && last.width === w && last.height === h) glyphs.pop();
      }
    }

    // One additional 8-connected edge pass joins thin antialiased outline
    // fragments and the perimeter of paint-varied avatars. This does not infer
    // arbitrary hulls: every proposal must pass the same closed-template test.
    const edgeMask = new Uint8Array(count);
    for (let y = 0, i = 0; y < height; y++) for (let x = 0; x < width; x++, i++) {
      edgeMask[i] = horizontal[i] >= 12 || vertical[i] >= 12 ||
        (x > 0 && horizontal[i - 1] >= 12) || (y > 0 && vertical[i - width] >= 12) ? 1 : 0;
    }
    labels.fill(0);
    for (let seed = 0; seed < count; seed++) {
      if (!edgeMask[seed] || labels[seed]) continue;
      const label = ++serial;
      let head = 0, tail = 1, x0 = width, y0 = height, x1 = 0, y1 = 0;
      queue[0] = seed; labels[seed] = label;
      while (head < tail) {
        const at = queue[head++], y = Math.floor(at / width), x = at - y * width;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= width || (!dx && !dy)) continue;
            const next = yy * width + xx;
            if (edgeMask[next] && !labels[next]) { labels[next] = label; queue[tail++] = next; }
          }
        }
      }
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      if (x0 === 0 || y0 === 0 || x1 === width - 1 || y1 === height - 1 || tail < (w + h) * 0.8) continue;
      // The mask deliberately marks BOTH pixels beside a contrast edge. Remove
      // that one-pixel exterior halo before fitting or returning source bounds.
      const rect = { x: x0 + 1, y: y0 + 1, width: w - 2, height: h - 2 };
      const match = matchShape(rect, label, tail / (w * h), true);
      if (match) add(match.evidence.rect, 0.836 + 0.10 * match.evidence.coverage + 0.04 * match.evidence.uniform +
        0.015 * match.evidence.fit, h <= 80 * scale && w <= 480 * scale ? 'control' : 'panel', match.template);
    }

    // Assemble aligned foreground islands into text runs, not glyph boxes.
    // A capped active-row search avoids quadratic work on noisy images.
    glyphs.sort((a, b) => (a.y + a.height / 2) - (b.y + b.height / 2) || a.x - b.x);
    const rows = [];
    for (const g of glyphs) {
      const cy = g.y + g.height / 2;
      let row = null, best = Infinity;
      for (let j = rows.length - 1, checked = 0; j >= 0 && checked < 32; j--, checked++) {
        const r = rows[j], delta = Math.abs(cy - r.cy);
        if (delta <= Math.min(g.height, r.height) * 0.32 && g.height / r.height > 0.45 &&
          g.height / r.height < 2.2 && difference(g.color, r.color) < 64 && delta < best) { row = r; best = delta; }
      }
      if (row) { row.items.push(g); row.cy = (row.cy * (row.items.length - 1) + cy) / row.items.length; }
      else rows.push({ cy, height: g.height, color: g.color, items: [g] });
    }
    // Attach detached dots/diagonal tips only to nearby established lines. A
    // bounded spatial grid avoids all-pairs matching on adversarial noise.
    const bins = new Map(), cell = Math.max(12, Math.round(24 * scale));
    for (const row of rows) for (const g of row.items) {
      const key = `${Math.floor((g.x + g.width / 2) / cell)},${Math.floor((g.y + g.height / 2) / cell)}`;
      let bin = bins.get(key);
      if (!bin) { bin = []; bins.set(key, bin); }
      if (bin.length < 32) bin.push({ row, g });
    }
    for (const f of fragments) {
      let matched = null, bestDistance = Infinity;
      const cy = f.y + f.height / 2;
      const bx = Math.floor((f.x + f.width / 2) / cell), by = Math.floor(cy / cell);
      for (let yy = by - 2; yy <= by + 2; yy++) for (let xx = bx - 2; xx <= bx + 2; xx++) {
        const bin = bins.get(`${xx},${yy}`);
        if (!bin) continue;
        for (const { row, g } of bin) {
          if (row.items.length < 3 || Math.abs(cy - row.cy) > row.height * 0.65 || difference(f.color, row.color) > 32) continue;
          const dx = Math.max(0, g.x - f.x - f.width, f.x - g.x - g.width);
          const dy = Math.max(0, g.y - f.y - f.height, f.y - g.y - g.height);
          const distance = dx + dy;
          if (distance <= Math.max(1, Math.round(g.height * 0.18)) && distance < bestDistance) {
            matched = row; bestDistance = distance;
          }
        }
      }
      if (matched) {
        if (!matched.fragments) matched.fragments = [];
        if (matched.fragments.length < 128) matched.fragments.push(f);
      }
    }
    for (const row of rows) {
      row.items.sort((a, b) => a.x - b.x);
      let run = [];
      function emit() {
        if (run.length < 3) { run = []; return; }
        let x0 = width, x1 = 0, y0 = height, y1 = 0, ink = 0, totalH = 0;
        for (const g of run) {
          x0 = Math.min(x0, g.x); x1 = Math.max(x1, g.x + g.width);
          y0 = Math.min(y0, g.y); y1 = Math.max(y1, g.y + g.height);
          ink += g.pixels; totalH += g.height;
        }
        const meanH = totalH / run.length;
        for (const f of row.fragments || []) {
          if (f.x + f.width < x0 - meanH * 0.18 || f.x > x1 + meanH * 0.18) continue;
          x0 = Math.min(x0, f.x); x1 = Math.max(x1, f.x + f.width);
          y0 = Math.min(y0, f.y); y1 = Math.max(y1, f.y + f.height);
          ink += f.pixels;
        }
        const w = x1 - x0, h = y1 - y0;
        if (w < h * 1.5 || h > meanH * 1.7 || ink / (w * h) < 0.08 || ink / (w * h) > 0.85) { run = []; return; }
        // Sample the blank line margins. Photographs/noise rarely share one
        // uniform background on both sides of a full baseline-aligned run.
        let samples = 0, good = 0;
        const background = pixels[Math.max(0, y0 - 2) * width + x0];
        for (let x = x0; x < x1; x += Math.max(1, Math.floor(w / 48))) {
          for (const y of [y0 - 2, y1 + 1]) {
            if (y < 0 || y >= height) continue;
            samples++;
            if (difference(pixels[y * width + x], background) <= 12) good++;
          }
        }
        if (!samples || good / samples < 0.88 || difference(background, row.color) < 24) { run = []; return; }
        const pad = Math.max(1, Math.round(2 * scale));
        const rect = { x: Math.max(0, x0 - pad), y: Math.max(0, y0 - pad),
          width: Math.min(width, x1 + pad) - Math.max(0, x0 - pad),
          height: Math.min(height, y1 + pad) - Math.max(0, y0 - pad) };
        add(rect, 0.65 + 0.07 * Math.min(1, run.length / 8), 'text');
        run = [];
      }
      for (const g of row.items) {
        const previous = run[run.length - 1];
        if (previous && (g.x - (previous.x + previous.width) > Math.max(4 * scale, Math.max(g.height, previous.height) * 1.15) ||
          g.x < previous.x + previous.width - Math.min(g.width, previous.width) * 0.25)) emit();
        run.push(g);
      }
      emit();
    }

    const layoutGroups = [];
    function detectLayout() {
      // Dominant LOCAL paint is a reference, not a transitive neighbor flood.
      // Low-contrast AA ramps may connect a selected row to the page in the
      // chromatic passes; they do not make dark/gray text cease to be ink.
      const tile = Math.max(12, Math.round(24 * scale));
      const columns = Math.ceil(width / tile), tileRows = Math.ceil(height / tile);
      const backgrounds = new Uint32Array(columns * tileRows), confident = new Uint8Array(backgrounds.length);
      const histogram = new Uint16Array(32768), touched = new Uint16Array(tile * tile);
      function key(p) { return ((p & 255) >>> 3) | ((((p >>> 8) & 255) >>> 3) << 5) | ((((p >>> 16) & 255) >>> 3) << 10); }
      for (let ty = 0; ty < tileRows; ty++) for (let tx = 0; tx < columns; tx++) {
        const left = tx * tile, top = ty * tile, right = Math.min(width, left + tile), bottom = Math.min(height, top + tile);
        let used = 0, samples = 0, bestKey = 0, bestCount = 0;
        for (let y = top; y < bottom; y += 2) for (let x = left; x < right; x += 2) {
          const i = y * width + x;
          if (!(pixels[i] & 0x1000000)) continue;
          samples++;
          const k = key(pixels[i]);
          if (!histogram[k]) touched[used++] = k;
          const n = ++histogram[k];
          if (n > bestCount) { bestCount = n; bestKey = k; }
        }
        if (bestCount >= 4 && bestCount / Math.max(1, samples) >= 0.28) {
          let red = 0, green = 0, blue = 0, n = 0;
          for (let y = top; y < bottom; y += 2) for (let x = left; x < right; x += 2) {
            const i = y * width + x, p = pixels[i];
            if ((p & 0x1000000) && key(p) === bestKey) {
              red += p & 255; green += (p >>> 8) & 255; blue += (p >>> 16) & 255; n++;
            }
          }
          const at = ty * columns + tx;
          backgrounds[at] = Math.round(red / n) | (Math.round(green / n) << 8) | (Math.round(blue / n) << 16) | 0x1000000;
          confident[at] = 1;
        }
        for (let i = 0; i < used; i++) histogram[touched[i]] = 0;
      }
      // Dense bold text can dominate a tile that coincides exactly with a line.
      // Neighbor consensus supplies the surrounding paint without assuming that
      // ink is black or that a screenshot uses a light theme.
      const cleaned = backgrounds.slice(), cleanConfidence = confident.slice();
      for (let ty = 0; ty < tileRows; ty++) for (let tx = 0; tx < columns; tx++) {
        const neighbors = [];
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = tx + dx, yy = ty + dy;
          if (xx >= 0 && xx < columns && yy >= 0 && yy < tileRows) {
            const at = yy * columns + xx; if (confident[at]) neighbors.push(backgrounds[at]);
          }
        }
        let votes = 0, paint = 0;
        for (const candidate of neighbors) {
          let n = 0; for (const p of neighbors) if (difference(candidate, p) <= 12) n++;
          if (n > votes) { votes = n; paint = candidate; }
        }
        if (votes >= 3) { cleaned[ty * columns + tx] = paint; cleanConfidence[ty * columns + tx] = 1; }
      }
      backgrounds.set(cleaned); confident.set(cleanConfidence);
      function paintAt(x, y) { return Math.floor(y / tile) * columns + Math.floor(x / tile); }
      const ink = new Uint8Array(count), expanded = new Uint8Array(count);
      for (let y = 0, i = 0; y < height; y++) for (let x = 0; x < width; x++, i++) {
        const t = paintAt(x, y);
        if (confident[t] && (pixels[i] & 0x1000000) && difference(pixels[i], backgrounds[t]) >= 20) ink[i] = 1;
      }
      // Small separable dilation joins AA/CJK radicals and punctuation, but not
      // successive lines. Original ink, not the dilation, defines returned bounds.
      const rx = Math.max(2, Math.round(3 * scale)), ry = Math.max(1, Math.round(1.5 * scale));
      for (let y = 0; y < height; y++) {
        const start = y * width; let sum = 0;
        for (let x = 0; x <= rx && x < width; x++) sum += ink[start + x];
        for (let x = 0; x < width; x++) {
          edgeMask[start + x] = sum ? 1 : 0;
          if (x - rx >= 0) sum -= ink[start + x - rx];
          if (x + rx + 1 < width) sum += ink[start + x + rx + 1];
        }
      }
      for (let x = 0; x < width; x++) {
        let sum = 0;
        for (let y = 0; y <= ry && y < height; y++) sum += edgeMask[y * width + x];
        for (let y = 0; y < height; y++) {
          expanded[y * width + x] = sum ? 1 : 0;
          if (y - ry >= 0) sum -= edgeMask[(y - ry) * width + x];
          if (y + ry + 1 < height) sum += edgeMask[(y + ry + 1) * width + x];
        }
      }
      labels.fill(0);
      const pieces = [];
      for (let seed = 0; seed < count; seed++) {
        if (!expanded[seed] || labels[seed]) continue;
        let head = 0, tail = 1, n = 0, x0 = width, y0 = height, x1 = 0, y1 = 0, first = seed;
        queue[0] = seed; labels[seed] = 1;
        while (head < tail) {
          const at = queue[head++], y = Math.floor(at / width), x = at - y * width;
          if (ink[at]) {
            if (!n) first = at;
            n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
          }
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy; if (yy < 0 || yy >= height) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx; if (xx < 0 || xx >= width || (!dx && !dy)) continue;
              const next = yy * width + xx;
              if (expanded[next] && !labels[next]) { labels[next] = 1; queue[tail++] = next; }
            }
          }
        }
        const w = x1 - x0 + 1, h = y1 - y0 + 1;
        if (pieces.length >= 1600 || n < 4 || h < Math.max(3, 4 * scale) || h > Math.max(14, 60 * scale) ||
          w < h * 0.55 || w * h > count * 0.25 || n / (w * h) < 0.035 || n / (w * h) > 0.82) continue;
        const base = backgrounds[paintAt(first % width, Math.floor(first / width))];
        let margin = 0, good = 0;
        for (let x = x0; x <= x1; x += Math.max(1, Math.floor(w / 48))) for (const y of [y0 - 2, y1 + 2]) {
          if (y < 0 || y >= height) continue;
          margin++;
          if (difference(pixels[y * width + x], base) <= 16) good++;
        }
        if (!margin || good / margin < 0.78) continue;
        pieces.push({ x: x0, y: y0, width: w, height: h, ink: n, background: base });
      }
      function closedLabel(line) {
        return raw.find(c => {
          const r = c.rect;
          if (c.kind !== 'control' || line.width > r.width * 1.25 || line.height > r.height * 1.25 ||
            !inCandidate(c, line.x + line.width / 2, line.y + line.height / 2)) return false;
          const overlap = Math.max(0, Math.min(r.x + r.width, line.x + line.width) - Math.max(r.x, line.x)) *
            Math.max(0, Math.min(r.y + r.height, line.y + line.height) - Math.max(r.y, line.y));
          return overlap / Math.min(area(c), line.width * line.height) >= 0.80;
        });
      }
      pieces.sort((a, b) => a.y + a.height / 2 - b.y - b.height / 2 || a.x - b.x);
      const bands = [];
      for (const piece of pieces) {
        let best = null, distance = Infinity; const cy = piece.y + piece.height / 2;
        for (let i = bands.length - 1, checked = 0; i >= 0 && checked < 48; i--, checked++) {
          const band = bands[i], delta = Math.abs(cy - band.cy);
          if (delta <= Math.max(piece.height, band.height) * 0.36 && piece.height / band.height >= 0.4 &&
            piece.height / band.height <= 2.5 && delta < distance) { best = band; distance = delta; }
        }
        if (best) { best.items.push(piece); best.cy = (best.cy * (best.items.length - 1) + cy) / best.items.length; best.height = Math.max(best.height, piece.height); }
        else bands.push({ cy, height: piece.height, items: [piece] });
      }
      const lines = [];
      for (const band of bands) {
        band.items.sort((a, b) => a.x - b.x);
        let line = null;
        function finishLine() {
          if (line && line.width >= line.height * 1.8 && line.ink >= Math.max(8, line.height * 1.5)) {
            const control = closedLabel(line);
            if (!control) lines.push(line);
            else if (!control.shape && control.rect.width / control.rect.height >= 4.5 && control.rect.width >= line.height * 10) {
              line.closed = control; lines.push(line);
            }
          }
          line = null;
        }
        for (const p of band.items) {
          if (line && (p.x - line.x - line.width > Math.max(4, Math.max(line.height, p.height) * 1.8) ||
            difference(p.background, line.background) > 20)) finishLine();
          if (!line) line = { ...p, used: false };
          else {
            const right = Math.max(line.x + line.width, p.x + p.width), bottom = Math.max(line.y + line.height, p.y + p.height);
            line.x = Math.min(line.x, p.x); line.y = Math.min(line.y, p.y); line.width = right - line.x; line.height = bottom - line.y; line.ink += p.ink;
          }
        }
        finishLine();
      }
      lines.sort((a, b) => a.y - b.y || a.x - b.x);
      function group(rect, score, kind, fontHeight, children, role) {
        if (layoutGroups.length >= 160 || rect.width * rect.height > count * 0.65) return;
        const c = add(rect, score, kind); c.role = role; c.fontHeight = Math.round(fontHeight * 100) / 100;
        c.lineCount = children.length; layoutGroups.push(c);
        for (const child of children) { child.used = true; child.parentId = c.id; }
      }
      function padded(x0, y0, x1, y1, px, py) {
        const x = Math.max(0, Math.floor(x0 - px)), y = Math.max(0, Math.floor(y0 - py));
        return { x, y, width: Math.min(width, Math.ceil(x1 + px)) - x, height: Math.min(height, Math.ceil(y1 + py)) - y };
      }
      function surfaceFor(line, maxHeight) {
        const sx = Math.max(0, Math.floor(line.x)), sy = Math.max(0, line.y - 2), paint = pixels[sy * width + sx];
        let left = sx, end = sx;
        while (left > 0 && difference(pixels[sy * width + left - 1], paint) <= 3) left--;
        while (end + 1 < width && difference(pixels[sy * width + end + 1], paint) <= 3) end++;
        if (left === 0 || end + 1 === width || end - left < line.height * 5 || end - left > width * 0.8) return null;
        function painted(y) {
          let good = 0;
          for (let k = 0; k < 24; k++) {
            const x = Math.floor(left + (end - left) * (k + 0.5) / 24);
            const at = y * width + x;
            if (difference(pixels[at], paint) <= 3 || ink[at]) good++;
          }
          return good >= 16;
        }
        let top = sy, bottom = sy;
        while (top > 0 && sy - top < maxHeight && painted(top - 1)) top--;
        while (bottom + 1 < height && bottom - sy < maxHeight && painted(bottom + 1)) bottom++;
        if (bottom - top + 1 < line.height * 1.3 || bottom - top + 1 > maxHeight ||
          top > line.y || bottom < line.y + line.height - 1) return null;
        // A text band is not a painted surface boundary. Most of each outside
        // strip must actually contrast with the fixed paint on all four sides.
        const contrast = [0, 0, 0, 0], samples = 16;
        if (left < 2 || end + 2 >= width || top < 2 || bottom + 2 >= height) return null;
        for (let k = 0; k < samples; k++) {
          const x = Math.floor(left + (end - left) * (0.12 + 0.76 * (k + 0.5) / samples));
          const y = Math.floor(top + (bottom - top) * (0.15 + 0.70 * (k + 0.5) / samples));
          if (difference(pixels[(top - 2) * width + x], paint) >= 5) contrast[0]++;
          if (difference(pixels[(bottom + 2) * width + x], paint) >= 5) contrast[1]++;
          if (difference(pixels[y * width + left - 2], paint) >= 5) contrast[2]++;
          if (difference(pixels[y * width + end + 2], paint) >= 5) contrast[3]++;
        }
        if (contrast.some(n => n < samples * 0.70)) return null;
        return { x: left, y: top, width: end - left + 1, height: bottom - top + 1 };
      }
      // Visible row paint is stronger evidence than inferred list rhythm and can
      // include a leading icon that shifts the text run's apparent left edge.
      for (const line of lines) {
        if (line.closed) continue;
        const surface = surfaceFor(line, line.height * 4);
        if (surface) group(surface, 0.97, 'row', line.height, [line], 'surface-row');
      }
      // Paragraph rhythm: wrapped-line gaps must be substantially smaller than
      // paragraph/list spacing; a short final line still inherits the full width.
      for (let i = 0; i < lines.length; i++) {
        const first = lines[i]; if (first.used || first.closed) continue;
        const children = [first]; let last = first;
        for (let countLines = 1; countLines < 12; countLines++) {
          let next = null, cost = Infinity;
          for (let j = i + 1; j < lines.length; j++) {
            const l = lines[j], gap = l.y - last.y - last.height, size = Math.max(last.height, l.height);
            if (l.y > last.y + last.height + size * 1.3) break;
            if (l.used || l.closed || children.includes(l) || gap < 0 || gap > size * 1.20 ||
              gap > Math.min(last.height, l.height) * 1.10 || Math.abs(l.x - first.x) > size * 0.65 || l.height / first.height < 0.55 || l.height / first.height > 1.8 ||
              difference(l.background, first.background) > 16) continue;
            const value = gap + Math.abs(l.x - first.x);
            if (value < cost) { next = l; cost = value; }
          }
          if (!next) break;
          children.push(next); last = next;
        }
        if (children.length < 2) continue;
        const x0 = Math.min(...children.map(l => l.x)), y0 = first.y;
        const x1 = Math.max(...children.map(l => l.x + l.width)), y1 = Math.max(...children.map(l => l.y + l.height));
        const font = children.reduce((sum, l) => sum + l.height, 0) / children.length;
        group(padded(x0, y0, x1, y1, font * 0.52, font * 0.55), 0.94, 'paragraph', font, children, 'paragraph');
      }
      // Repeated left-aligned single lines establish a list's row rhythm. Color
      // is deliberately not a foreground join criterion (gray timestamps count).
      const clusters = [];
      for (const line of lines) {
        if (line.used || line.width < line.height * 3) continue;
        let cluster = null;
        for (const c of clusters) if (Math.abs(c.x - line.x) <= Math.max(4, line.height * 0.65) &&
          line.height / c.height >= 0.55 && line.height / c.height <= 1.8 && difference(line.background, c.background) <= 24) { cluster = c; break; }
        if (cluster) cluster.lines.push(line);
        else if (clusters.length < 240) clusters.push({ x: line.x, height: line.height, background: line.background, lines: [line] });
      }
      for (const cluster of clusters) {
        if (cluster.lines.length < 3) continue;
        cluster.lines.sort((a, b) => a.y - b.y);
        const heights = cluster.lines.map(l => l.height).sort((a, b) => a - b), font = heights[Math.floor(heights.length / 2)];
        const gaps = [];
        for (let i = 1; i < cluster.lines.length; i++) {
          const d = cluster.lines[i].y + cluster.lines[i].height / 2 - cluster.lines[i - 1].y - cluster.lines[i - 1].height / 2;
          if (d >= font * 1.75 && d <= font * 4.0) gaps.push(d);
        }
        if (gaps.length < 2) continue;
        gaps.sort((a, b) => a - b); const stride = gaps[Math.floor(gaps.length / 2)];
        const regular = cluster.lines.filter((l, i, a) => {
          const cy = l.y + l.height / 2;
          return (i > 0 && Math.abs(cy - a[i - 1].y - a[i - 1].height / 2 - stride) <= stride * 0.23) ||
            (i + 1 < a.length && Math.abs(a[i + 1].y + a[i + 1].height / 2 - cy - stride) <= stride * 0.23);
        });
        if (regular.length < 3) continue;
        const members = regular.map(title => {
          const cy = title.y + title.height / 2, attached = [title];
          for (const l of lines) if (!l.used && l !== title && l.x >= title.x + title.width &&
            l.x - title.x - title.width <= font * 6 && Math.abs(l.y + l.height / 2 - cy) <= font * 0.38 &&
            difference(l.background, title.background) <= 24) attached.push(l);
          return { title, cy, attached, right: Math.max(...attached.map(l => l.x + l.width)) };
        });
        const right = Math.max(...members.map(m => m.right)) + font * 0.25;
        for (const m of members) {
          if (m.title.used) continue;
          let rect = padded(cluster.x, m.cy - stride * 0.48, right, m.cy + stride * 0.48, 0, 0);
          rect.x = Math.max(0, Math.floor(cluster.x - font * 0.8)); rect.width = Math.min(width, Math.ceil(right)) - rect.x;
          let role = 'repeated-row', score = 0.91;
          // An existing closed wide surface becomes a semantic row only after
          // repeated sibling rhythm establishes list context (not for a lone button).
          const surface = m.title.closed ? { ...m.title.closed.rect } : surfaceFor(m.title, stride * 1.35);
          if (surface) { rect = surface; role = 'surface-row'; score = 0.97; }
          group(rect, score, 'row', font, m.attached, role);
        }
      }
      for (const line of lines) {
        if (line.used || line.closed) continue;
        const pad = Math.max(1, Math.round(2 * scale));
        const c = add(padded(line.x, line.y, line.x + line.width, line.y + line.height, pad, pad), 0.76, 'text');
        c.role = 'line';
      }
      // Only contributing small text is hidden; real closed controls/avatars
      // remain independent targets inside a larger inferred layout rectangle.
      for (const c of raw) for (const parent of layoutGroups) if (c !== parent && encloses(parent.rect, c.rect) &&
        (c.kind === 'text' || (c.kind === 'control' && !c.shape && c.rect.height <= parent.fontHeight * 1.25 && c.rect.width <= parent.fontHeight * 1.4))) {
        c.parentId = parent.id; break;
      }
    }
    detectLayout();
    raw.sort(order);
    // Reserve some capacity for useful layout hierarchy even on a page with
    // hundreds of closed shapes. The final total still cannot exceed the cap.
    layoutGroups.sort(order);
    const prioritized = layoutGroups.slice(0, Math.min(120, Math.ceil(limit * 0.4))).concat(raw);
    const result = [];
    for (const c of prioritized) {
      if (c.parentId && layoutGroups.some(g => g.id === c.parentId)) continue;
      // Text inside a closed control is a label, not a competing hover target.
      if (c.kind === 'text' && raw.some(r => r.kind === 'control' && encloses(r.rect, c.rect) && area(r) < area(c) * 30 &&
        inCandidate(r, c.rect.x + c.rect.width / 2, c.rect.y + c.rect.height / 2))) continue;
      let duplicate = false;
      for (const r of result) {
        const a = c.rect, b = r.rect;
        const intersection = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
          Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
        const shapeDuplicate = sameShapeContour(c, r);
        if (shapeDuplicate || intersection / (area(c) + area(r) - intersection) >= 0.86 ||
          (Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2 &&
           Math.abs(a.x + a.width - b.x - b.width) <= 2 && Math.abs(a.y + a.height - b.y - b.height) <= 2)) {
          duplicate = true; break;
        }
      }
      if (!duplicate) result.push(c);
      if (result.length === limit) break;
    }
    return result;
  }

  /** Pure deterministic picking. Previous must still exist with the same id and
   * geometry, contain the point (no sticky expanded bounds), and be within 0.07
   * utility of the best current candidate. Candidate/point objects are unmodified. */
  function pick(candidates, point, previous = null) {
    if (!Array.isArray(candidates) || !point || !finite(point.x) || !finite(point.y) || point.x < 0 || point.y < 0) return null;
    let best = null, bestUtility = -Infinity, retained = null, retainedUtility = -Infinity;
    const eligible = [];
    for (let i = 0; i < Math.min(candidates.length, MAX_CANDIDATES); i++) {
      const c = candidates[i], r = c && c.rect;
      if (!r || typeof c.id !== 'string' || typeof c.kind !== 'string' || !finite(c.score) ||
        !finite(r.x) || !finite(r.y) || !finite(r.width) || !finite(r.height) ||
        r.x < 0 || r.y < 0 || r.width < 4 || r.height < 4 || !finite(r.width * r.height) ||
        !validShape(c) || !inCandidate(c, point.x, point.y)) continue;
      eligible.push(c);
    }
    const groups = eligible.filter(c => c.kind === 'paragraph' || c.kind === 'row');
    for (const c of eligible) {
      const r = c.rect;
      if (c.parentId && eligible.some(parent => parent.id === c.parentId)) continue;
      const grouped = c.kind === 'paragraph' || c.kind === 'row';
      let kindBonus = grouped ? 0.16 : c.kind === 'control' ? 0.10 : c.kind === 'text' ? -0.015 : 0;
      if (c.kind === 'control' && c.score >= 0.8 && groups.some(g => finite(g.fontHeight) &&
        r.height >= g.fontHeight * 1.35 && area(c) < area(g) * 0.65 && encloses(g.rect, r))) kindBonus += 0.22;
      const utility = clamp(c.score, 0, 1) + kindBonus - (grouped ? 0.035 : 0.085) * Math.log2(Math.max(1, area(c) / 768));
      if (utility > bestUtility || (utility === bestUtility && (!best || order(c, best) < 0 ||
        (order(c, best) === 0 && c.id < best.id)))) { best = c; bestUtility = utility; }
      if (previous && c.id === previous.id && previous.rect && r.x === previous.rect.x && r.y === previous.rect.y &&
        r.width === previous.rect.width && r.height === previous.rect.height && previous.shape === c.shape &&
        validShape(previous) && inCandidate(previous, point.x, point.y)) { retained = c; retainedUtility = utility; }
    }
    return retained && retainedUtility >= bestUtility - 0.07 ? retained : best;
  }

  return { detect, pick };
}
