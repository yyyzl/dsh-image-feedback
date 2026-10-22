/**
 * Independent, dependency-free image-feedback data core.
 * No pixels, paths, browser objects, clocks, random IDs, or host calls live here.
 * All edits return deeply frozen snapshots and share unchanged data. Coordinates
 * use the persisted asset's pixels; translations never change a block's source.
 */
export const SCHEMA_VERSION = 'harness-image-feedback-1';
export const LIMITS = Object.freeze({ blocks: 1000, annotations: 1000, text: 20000, serialized: 2_000_000 });

export class CoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
  }
}

const knownDrafts = new WeakSet();
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const fail = (code, message) => { throw new CoreError(code, message); };
const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

function record(value, keys, required, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail('INVALID_DRAFT', `${label} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) fail('INVALID_DRAFT', `${label}: unknown field ${String(key)}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!own(descriptor, 'value')) fail('INVALID_DRAFT', `${label}.${key} cannot be an accessor`);
  }
  for (const key of required) if (!own(value, key)) fail('INVALID_DRAFT', `${label}.${key} is required`);
  return value;
}

function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('INVALID_NUMBER', `${label} must be a finite number`);
  return Object.is(value, -0) ? 0 : value;
}

function integer(value, minimum, label) {
  if (!Number.isSafeInteger(value) || value < minimum) fail('INVALID_NUMBER', `${label} must be a safe integer >= ${minimum}`);
  return Object.is(value, -0) ? 0 : value;
}

function identifier(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('INVALID_DRAFT', `${label} must be a nonempty identifier of at most 512 characters without control characters`);
  }
  return value;
}

function textValue(value) {
  if (typeof value !== 'string') fail('INVALID_DRAFT', 'Annotation text must be a string');
  if (value.length > LIMITS.text) fail('LIMIT_EXCEEDED', `Annotation text exceeds ${LIMITS.text} characters`);
  return value;
}

function pointValue(value, label = 'point') {
  record(value, ['x', 'y'], ['x', 'y'], label);
  return { x: finite(value.x, `${label}.x`), y: finite(value.y, `${label}.y`) };
}

function rectValue(value, label = 'rect') {
  record(value, ['x', 'y', 'width', 'height'], ['x', 'y', 'width', 'height'], label);
  const rect = {
    x: finite(value.x, `${label}.x`), y: finite(value.y, `${label}.y`),
    width: finite(value.width, `${label}.width`), height: finite(value.height, `${label}.height`),
  };
  if (rect.width <= 0 || rect.height <= 0) fail('INVALID_RECT', `${label} must have positive width and height`);
  if (!Number.isFinite(rect.x + rect.width) || !Number.isFinite(rect.y + rect.height)
      || rect.x + rect.width <= rect.x || rect.y + rect.height <= rect.y) {
    fail('INVALID_RECT', `${label} edges must be finite and distinguishable`);
  }
  return rect;
}

function inBounds(geometry, width, height, label) {
  const right = geometry.x + (geometry.width || 0);
  const bottom = geometry.y + (geometry.height || 0);
  if (geometry.x < 0 || geometry.y < 0 || right > width || bottom > height) {
    fail('OUT_OF_BOUNDS', `${label} must stay within the ${width} x ${height} fixed canvas`);
  }
  return geometry;
}

const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width
  && a.y < b.y + b.height && b.y < a.y + a.height;
const equalRect = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const moved = (block) => block.source.x !== block.destination.x || block.source.y !== block.destination.y;

/** Touching edges are not overlap. */
export function rectanglesOverlap(a, b) { return overlap(rectValue(a), rectValue(b)); }

/** Half-open hit areas make shared edges deterministic: left/top in, right/bottom out. */
export function containsPoint(rect, point) {
  const r = rectValue(rect); const p = pointValue(point);
  return p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;
}

export function rectFromPoints(a, b) {
  const first = pointValue(a); const second = pointValue(b);
  return freeze(rectValue({ x: Math.min(first.x, second.x), y: Math.min(first.y, second.y),
    width: Math.abs(second.x - first.x), height: Math.abs(second.y - first.y) }));
}

function transformPoint(point, transform, inverse) {
  const p = pointValue(point);
  record(transform, ['scale', 'offsetX', 'offsetY'], ['scale'], 'transform');
  const scale = finite(transform.scale, 'transform.scale');
  if (scale <= 0) fail('INVALID_NUMBER', 'transform.scale must be positive');
  const x = own(transform, 'offsetX') ? finite(transform.offsetX, 'transform.offsetX') : 0;
  const y = own(transform, 'offsetY') ? finite(transform.offsetY, 'transform.offsetY') : 0;
  return freeze(pointValue(inverse ? { x: (p.x - x) / scale, y: (p.y - y) / scale }
    : { x: p.x * scale + x, y: p.y * scale + y }));
}

/** CSS view coordinates only: DPR belongs to the renderer, not draft coordinates. */
export function viewToAsset(point, transform) { return transformPoint(point, transform, true); }
export function assetToView(point, transform) { return transformPoint(point, transform, false); }

function assetValue(value) {
  record(value, ['assetId', 'attachmentId', 'sourceEventId', 'width', 'height', 'coordinateSpace'],
    ['assetId', 'width', 'height', 'coordinateSpace'], 'asset');
  const asset = { assetId: identifier(value.assetId, 'asset.assetId') };
  if (own(value, 'attachmentId')) {
    if (typeof value.attachmentId !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.attachmentId)) {
      fail('INVALID_DRAFT', 'asset.attachmentId must be a canonical sha256 attachment identity');
    }
    asset.attachmentId = value.attachmentId;
  }
  if (own(value, 'sourceEventId')) asset.sourceEventId = identifier(value.sourceEventId, 'asset.sourceEventId');
  asset.width = integer(value.width, 1, 'asset.width');
  asset.height = integer(value.height, 1, 'asset.height');
  if (value.coordinateSpace !== 'asset-pixels') fail('INVALID_DRAFT', 'asset.coordinateSpace must be asset-pixels');
  asset.coordinateSpace = 'asset-pixels';
  return asset;
}

function targetValue(value, asset, blocks) {
  if (!value || typeof value !== 'object') fail('INVALID_DRAFT', 'Annotation target is required');
  // Read kind only after rejecting accessors and unknown fields.
  record(value, ['kind', 'space', 'point', 'rect', 'blockId', 'local'], ['kind'], 'target');
  if (value.kind === 'global') {
    record(value, ['kind'], ['kind'], 'target');
    return { kind: 'global' };
  }
  if (value.kind === 'point' || value.kind === 'region') {
    const key = value.kind === 'point' ? 'point' : 'rect';
    record(value, ['kind', 'space', key], ['kind', 'space', key], 'target');
    if (value.space !== 'layout') fail('INVALID_DRAFT', 'Free point/region annotations must explicitly use layout space');
    const geometry = key === 'point' ? pointValue(value[key]) : rectValue(value[key]);
    return { kind: value.kind, space: 'layout', [key]: inBounds(geometry, asset.width, asset.height, 'Layout annotation') };
  }
  if (value.kind === 'block') {
    record(value, ['kind', 'blockId', 'local'], ['kind', 'blockId'], 'target');
    const blockId = identifier(value.blockId, 'target.blockId');
    const block = blocks.find((item) => item.id === blockId);
    if (!block) fail('MISSING_BLOCK', `Annotation references missing block ${blockId}`);
    const target = { kind: 'block', blockId };
    if (own(value, 'local')) {
      record(value.local, ['kind', 'point', 'rect'], ['kind'], 'target.local');
      const key = value.local.kind === 'point' ? 'point' : value.local.kind === 'region' ? 'rect' : null;
      if (!key) fail('INVALID_DRAFT', 'Block-local annotation must be a point or region');
      record(value.local, ['kind', key], ['kind', key], 'target.local');
      const geometry = key === 'point' ? pointValue(value.local[key]) : rectValue(value.local[key]);
      target.local = { kind: value.local.kind,
        [key]: inBounds(geometry, block.source.width, block.source.height, 'Block-local annotation') };
    }
    return target;
  }
  fail('INVALID_DRAFT', `Unknown annotation target kind ${String(value.kind)}`);
}

function checkBinding(draft, expected) {
  if (expected === undefined) return;
  record(expected, ['sessionId', 'asset'], [], 'expected');
  if (own(expected, 'sessionId') && draft.sessionId !== expected.sessionId) fail('IDENTITY_MISMATCH', 'Draft belongs to a different session');
  if (own(expected, 'asset')) {
    record(expected.asset, ['assetId', 'attachmentId', 'sourceEventId', 'width', 'height', 'coordinateSpace'], [], 'expected.asset');
    for (const [key, value] of Object.entries(expected.asset)) {
      if (draft.asset[key] !== value) fail('IDENTITY_MISMATCH', `Draft asset ${key} does not match its bound source`);
    }
  }
}

function finishDraft(draft) {
  freeze(draft);
  knownDrafts.add(draft);
  return draft;
}

/**
 * Validate untrusted JSON-shaped input and return a detached, canonical frozen
 * value. Unknown fields (including paths, bytes and URLs) are rejected. Optional
 * expected={sessionId,asset:{assetId,attachmentId,width,height,...}} pins identity.
 * This validates data, NOT session authorization; the host still authorizes assets.
 */
export function validateDraft(value, expected) {
  if (knownDrafts.has(value)) { checkBinding(value, expected); return value; }
  record(value, ['schemaVersion', 'revision', 'sessionId', 'asset', 'blocks', 'annotations', 'nextAnnotationNumber'],
    ['schemaVersion', 'revision', 'sessionId', 'asset', 'blocks', 'annotations'], 'draft');
  if (value.schemaVersion !== SCHEMA_VERSION) fail('INVALID_DRAFT', `Unsupported schemaVersion ${String(value.schemaVersion)}`);
  const asset = assetValue(value.asset);
  const revision = integer(value.revision, 0, 'revision');
  const sessionId = identifier(value.sessionId, 'sessionId');
  if (!Array.isArray(value.blocks) || !Array.isArray(value.annotations)) fail('INVALID_DRAFT', 'blocks and annotations must be arrays');
  if (value.blocks.length > LIMITS.blocks || value.annotations.length > LIMITS.annotations) fail('LIMIT_EXCEEDED', 'Too many blocks or annotations');
  const ids = new Set(); const layers = new Set();
  const blocks = [];
  for (const item of value.blocks) {
    record(item, ['id', 'source', 'destination', 'zIndex'], ['id', 'source', 'destination', 'zIndex'], 'block');
    const id = identifier(item.id, 'block.id');
    if (ids.has(id)) fail('INVALID_DRAFT', `Duplicate block ID ${id}`);
    ids.add(id);
    const source = inBounds(rectValue(item.source, 'source'), asset.width, asset.height, 'Source');
    const destination = inBounds(rectValue(item.destination, 'destination'), asset.width, asset.height, 'Destination');
    if (source.width !== destination.width || source.height !== destination.height) fail('INVALID_RECT', 'V1 blocks only translate; destination size must equal source size');
    const zIndex = integer(item.zIndex, 0, 'block.zIndex');
    if (zIndex >= value.blocks.length || layers.has(zIndex)) fail('INVALID_DRAFT', 'Block zIndex values must be unique and contiguous from zero');
    layers.add(zIndex);
    if (blocks.some((other) => overlap(source, other.source))) fail('SOURCE_OVERLAP', `Block ${id} overlaps already-owned source pixels`);
    blocks.push({ id, source, destination, zIndex });
  }
  blocks.sort((a, b) => a.zIndex - b.zIndex);
  const annotationIds = new Set(); const numbers = new Set();
  let maximumNumber = 0;
  const annotations = [];
  for (const item of value.annotations) {
    record(item, ['id', 'number', 'text', 'target'], ['id', 'number', 'text', 'target'], 'annotation');
    const id = identifier(item.id, 'annotation.id');
    const number = integer(item.number, 1, 'annotation.number');
    if (annotationIds.has(id) || numbers.has(number)) fail('INVALID_DRAFT', 'Annotation IDs and numbers must be unique');
    annotationIds.add(id); numbers.add(number); maximumNumber = Math.max(maximumNumber, number);
    annotations.push({ id, number, text: textValue(item.text), target: targetValue(item.target, asset, blocks) });
  }
  annotations.sort((a, b) => a.number - b.number);
  const nextAnnotationNumber = own(value, 'nextAnnotationNumber')
    ? integer(value.nextAnnotationNumber, 1, 'nextAnnotationNumber') : integer(maximumNumber + 1, 1, 'nextAnnotationNumber');
  if (nextAnnotationNumber <= maximumNumber) fail('INVALID_DRAFT', 'nextAnnotationNumber must exceed every existing number');
  const draft = { schemaVersion: SCHEMA_VERSION, revision, sessionId, asset, blocks, annotations, nextAnnotationNumber };
  checkBinding(draft, expected);
  return finishDraft(draft);
}

export function createDraft(input) {
  record(input, ['sessionId', 'asset'], ['sessionId', 'asset'], 'input');
  record(input.asset, ['assetId', 'attachmentId', 'sourceEventId', 'width', 'height', 'coordinateSpace'],
    ['assetId', 'width', 'height'], 'input.asset');
  return validateDraft({ schemaVersion: SCHEMA_VERSION, revision: 0, sessionId: input.sessionId,
    asset: { ...input.asset, coordinateSpace: own(input.asset, 'coordinateSpace') ? input.asset.coordinateSpace : 'asset-pixels' },
    blocks: [], annotations: [], nextAnnotationNumber: 1 });
}

function derive(draft, patch) {
  return finishDraft({ ...draft, ...patch, revision: integer(draft.revision + 1, 0, 'revision') });
}

function blockById(draft, id) {
  const block = draft.blocks.find((item) => item.id === id);
  if (!block) fail('MISSING_BLOCK', `Block ${String(id)} does not exist`);
  return block;
}

function annotationById(draft, id) {
  const annotation = draft.annotations.find((item) => item.id === id);
  if (!annotation) fail('MISSING_ANNOTATION', `Annotation ${String(id)} does not exist`);
  return annotation;
}

function freshId(draft, kind, used) {
  const base = `${kind}-${integer(draft.revision + 1, 0, 'revision')}`;
  let id = base; let suffix = 2;
  while (used.has(id)) id = `${base}-${suffix++}`;
  used.add(id);
  return id;
}

const renumberZ = (blocks) => blocks.map((block, zIndex) => block.zIndex === zIndex ? block : { ...block, zIndex });

/** Cut a rectangle from the clean source. Existing source ownership cannot overlap. */
export function addBlock(input, sourceRect, options = {}) {
  const draft = validateDraft(input);
  record(options, ['id'], [], 'options');
  if (draft.blocks.length >= LIMITS.blocks) fail('LIMIT_EXCEEDED', 'Too many blocks');
  const source = inBounds(rectValue(sourceRect, 'source'), draft.asset.width, draft.asset.height, 'Source');
  if (draft.blocks.some((block) => overlap(block.source, source))) fail('SOURCE_OVERLAP', 'Selected source pixels already belong to a block; split that block explicitly');
  const used = new Set(draft.blocks.map((block) => block.id));
  const id = own(options, 'id') ? identifier(options.id, 'block.id') : freshId(draft, 'block', used);
  if (own(options, 'id') && used.has(id)) fail('INVALID_DRAFT', `Duplicate block ID ${id}`);
  return derive(draft, { blocks: [...draft.blocks, { id, source, destination: source, zIndex: draft.blocks.length }] });
}

/** Absolute destination coordinates. Bounds reject by default; clamp is opt-in. */
export function moveBlock(input, id, position, options = {}) {
  const draft = validateDraft(input); const block = blockById(draft, id);
  record(options, ['bounds'], [], 'options');
  const bounds = own(options, 'bounds') ? options.bounds : 'reject';
  if (bounds !== 'reject' && bounds !== 'clamp') fail('INVALID_DRAFT', 'bounds must be reject or clamp');
  const point = pointValue(position, 'destination');
  if (bounds === 'clamp') {
    point.x = Math.max(0, Math.min(draft.asset.width - block.source.width, point.x));
    point.y = Math.max(0, Math.min(draft.asset.height - block.source.height, point.y));
  }
  const destination = inBounds(rectValue({ ...point, width: block.source.width, height: block.source.height }),
    draft.asset.width, draft.asset.height, 'Destination');
  if (equalRect(destination, block.destination)) return draft;
  return derive(draft, { blocks: draft.blocks.map((item) => item.id === id ? { ...item, destination } : item) });
}

/** Restore translation only: comments, IDs and z order remain unchanged. */
export function resetBlock(input, id) {
  const draft = validateDraft(input); const block = blockById(draft, id);
  return moveBlock(draft, id, { x: block.source.x, y: block.source.y });
}

export function resetAllMoves(input) {
  const draft = validateDraft(input);
  if (!draft.blocks.some(moved)) return draft;
  return derive(draft, { blocks: draft.blocks.map((block) => moved(block) ? { ...block, destination: block.source } : block) });
}

/** order='front'|'back' or a zero-based final layer index. */
export function reorderBlock(input, id, order) {
  const draft = validateDraft(input); const block = blockById(draft, id);
  const to = order === 'front' ? draft.blocks.length - 1 : order === 'back' ? 0 : integer(order, 0, 'order');
  if (to >= draft.blocks.length) fail('OUT_OF_BOUNDS', 'Layer index is outside the block stack');
  if (to === block.zIndex) return draft;
  const blocks = draft.blocks.filter((item) => item.id !== id);
  blocks.splice(to, 0, block);
  return derive(draft, { blocks: renumberZ(blocks) });
}

function removalPolicy(options) {
  record(options, ['annotationPolicy'], [], 'options');
  const policy = own(options, 'annotationPolicy') ? options.annotationPolicy : 'reject';
  if (policy !== 'reject' && policy !== 'remove') fail('INVALID_DRAFT', 'annotationPolicy must be reject or remove');
  return policy;
}

function annotationsAfterRemoval(draft, id, options) {
  const policy = removalPolicy(options);
  const attached = draft.annotations.some((item) => item.target.kind === 'block' && item.target.blockId === id);
  if (attached && policy === 'reject') fail('ANNOTATIONS_ATTACHED', 'This block has comments; explicitly remove them or rebind them before removing/splitting it');
  return attached ? draft.annotations.filter((item) => item.target.kind !== 'block' || item.target.blockId !== id) : draft.annotations;
}

/** Deleting a cut restores its source pixels. Bound comments require explicit consent. */
export function removeBlock(input, id, options = {}) {
  const draft = validateDraft(input); blockById(draft, id);
  const annotations = annotationsAfterRemoval(draft, id, options);
  return derive(draft, { blocks: renumberZ(draft.blocks.filter((block) => block.id !== id)), annotations });
}

function replaceByParts(draft, block, parts, options) {
  const annotations = annotationsAfterRemoval(draft, block.id, options);
  if (draft.blocks.length - 1 + parts.length > LIMITS.blocks) fail('LIMIT_EXCEEDED', 'Too many blocks after splitting');
  const used = new Set(draft.blocks.map((item) => item.id));
  const children = parts.map((part) => ({ id: freshId(draft, 'block', used),
    source: rectValue({ ...part, x: block.source.x + part.x, y: block.source.y + part.y }),
    destination: rectValue({ ...part, x: block.destination.x + part.x, y: block.destination.y + part.y }), zIndex: 0 }));
  const blocks = [...draft.blocks];
  blocks.splice(block.zIndex, 1, ...children);
  // Numeric edge rounding must never turn a subdivision into overlapping pixels.
  const candidate = { ...draft, blocks: renumberZ(blocks), annotations, revision: integer(draft.revision + 1, 0, 'revision') };
  return validateDraft(candidate);
}

/** Divide a block along a local x/y coordinate; replaces it with two new IDs. */
export function splitBlock(input, id, cut, options = {}) {
  const draft = validateDraft(input); const block = blockById(draft, id);
  record(cut, ['axis', 'at'], ['axis', 'at'], 'cut');
  if (cut.axis !== 'x' && cut.axis !== 'y') fail('INVALID_DRAFT', 'Split axis must be x or y');
  const at = finite(cut.at, 'cut.at');
  const width = block.source.width; const height = block.source.height;
  if (at <= 0 || at >= (cut.axis === 'x' ? width : height)) fail('OUT_OF_BOUNDS', 'Split must be strictly inside the block in local pixels');
  const parts = cut.axis === 'x'
    ? [{ x: 0, y: 0, width: at, height }, { x: at, y: 0, width: width - at, height }]
    : [{ x: 0, y: 0, width, height: at }, { x: 0, y: at, width, height: height - at }];
  return replaceByParts(draft, block, parts, options);
}

/** Return disjoint rectangles covering rect minus its intersection with cut. */
export function subtractRect(rect, cut) {
  const a = rectValue(rect); const b = rectValue(cut);
  if (!overlap(a, b)) return freeze([a]);
  const left = Math.max(a.x, b.x); const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width); const bottom = Math.min(a.y + a.height, b.y + b.height);
  const parts = [];
  if (top > a.y) parts.push({ x: a.x, y: a.y, width: a.width, height: top - a.y });
  if (bottom < a.y + a.height) parts.push({ x: a.x, y: bottom, width: a.width, height: a.y + a.height - bottom });
  if (left > a.x) parts.push({ x: a.x, y: top, width: left - a.x, height: bottom - top });
  if (right < a.x + a.width) parts.push({ x: right, y: top, width: a.x + a.width - right, height: bottom - top });
  return freeze(parts.map((part) => rectValue(part)));
}

/**
 * Cut an inner rectangle from an existing block. Up to four remainder blocks plus
 * the selected block replace the parent in-place. The selected part is last/top.
 * Coordinates are BLOCK-LOCAL, even after the parent has moved. No pixel copies.
 */
export function cutBlock(input, id, localRect, options = {}) {
  const draft = validateDraft(input); const block = blockById(draft, id);
  const full = { x: 0, y: 0, width: block.source.width, height: block.source.height };
  const selected = inBounds(rectValue(localRect), full.width, full.height, 'Local cut');
  if (equalRect(full, selected)) { removalPolicy(options); return draft; }
  return replaceByParts(draft, block, [...subtractRect(full, selected), selected], options);
}

/** Render only these original-image areas, then destination blocks in z order. */
export function getSourceRemainders(input) {
  const draft = validateDraft(input);
  let regions = [{ x: 0, y: 0, width: draft.asset.width, height: draft.asset.height }];
  for (const block of draft.blocks) regions = regions.flatMap((region) => subtractRect(region, block.source));
  return freeze(regions);
}

/** Topmost destination block wins. Source holes/background return null. */
export function hitTest(input, point) {
  const draft = validateDraft(input); const p = pointValue(point);
  for (let index = draft.blocks.length - 1; index >= 0; index--) {
    if (containsPoint(draft.blocks[index].destination, p)) return draft.blocks[index];
  }
  return null;
}

export function addAnnotation(input, annotation) {
  const draft = validateDraft(input);
  record(annotation, ['id', 'text', 'target'], ['text', 'target'], 'annotation');
  if (draft.annotations.length >= LIMITS.annotations) fail('LIMIT_EXCEEDED', 'Too many annotations');
  const used = new Set(draft.annotations.map((item) => item.id));
  const id = own(annotation, 'id') ? identifier(annotation.id, 'annotation.id') : freshId(draft, 'annotation', used);
  if (own(annotation, 'id') && used.has(id)) fail('INVALID_DRAFT', `Duplicate annotation ID ${id}`);
  const added = { id, number: draft.nextAnnotationNumber, text: textValue(annotation.text),
    target: targetValue(annotation.target, draft.asset, draft.blocks) };
  const nextAnnotationNumber = integer(draft.nextAnnotationNumber + 1, 1, 'nextAnnotationNumber');
  return derive(draft, { annotations: [...draft.annotations, added], nextAnnotationNumber });
}

/** Explicit target updates can rebind a fixed layout annotation to a component. */
export function updateAnnotation(input, id, patch) {
  const draft = validateDraft(input); const previous = annotationById(draft, id);
  record(patch, ['text', 'target'], [], 'patch');
  const text = own(patch, 'text') ? textValue(patch.text) : previous.text;
  const target = own(patch, 'target') ? targetValue(patch.target, draft.asset, draft.blocks) : previous.target;
  if (text === previous.text && JSON.stringify(target) === JSON.stringify(previous.target)) return draft;
  return derive(draft, { annotations: draft.annotations.map((item) => item.id === id ? { ...item, text, target } : item) });
}

export function removeAnnotation(input, id) {
  const draft = validateDraft(input); annotationById(draft, id);
  return derive(draft, { annotations: draft.annotations.filter((item) => item.id !== id) });
}

/** Return {annotation, source, layout}; anchors are {kind,point|rect} or null. */
export function resolveAnnotation(input, id) {
  const draft = validateDraft(input); const annotation = annotationById(draft, id); const target = annotation.target;
  if (target.kind === 'global') return freeze({ annotation, source: null, layout: null });
  if (target.kind === 'point') return freeze({ annotation, source: null, layout: { kind: 'point', point: target.point } });
  if (target.kind === 'region') return freeze({ annotation, source: null, layout: { kind: 'region', rect: target.rect } });
  const block = blockById(draft, target.blockId);
  const anchor = (origin) => {
    if (!target.local) return { kind: 'region', rect: origin };
    const key = target.local.kind === 'point' ? 'point' : 'rect';
    const geometry = target.local[key];
    return { kind: target.local.kind, [key]: { ...geometry, x: origin.x + geometry.x, y: origin.y + geometry.y } };
  };
  return freeze({ annotation, source: anchor(block.source), layout: anchor(block.destination) });
}

export function serializeDraft(input, options = {}) {
  record(options, ['pretty'], [], 'options');
  if (own(options, 'pretty') && typeof options.pretty !== 'boolean') fail('INVALID_DRAFT', 'pretty must be boolean');
  const json = JSON.stringify(validateDraft(input), null, options.pretty ? 2 : undefined);
  if (json.length > LIMITS.serialized) fail('LIMIT_EXCEEDED', 'Serialized draft is too large');
  return json;
}

export function deserializeDraft(json, expected) {
  if (typeof json !== 'string') fail('INVALID_DRAFT', 'Serialized draft must be a JSON string');
  if (json.length > LIMITS.serialized) fail('LIMIT_EXCEEDED', 'Serialized draft is too large');
  let value;
  try { value = JSON.parse(json); } catch { fail('INVALID_DRAFT', 'Serialized draft is not valid JSON'); }
  return validateDraft(value, expected);
}

export function getMoves(input) {
  const draft = validateDraft(input);
  return freeze(draft.blocks.filter(moved).map((block) => ({ blockId: block.id, source: block.source, destination: block.destination,
    delta: { x: block.destination.x - block.source.x, y: block.destination.y - block.source.y }, zIndex: block.zIndex })));
}

export function hasFeedback(input) {
  const draft = validateDraft(input);
  return draft.blocks.some(moved) || draft.annotations.some((annotation) => annotation.text.trim().length > 0);
}

const rectLabel = (rect) => `(${rect.x}, ${rect.y}, ${rect.width}, ${rect.height})`;
const anchorLabel = (anchor) => anchor.kind === 'point' ? `point (${anchor.point.x}, ${anchor.point.y})` : `rect ${rectLabel(anchor.rect)}`;

/** Human-readable instructions AND exact JSON; real uncommented moves are retained. */
export function buildFeedback(input) {
  const draft = validateDraft(input); const moves = getMoves(draft);
  const lines = [
    'Image feedback',
    `Bound session: ${JSON.stringify(draft.sessionId)}; source asset: ${JSON.stringify(draft.asset.assetId)}.`,
    `Canvas: ${draft.asset.width} x ${draft.asset.height}; asset-pixels, origin top-left, x right, y down; fixed canvas.`,
    'Use the attached clean source image. Source rectangles are cut out, not copied; destinations are the current layout. Rectangles are (x, y, width, height).',
    'Blocks only translate, with source size unchanged. Higher zIndex is on top. Layout-position comments stay fixed; block-local comments follow their block.',
    `Moves (${moves.length}):`,
  ];
  lines.push('Reference block labels: ' + (draft.blocks.map((block, index) => `B${index + 1} = ${JSON.stringify(block.id)}`).join('; ') || 'none') + '.');
  if (!moves.length) lines.push('- No block translations.');
  for (const move of moves) lines.push(`- Block ${JSON.stringify(move.blockId)}: source ${rectLabel(move.source)} -> destination ${rectLabel(move.destination)}; delta (${move.delta.x}, ${move.delta.y}); zIndex ${move.zIndex}.`);
  lines.push(`Comments (${draft.annotations.length}):`);
  if (!draft.annotations.length) lines.push('- No text comments; retain every move listed above.');
  for (const annotation of draft.annotations) {
    const resolved = resolveAnnotation(draft, annotation.id); const target = annotation.target;
    const where = target.kind === 'global' ? 'global'
      : target.kind === 'block' ? `block ${JSON.stringify(target.blockId)}, source ${anchorLabel(resolved.source)}, layout ${anchorLabel(resolved.layout)}`
        : `fixed layout ${anchorLabel(resolved.layout)} (not an original-image anchor)`;
    lines.push(`- #${annotation.number} [${where}]: ${JSON.stringify(annotation.text)}`);
  }
  const json = serializeDraft(draft, { pretty: true });
  lines.push('Structured feedback (same immutable source and coordinate system):', '```json', json, '```');
  return freeze({ text: lines.join('\n'), json, moves });
}

/**
 * Metadata-only bounded history. Commit ONCE on pointer-up, not per preview frame.
 * Undo/redo restores exact immutable snapshots. version is a monotonic async-work
 * token; draft.revision belongs to the restored snapshot and can repeat on a fork.
 */
export class History {
  #current; #past = []; #future = []; #limit; #version = 0;
  constructor(initial, options = {}) {
    record(options, ['limit'], [], 'options');
    this.#limit = own(options, 'limit') ? integer(options.limit, 1, 'history.limit') : 100;
    if (this.#limit > 1000) fail('LIMIT_EXCEEDED', 'History limit cannot exceed 1000 snapshots');
    this.#current = validateDraft(initial);
  }
  get current() { return this.#current; }
  get canUndo() { return this.#past.length > 0; }
  get canRedo() { return this.#future.length > 0; }
  get undoCount() { return this.#past.length; }
  get redoCount() { return this.#future.length; }
  get version() { return this.#version; }
  commit(next) {
    const candidate = validateDraft(typeof next === 'function' ? next(this.#current) : next);
    if (candidate.sessionId !== this.#current.sessionId || JSON.stringify(candidate.asset) !== JSON.stringify(this.#current.asset)) {
      fail('IDENTITY_MISMATCH', 'History cannot replace its bound session or source asset; create a new history');
    }
    if (candidate === this.#current) return this.#current;
    const sources = new Map(this.#current.blocks.map((block) => [block.id, block.source]));
    for (const block of candidate.blocks) {
      if (sources.has(block.id) && !equalRect(sources.get(block.id), block.source)) {
        fail('IDENTITY_MISMATCH', `Block ${block.id} cannot change its immutable source; split it into new IDs`);
      }
    }
    this.#past.push(this.#current);
    if (this.#past.length > this.#limit) this.#past.shift();
    this.#future = [];
    this.#current = candidate; this.#version++;
    return this.#current;
  }
  undo() {
    if (!this.canUndo) return this.#current;
    this.#future.push(this.#current); this.#current = this.#past.pop(); this.#version++;
    return this.#current;
  }
  redo() {
    if (!this.canRedo) return this.#current;
    this.#past.push(this.#current); this.#current = this.#future.pop(); this.#version++;
    return this.#current;
  }
  clear() { this.#past = []; this.#future = []; return this.#current; }
}

const API = Object.freeze({ SCHEMA_VERSION, LIMITS, CoreError, createDraft, validateDraft, serializeDraft, deserializeDraft,
  rectanglesOverlap, containsPoint, rectFromPoints, viewToAsset, assetToView, subtractRect, getSourceRemainders,
  addBlock, moveBlock, resetBlock, resetAllMoves, reorderBlock, removeBlock, splitBlock, cutBlock, hitTest,
  addAnnotation, updateAnnotation, removeAnnotation, resolveAnnotation, getMoves, hasFeedback, buildFeedback, History });
export default API;
