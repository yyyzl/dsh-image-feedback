window.__ModuleLoader__.load({id:'@yyyzl/dsh-image-feedback/client.editor.js',factory(require){
'use strict';
const core=(()=>{
/**
 * Independent, dependency-free image-feedback data core.
 * No pixels, paths, browser objects, clocks, random IDs, or host calls live here.
 * All edits return deeply frozen snapshots and share unchanged data. Coordinates
 * use the persisted asset's pixels; translations never change a block's source.
 */
const SCHEMA_VERSION = 'harness-image-feedback-1';
const LIMITS = Object.freeze({ blocks: 1000, annotations: 1000, text: 20000, serialized: 2_000_000 });

class CoreError extends Error {
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
function rectanglesOverlap(a, b) { return overlap(rectValue(a), rectValue(b)); }

/** Half-open hit areas make shared edges deterministic: left/top in, right/bottom out. */
function containsPoint(rect, point) {
  const r = rectValue(rect); const p = pointValue(point);
  return p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;
}

function rectFromPoints(a, b) {
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
function viewToAsset(point, transform) { return transformPoint(point, transform, true); }
function assetToView(point, transform) { return transformPoint(point, transform, false); }

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
function validateDraft(value, expected) {
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

function createDraft(input) {
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
function addBlock(input, sourceRect, options = {}) {
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
function moveBlock(input, id, position, options = {}) {
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
function resetBlock(input, id) {
  const draft = validateDraft(input); const block = blockById(draft, id);
  return moveBlock(draft, id, { x: block.source.x, y: block.source.y });
}

function resetAllMoves(input) {
  const draft = validateDraft(input);
  if (!draft.blocks.some(moved)) return draft;
  return derive(draft, { blocks: draft.blocks.map((block) => moved(block) ? { ...block, destination: block.source } : block) });
}

/** order='front'|'back' or a zero-based final layer index. */
function reorderBlock(input, id, order) {
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
function removeBlock(input, id, options = {}) {
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
function splitBlock(input, id, cut, options = {}) {
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
function subtractRect(rect, cut) {
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
function cutBlock(input, id, localRect, options = {}) {
  const draft = validateDraft(input); const block = blockById(draft, id);
  const full = { x: 0, y: 0, width: block.source.width, height: block.source.height };
  const selected = inBounds(rectValue(localRect), full.width, full.height, 'Local cut');
  if (equalRect(full, selected)) { removalPolicy(options); return draft; }
  return replaceByParts(draft, block, [...subtractRect(full, selected), selected], options);
}

/** Render only these original-image areas, then destination blocks in z order. */
function getSourceRemainders(input) {
  const draft = validateDraft(input);
  let regions = [{ x: 0, y: 0, width: draft.asset.width, height: draft.asset.height }];
  for (const block of draft.blocks) regions = regions.flatMap((region) => subtractRect(region, block.source));
  return freeze(regions);
}

/** Topmost destination block wins. Source holes/background return null. */
function hitTest(input, point) {
  const draft = validateDraft(input); const p = pointValue(point);
  for (let index = draft.blocks.length - 1; index >= 0; index--) {
    if (containsPoint(draft.blocks[index].destination, p)) return draft.blocks[index];
  }
  return null;
}

function addAnnotation(input, annotation) {
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
function updateAnnotation(input, id, patch) {
  const draft = validateDraft(input); const previous = annotationById(draft, id);
  record(patch, ['text', 'target'], [], 'patch');
  const text = own(patch, 'text') ? textValue(patch.text) : previous.text;
  const target = own(patch, 'target') ? targetValue(patch.target, draft.asset, draft.blocks) : previous.target;
  if (text === previous.text && JSON.stringify(target) === JSON.stringify(previous.target)) return draft;
  return derive(draft, { annotations: draft.annotations.map((item) => item.id === id ? { ...item, text, target } : item) });
}

function removeAnnotation(input, id) {
  const draft = validateDraft(input); annotationById(draft, id);
  return derive(draft, { annotations: draft.annotations.filter((item) => item.id !== id) });
}

/** Return {annotation, source, layout}; anchors are {kind,point|rect} or null. */
function resolveAnnotation(input, id) {
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

function serializeDraft(input, options = {}) {
  record(options, ['pretty'], [], 'options');
  if (own(options, 'pretty') && typeof options.pretty !== 'boolean') fail('INVALID_DRAFT', 'pretty must be boolean');
  const json = JSON.stringify(validateDraft(input), null, options.pretty ? 2 : undefined);
  if (json.length > LIMITS.serialized) fail('LIMIT_EXCEEDED', 'Serialized draft is too large');
  return json;
}

function deserializeDraft(json, expected) {
  if (typeof json !== 'string') fail('INVALID_DRAFT', 'Serialized draft must be a JSON string');
  if (json.length > LIMITS.serialized) fail('LIMIT_EXCEEDED', 'Serialized draft is too large');
  let value;
  try { value = JSON.parse(json); } catch { fail('INVALID_DRAFT', 'Serialized draft is not valid JSON'); }
  return validateDraft(value, expected);
}

function getMoves(input) {
  const draft = validateDraft(input);
  return freeze(draft.blocks.filter(moved).map((block) => ({ blockId: block.id, source: block.source, destination: block.destination,
    delta: { x: block.destination.x - block.source.x, y: block.destination.y - block.source.y }, zIndex: block.zIndex })));
}

/** One contiguous presentation ledger for comments and uncommented moves.
 * IDs and stored annotation numbers remain immutable; display numbers belong to
 * this exact draft snapshot and are shared by UI, reference artwork and text.
 */
function getReviewItems(input) {
  const draft = validateDraft(input), moves = new Map(getMoves(draft).map(move => [move.blockId, move]));
  const generatedOrder = id => { const match = /^(?:block|annotation)-(\d+)(?:-\d+)?$/u.exec(id); const value = match ? Number(match[1]) : null; return Number.isSafeInteger(value) ? value : null; };
  const primary = new Map();
  for (const note of draft.annotations) if (note.target.kind === 'block' && !note.target.local && !primary.has(note.target.blockId)) primary.set(note.target.blockId, note);
  const items = [];
  for (const note of draft.annotations) {
    const block = note.target.kind === 'block' ? blockById(draft, note.target.blockId) : null;
    const whole = block && primary.get(block.id) === note;
    const resolved = resolveAnnotation(draft, note.id);
    const orders = [generatedOrder(note.id), whole ? generatedOrder(block.id) : null].filter(value => value !== null);
    items.push({ key: whole ? 'block:'+block.id : 'note:'+note.id, annotationId: note.id, blockId: block?.id || null,
      annotation: note, block, text: note.text, kind: note.target.kind === 'global' ? 'global' : whole && moves.has(block.id) ? 'move' : 'comment',
      source: resolved.source, layout: resolved.layout, move: whole ? moves.get(block.id) || null : null,
      order: whole && generatedOrder(block.id) === null ? Number.MAX_SAFE_INTEGER : orders.length ? Math.min(...orders) : note.number });
  }
  for (const block of draft.blocks) if (moves.has(block.id) && !primary.has(block.id)) {
    items.push({ key: 'block:'+block.id, annotationId: null, blockId: block.id, annotation: null, block, text: '', kind: 'move',
      source: { kind: 'region', rect: block.source }, layout: { kind: 'region', rect: block.destination }, move: moves.get(block.id),
      order: generatedOrder(block.id) ?? Number.MAX_SAFE_INTEGER });
  }
  items.sort((a,b) => a.order-b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return freeze(items.map(({order: _order, ...item}, index) => ({...item, number: index+1})));
}

function hasFeedback(input) {
  const draft = validateDraft(input);
  return draft.blocks.some(moved) || draft.annotations.some((annotation) => annotation.text.trim().length > 0);
}

const rectLabel = (rect) => `(${rect.x}, ${rect.y}, ${rect.width}, ${rect.height})`;
const anchorLabel = (anchor) => anchor.kind === 'point' ? `point (${anchor.point.x}, ${anchor.point.y})` : `rect ${rectLabel(anchor.rect)}`;

/** Human-readable instructions AND exact JSON; real uncommented moves are retained. */
function buildFeedback(input) {
  const draft = validateDraft(input); const moves = getMoves(draft); const reviewItems = getReviewItems(draft);
  const noteNumbers = new Map(reviewItems.filter(item => item.annotationId).map(item => [item.annotationId, item.number]));
  const moveNumbers = new Map(reviewItems.filter(item => item.move).map(item => [item.blockId, item.number]));
  const lines = [
    'Image feedback',
    `Bound session: ${JSON.stringify(draft.sessionId)}; source asset: ${JSON.stringify(draft.asset.assetId)}.`,
    `Canvas: ${draft.asset.width} x ${draft.asset.height}; asset-pixels, origin top-left, x right, y down; fixed canvas.`,
    'Use the attached clean source image. Source rectangles are cut out, not copied; destinations are the current layout. Rectangles are (x, y, width, height).',
    'Blocks only translate, with source size unchanged. Higher zIndex is on top. Layout-position comments stay fixed; block-local comments follow their block.',
    `Moves (${moves.length}):`,
  ];
  lines.push('Reference review labels: ' + (reviewItems.map(item => `#${item.number} = ${JSON.stringify(item.key)}`).join('; ') || 'none') + '.');
  lines.push('Use these review labels for the numbered reference image. Stored annotation.number values in the JSON are legacy identities, not current display labels.');
  if (!moves.length) lines.push('- No block translations.');
  for (const move of moves) lines.push(`- #${moveNumbers.get(move.blockId)} Block ${JSON.stringify(move.blockId)}: source ${rectLabel(move.source)} -> destination ${rectLabel(move.destination)}; delta (${move.delta.x}, ${move.delta.y}); zIndex ${move.zIndex}.`);
  lines.push(`Comments (${draft.annotations.length}):`);
  if (!draft.annotations.length) lines.push('- No text comments; retain every move listed above.');
  for (const annotation of draft.annotations) {
    const resolved = resolveAnnotation(draft, annotation.id); const target = annotation.target;
    const where = target.kind === 'global' ? 'global'
      : target.kind === 'block' ? `block ${JSON.stringify(target.blockId)}, source ${anchorLabel(resolved.source)}, layout ${anchorLabel(resolved.layout)}`
        : `fixed layout ${anchorLabel(resolved.layout)} (not an original-image anchor)`;
    lines.push(`- #${noteNumbers.get(annotation.id)} [${where}]: ${JSON.stringify(annotation.text)}`);
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
class History {
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
  addAnnotation, updateAnnotation, removeAnnotation, resolveAnnotation, getMoves, getReviewItems, hasFeedback, buildFeedback, History });
return API;

})();
const CSS="/* Image Feedback — an image-first review desk, scoped to the native sidebar.\n   Artwork is red; interface surfaces and all other colors follow Harness tokens. */\n.dif-root {\n  --dif-annotation: #dc2626;\n  --dif-annotation-ink: #ffffff;\n  --dif-accent-soft: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent);\n  --dif-accent-line: color-mix(in srgb, var(--dsw-alias-brand-primary) 24%, transparent);\n  --dif-shadow: color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent);\n  --dif-grid: color-mix(in srgb, var(--dsw-alias-border-l2) 46%, transparent);\n  --dif-ease: cubic-bezier(.2,.7,.2,1);\n  position: relative;\n  isolation: isolate;\n  container: dif-editor / inline-size;\n  display: flex;\n  flex-direction: column;\n  width: 100%;\n  height: 100%;\n  min-width: 0;\n  min-height: 0;\n  overflow: auto;\n  box-sizing: border-box;\n  color: var(--dsw-alias-label-primary);\n  background: var(--dsw-alias-bg-base);\n  font: inherit;\n  font-size: 13px;\n  line-height: 1.5;\n  scrollbar-width: thin;\n}\n.dif-root *, .dif-root *::before, .dif-root *::after { box-sizing: border-box; }\n.dif-root :where(button,input,textarea,select,summary) { font: inherit; }\n.dif-root :where(button,summary,input,textarea,select,a,[tabindex]):focus-visible {\n  outline: 2px solid var(--dsw-alias-brand-primary);\n  outline-offset: 3px;\n}\n.dif-root :where(button,summary) { -webkit-tap-highlight-color: transparent; }\n.dif-root :where(button,input,textarea,select):disabled { cursor: not-allowed; opacity: .42; }\n.dif-root .dif-spacer { flex: 1 1 auto; min-width: 0; }\n.dif-root .dif-subtle { color: var(--dsw-alias-label-secondary); font-size: 11px; font-weight: 400; line-height: 1.6; }\n\n/* Source identity: one flexible name, quiet metadata, discreet persistence. */\n.dif-root .dif-source {\n  z-index: 6;\n  display: flex;\n  flex: 0 0 auto;\n  align-items: center;\n  gap: 10px;\n  min-width: 0;\n  min-height: 58px;\n  padding: 10px 16px;\n  border-bottom: 1px solid var(--dsw-alias-border-l1);\n  background: var(--dsw-alias-bg-base);\n}\n.dif-root .dif-source > .dif-icon { color: var(--dsw-alias-label-secondary); }\n.dif-root .dif-source-info { display: flex; flex: 1 1 auto; flex-direction: column; gap: 1px; min-width: 0; }\n.dif-root .dif-source-name { overflow: hidden; font-size: 12px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; }\n.dif-root .dif-dimensions { color: var(--dsw-alias-label-secondary); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }\n.dif-root .dif-save-state { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary); font-size: 11px; white-space: nowrap; }\n.dif-root .dif-save-state::before { width: 6px; height: 6px; flex: 0 0 6px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); content: \"\"; }\n.dif-root .dif-save-state:is([data-state=\"saved\"],[data-state=\"ready\"])::before { background: var(--dsw-alias-state-success-primary); }\n.dif-root .dif-save-state:is([data-state=\"saving\"],[data-state=\"loading\"])::before { background: var(--dsw-alias-brand-primary); }\n.dif-root .dif-save-state:is([data-state=\"dirty\"],[data-state=\"unsaved\"])::before { background: var(--dsw-alias-state-warn-primary); }\n.dif-root .dif-save-state:is([data-state=\"error\"],[data-state=\"failed\"])::before { background: var(--dsw-alias-state-error-primary); }\n\n/* Quiet, tactile controls. Send alone receives a solid contrasting surface. */\n.dif-root .dif-btn {\n  display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center;\n  gap: 6px; min-height: 32px; margin: 0; padding: 5px 10px;\n  border: 1px solid transparent; border-radius: 8px; appearance: none;\n  color: var(--dsw-alias-label-primary); background: transparent;\n  font-size: 12px; font-weight: 500; line-height: 20px;\n  text-decoration: none; white-space: nowrap; cursor: pointer; user-select: none;\n  transition: background-color 140ms var(--dif-ease), border-color 140ms var(--dif-ease), color 140ms var(--dif-ease), box-shadow 140ms var(--dif-ease);\n}\n.dif-root .dif-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }\n.dif-root .dif-btn:active:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent); }\n.dif-root .dif-btn[aria-pressed=\"true\"] { border-color: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-base); background: var(--dsw-alias-label-primary); font-weight: 600; }\n.dif-root .dif-btn[aria-pressed=\"true\"]:hover:not(:disabled), .dif-root .dif-btn[aria-pressed=\"true\"]:active:not(:disabled) { color: var(--dsw-alias-bg-base); background: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-primary); }\n.dif-root .dif-icon-btn { width: 32px; height: 32px; min-height: 32px; padding: 6px; }\n.dif-root .dif-icon { display: block; flex: 0 0 18px; width: 18px; height: 18px; pointer-events: none; }\n.dif-root .dif-btn.dif-primary {\n  color: var(--dsw-alias-bg-base);\n  background: var(--dsw-alias-label-primary);\n  border-color: var(--dsw-alias-label-primary);\n  font-weight: 600;\n}\n.dif-root .dif-primary :where(.dif-tool-label, .dif-icon) { color: inherit; }\n.dif-root .dif-btn.dif-primary:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-label-primary) 88%, var(--dsw-alias-bg-base)); border-color: transparent; box-shadow: 0 3px 9px var(--dif-shadow); }\n.dif-root .dif-btn.dif-primary:active:not(:disabled) { box-shadow: none; background: color-mix(in srgb, var(--dsw-alias-label-primary) 80%, var(--dsw-alias-bg-base)); }\n.dif-root .dif-btn.dif-secondary { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); }\n.dif-root .dif-btn.dif-secondary:active:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }\n.dif-root .dif-btn.dif-secondary:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }\n.dif-root .dif-text-action { color: var(--dsw-alias-label-secondary); font-size: 11px; }\n.dif-root .dif-text-action:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }\n.dif-root .dif-tool-label { min-width: 0; font-size: 12px; }\n.dif-root .dif-toolbar {\n  z-index: 3; display: flex; flex: 0 0 auto; align-items: center; gap: 8px;\n  min-width: 0; min-height: 54px; padding: 8px 16px;\n  border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base);\n}\n.dif-root .dif-toolgroup { display: flex; flex: 0 0 auto; align-items: center; gap: 2px; padding: 3px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }\n.dif-root .dif-toolgroup .dif-btn { min-height: 28px; padding-block: 3px; border-radius: 6px; }\n.dif-root .dif-toolgroup .dif-btn[aria-pressed=\"true\"] {\n  /* A real selected surface, not white-on-white with a barely visible border.\n     The host's contrasting primary/base pair also reverses correctly in dark mode. */\n  color: var(--dsw-alias-bg-base);\n  background: var(--dsw-alias-label-primary);\n  border-color: var(--dsw-alias-label-primary);\n  font-weight: 650;\n  box-shadow: 0 1px 3px var(--dif-shadow);\n}\n.dif-root .dif-toolgroup .dif-btn[aria-pressed=\"true\"]:hover:not(:disabled) { color: var(--dsw-alias-bg-base); background: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-primary); }\n.dif-root .dif-toolgroup .dif-btn[aria-pressed=\"false\"] { color: var(--dsw-alias-label-secondary); }\n.dif-root .dif-toolgroup .dif-btn[aria-pressed=\"false\"]:hover:not(:disabled) { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); }\n.dif-root .dif-divider { width: 1px; height: 18px; flex: 0 0 1px; margin: 0 2px; background: var(--dsw-alias-border-l1); }\n\n/* Menus remain local to this editor. No portal covers the chat. */\n.dif-root .dif-menu { position: relative; flex: 0 0 auto; }\n.dif-root .dif-menu > summary { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border: 1px solid transparent; border-radius: 8px; color: var(--dsw-alias-label-secondary); list-style: none; cursor: pointer; user-select: none; }\n.dif-root .dif-menu > summary::-webkit-details-marker { display: none; }\n.dif-root .dif-menu > summary:hover, .dif-root .dif-menu[open] > summary { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }\n.dif-root .dif-menu-body {\n  position: absolute; z-index: 12; top: calc(100% + 8px); right: 0;\n  display: flex; flex-direction: column; gap: 3px; width: max-content; min-width: 190px;\n  max-width: min(290px, calc(100cqw - 24px)); max-height: min(360px, 65vh); overflow: auto;\n  padding: 6px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px;\n  background: var(--dsw-alias-bg-overlay); box-shadow: 0 4px 10px var(--dif-shadow), 0 16px 40px var(--dif-shadow);\n  animation: dif-reveal 160ms var(--dif-ease);\n}\n.dif-root .dif-menu-body .dif-btn { justify-content: flex-start; width: 100%; min-height: 36px; padding: 7px 10px; text-align: left; white-space: normal; }\n.dif-root .dif-menu-body .dif-subtle { margin: 6px 10px; max-width: 240px; }\n\n/* The image is the hero. A subtle drafting grid gives neutral breathing room. */\n.dif-root .dif-canvas-area { position: relative; display: flex; flex: 1 1 auto; min-width: 0; min-height: 140px; overflow: hidden; background: var(--dsw-alias-bg-layer-1); }\n.dif-root .dif-stage { position: absolute; inset: 0; overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; background-color: var(--dsw-alias-bg-layer-1); background-image: radial-gradient(circle, var(--dif-grid) .65px, transparent .85px); background-position: center; background-size: 20px 20px; }\n.dif-root .dif-stage:focus-visible { outline-offset: -3px; }\n.dif-root .dif-canvas-wrap { position: relative; display: flex; align-items: center; justify-content: center; width: max-content; min-width: 100%; min-height: 100%; padding: 20px; }\n.dif-root .dif-canvas { display: block; flex: none; max-width: none; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); box-shadow: 0 2px 5px var(--dif-shadow), 0 12px 32px var(--dif-shadow); user-select: none; touch-action: none; }\n.dif-root .dif-zoom {\n  position: absolute; z-index: 2; right: 16px; bottom: 16px;\n  display: flex; align-items: center; gap: 2px; min-height: 34px; padding: 3px;\n  border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;\n  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-overlay);\n  box-shadow: 0 3px 12px var(--dif-shadow); font-size: 11px; font-variant-numeric: tabular-nums;\n}\n.dif-root .dif-zoom .dif-icon-btn { width: 28px; height: 28px; min-height: 28px; padding: 5px; border-radius: 6px; }\n.dif-root .dif-zoom > span { min-width: 38px; text-align: center; }\n.dif-root .dif-zoom .dif-divider { height: 16px; margin-inline: 3px; }\n.dif-root .dif-mode-hint {\n  position: absolute; z-index: 1; top: 12px; left: 16px; max-width: calc(100% - 32px);\n  padding: 5px 9px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px;\n  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-overlay);\n  font-size: 11px; line-height: 16px; pointer-events: none; user-select: none;\n}\n\n/* Numbered feedback echoes the actual red pins, not a second brand palette. */\n.dif-root .dif-bottom { display: flex; flex: 0 1 clamp(112px, 28%, 244px); flex-direction: column; min-width: 0; min-height: 88px; max-height: 38%; overflow: hidden; border-top: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); }\n.dif-root .dif-list-title { display: flex; flex: 0 0 44px; align-items: center; gap: 8px; min-width: 0; padding: 0 16px; font-size: 12px; font-weight: 600; }\n.dif-root .dif-list-title strong { font-weight: 600; }\n.dif-root .dif-count { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 20px; padding: 0 6px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); font-size: 11px; font-weight: 500; font-variant-numeric: tabular-nums; }\n.dif-root .dif-notes-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 0 10px 10px; overscroll-behavior: contain; scrollbar-width: thin; }\n.dif-root .dif-note-row { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; min-height: 38px; margin: 2px 0; padding: 7px 8px; border: 1px solid transparent; border-radius: 8px; color: var(--dsw-alias-label-primary); background: transparent; font-size: 13px; line-height: 20px; text-align: left; cursor: pointer; transition: background-color 140ms var(--dif-ease), border-color 140ms var(--dif-ease); }\n.dif-root .dif-note-row:hover:not(:disabled) { border-color: var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }\n.dif-root .dif-note-row > .dif-icon:last-child { flex-basis: 14px; width: 14px; height: 14px; color: var(--dsw-alias-label-secondary); }\n.dif-root .dif-number { display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; min-width: 22px; height: 22px; padding: 0 4px; border-radius: 50%; color: var(--dif-annotation-ink); background: var(--dif-annotation); font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }\n.dif-root .dif-item-thumb { display: block; flex: 0 0 36px; width: 36px; height: 30px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 5px; background: var(--dsw-alias-bg-layer-1); pointer-events: none; }\n.dif-root .dif-row-main { display: flex; flex: 1 1 auto; flex-direction: column; gap: 2px; min-width: 0; }\n.dif-root .dif-row-title { display: flex; align-items: baseline; gap: 7px; min-width: 0; }\n.dif-root .dif-row-meta { color: var(--dsw-alias-label-secondary); font-size: 11px; font-variant-numeric: tabular-nums; line-height: 1.5; }\n.dif-root .dif-number { corner-shape: round; }\n.dif-root .dif-note-snippet { flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }\n.dif-root .dif-kind { flex: 0 0 auto; color: var(--dsw-alias-label-secondary); font-size: 11px; font-weight: 400; white-space: nowrap; }\n.dif-root .dif-inspector { flex: 0 0 auto; min-width: 0; margin: 2px 0 8px; overflow: hidden; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-base); transition: border-color 140ms var(--dif-ease), box-shadow 140ms var(--dif-ease); }\n.dif-root .dif-inspector:focus-within { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 2px var(--dif-accent-soft); }\n.dif-root .dif-note-head { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 36px; padding: 6px 8px 6px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); font-size: 11px; }\n.dif-root .dif-note-head .dif-icon-btn { width: 28px; height: 28px; min-height: 28px; padding: 5px; color: var(--dsw-alias-label-secondary); }\n.dif-root .dif-note-head .dif-btn:has(.dif-icon) { border-radius: 6px; }\n.dif-root .dif-inspector textarea { display: block; width: 100%; min-height: 72px; max-height: 160px; margin: 0; padding: 10px 12px 12px; border: 0; border-radius: 0; outline: none; color: var(--dsw-alias-label-primary); background: transparent; font-size: 13px; line-height: 1.75; resize: vertical; scrollbar-width: thin; }\n.dif-root .dif-inspector textarea:focus-visible { outline: none; }\n.dif-root .dif-inspector textarea::placeholder, .dif-root .dif-import input::placeholder { color: var(--dsw-alias-label-secondary); opacity: 1; }\n.dif-root .dif-note-help { padding: 0 12px 10px; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1.6; }\n.dif-root .dif-empty-notes { display: flex; align-items: center; gap: 8px; min-height: 32px; margin: 0; padding: 0 6px 6px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.6; }\n\n/* A clear, persistent hand-off: what gets sent, where, and one unmistakable CTA. */\n.dif-root .dif-footer { z-index: 2; display: flex; flex: 0 0 auto; flex-wrap: wrap; align-items: center; gap: 10px 16px; min-width: 0; padding: 12px 16px; border-top: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }\n.dif-root .dif-summary { display: flex; flex: 1 1 130px; flex-direction: column; gap: 2px; min-width: 0; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1.5; }\n.dif-root .dif-summary strong { color: var(--dsw-alias-label-primary); font-size: 12px; font-weight: 550; font-variant-numeric: tabular-nums; }\n.dif-root .dif-footer-actions { display: flex; flex: 0 1 auto; flex-wrap: wrap; align-items: center; gap: 8px; }\n.dif-root .dif-footer-actions .dif-btn { min-height: 38px; padding-inline: 12px; }\n.dif-root .dif-status { display: flex; flex: 0 0 auto; flex-wrap: wrap; align-items: center; gap: 6px; max-height: 120px; overflow: auto; padding: 10px 16px; border-top: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; scrollbar-width: thin; }\n.dif-root .dif-status > span { flex: 1 1 180px; }\n.dif-root .dif-status[data-error=\"true\"] { border-top-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }\n\n/* Import surfaces are in flow: source height and translated copy can grow safely. */\n.dif-root .dif-import { display: flex; flex: 0 0 auto; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; padding: 10px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1); }\n.dif-root .dif-import input { flex: 1 1 120px; width: 0; min-width: 0; height: 36px; padding: 7px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); font-size: 12px; }\n.dif-root .dif-library { position: relative; z-index: 8; flex: 0 1 auto; min-height: 100px; max-height: min(360px, 48%); overflow: auto; padding: 0 12px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-overlay); overscroll-behavior: contain; scrollbar-width: thin; animation: dif-reveal 160ms var(--dif-ease); }\n.dif-root .dif-library-head { position: sticky; z-index: 1; top: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-height: 48px; padding: 6px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-overlay); font-size: 12px; font-weight: 600; }\n.dif-root .dif-asset-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 8px; padding-top: 10px; }\n.dif-root .dif-asset { display: flex; flex-direction: column; gap: 4px; min-width: 0; margin: 0; padding: 5px; overflow: hidden; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); text-align: left; cursor: pointer; transition: border-color 140ms var(--dif-ease), box-shadow 140ms var(--dif-ease); }\n.dif-root .dif-asset:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); box-shadow: 0 3px 10px var(--dif-shadow); }\n.dif-root .dif-asset[aria-pressed=\"true\"] { border-color: var(--dsw-alias-brand-primary); background: var(--dif-accent-soft); }\n.dif-root .dif-asset img { display: block; width: 100%; height: 84px; aspect-ratio: 4 / 3; padding: 3px; border-radius: 5px; background: var(--dsw-alias-bg-layer-1); object-fit: contain; }\n.dif-root .dif-asset :where(span,small) { display: block; max-width: 100%; overflow: hidden; padding: 0 3px; font-size: 11px; line-height: 17px; white-space: nowrap; text-overflow: ellipsis; }\n.dif-root .dif-asset small { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }\n.dif-root .dif-inline-confirm { position: relative; z-index: 9; display: flex; flex: 0 0 auto; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-overlay); font-size: 12px; animation: dif-reveal 160ms var(--dif-ease); }\n.dif-root .dif-inline-confirm > span { flex-basis: 100%; line-height: 1.65; }\n\n/* Original redline illustration: a small demonstration, not stock decoration. */\n.dif-root .dif-empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: safe center; gap: 12px; min-width: 0; overflow: auto; padding: 32px 24px; text-align: center; }\n.dif-root .dif-empty-art { flex: 0 0 auto; width: 190px; height: 130px; margin: 0 0 8px; overflow: visible; color: var(--dsw-alias-label-secondary); }\n.dif-root .dif-art-back { fill: var(--dsw-alias-bg-layer-2); stroke: var(--dsw-alias-border-l1); }\n.dif-root .dif-art-sheet { fill: var(--dsw-alias-bg-base); stroke: var(--dsw-alias-border-l2); }\n.dif-root .dif-art-skeleton { fill: var(--dsw-alias-bg-layer-2); }\n.dif-root .dif-art-selection { fill: none; stroke: var(--dif-annotation); stroke-width: 1.5; }\n.dif-root .dif-art-pin { fill: var(--dif-annotation); }\n.dif-root .dif-art-number { fill: var(--dif-annotation-ink); font-size: 10px; font-weight: 600; }\n.dif-root .dif-eyebrow { color: var(--dsw-alias-label-secondary); font-size: 11px; font-weight: 500; letter-spacing: .12em; text-transform: uppercase; }\n.dif-root .dif-empty strong { max-width: 300px; margin: 0; color: var(--dsw-alias-label-primary); font-size: clamp(18px, 4.6cqw, 23px); font-weight: 600; letter-spacing: -.035em; line-height: 1.45; text-wrap: balance; }\n.dif-root .dif-empty p { max-width: 270px; margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.85; text-wrap: pretty; }\n.dif-root .dif-empty-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 8px; }\n.dif-root .dif-empty-actions .dif-btn { min-height: 38px; padding-inline: 16px; }\n.dif-root .dif-empty-more { color: var(--dsw-alias-label-secondary); font-size: 11px; }\n.dif-root .dif-empty-steps { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px 14px; margin: 14px 0 0; padding: 16px 0 0; border-top: 1px solid var(--dsw-alias-border-l1); list-style: none; }\n.dif-root .dif-empty-steps li { display: flex; align-items: center; gap: 5px; color: var(--dsw-alias-label-secondary); font-size: 11px; white-space: nowrap; }\n.dif-root .dif-empty-steps span { font-size: 10px; font-variant-numeric: tabular-nums; opacity: .75; }\n.dif-root .dif-drop-target { position: absolute; z-index: 20; inset: 8px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 20px; border: 2px dashed var(--dsw-alias-brand-primary); border-radius: 12px; color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-overlay); font-size: 14px; font-weight: 550; text-align: center; pointer-events: none; }\n\n/* Container, not viewport: useful at 280px and in a wide split-screen panel. */\n@container dif-editor (max-width: 440px) {\n  .dif-root .dif-footer { gap: 8px; }\n  .dif-root .dif-summary { flex-basis: 100%; flex-direction: row; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }\n  .dif-root .dif-footer-actions { width: 100%; }\n  .dif-root .dif-footer-actions .dif-primary { flex: 1 1 auto; }\n}\n@container dif-editor (max-width: 360px) {\n  .dif-root .dif-source { gap: 6px; padding-inline: 12px; }\n  .dif-root .dif-source > .dif-icon, .dif-root .dif-source .dif-text-action { display: none; }\n  .dif-root .dif-toolbar { gap: 4px; padding-inline: 12px; }\n  .dif-root .dif-toolgroup .dif-btn { padding-inline: 7px; }\n  .dif-root .dif-toolbar .dif-tool-label { font-size: 11px; }\n  .dif-root .dif-list-title, .dif-root .dif-footer { padding-inline: 12px; }\n  .dif-root .dif-notes-scroll { padding-inline: 8px; }\n  .dif-root .dif-zoom { right: 10px; bottom: 10px; }\n  .dif-root .dif-mode-hint { top: 10px; left: 10px; max-width: calc(100% - 20px); }\n  .dif-root .dif-empty { padding: 24px 16px; }\n  .dif-root .dif-empty-actions .dif-btn { padding-inline: 10px; }\n}\n@container dif-editor (max-width: 290px) {\n  .dif-root .dif-toolbar .dif-tool-label { display: none; }\n  .dif-root .dif-source { flex-wrap: wrap; }\n  .dif-root .dif-source-info { flex-basis: calc(100% - 100px); }\n  .dif-root .dif-save-state { margin-left: auto; }\n  .dif-root .dif-summary { flex-direction: column; }\n  .dif-root .dif-footer-actions { flex-wrap: wrap; }\n  .dif-root .dif-footer-actions .dif-btn { padding-inline: 8px; }\n  .dif-root .dif-asset-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }\n}\n@container dif-editor (min-width: 600px) {\n  .dif-root .dif-source, .dif-root .dif-toolbar, .dif-root .dif-footer { padding-inline: 20px; }\n  .dif-root .dif-list-title { padding-inline: 20px; }\n  .dif-root .dif-notes-scroll { padding-inline: 14px; }\n  .dif-root .dif-empty-art { width: 220px; height: 150px; }\n}\n/* ResizeObserver sets a presentation-only height flag; fitting stays immediate. */\n.dif-root[data-compact-height=\"true\"] .dif-source { min-height: 44px; padding-block: 5px; }\n.dif-root[data-compact-height=\"true\"] .dif-toolbar { min-height: 44px; padding-block: 4px; }\n.dif-root[data-compact-height=\"true\"] .dif-bottom { flex-basis: 104px; min-height: 88px; }\n.dif-root[data-compact-height=\"true\"] .dif-footer { padding-block: 8px; }\n.dif-root[data-compact-height=\"true\"] .dif-summary > span { display: none; }\n.dif-root[data-compact-height=\"true\"] .dif-list-title { flex-basis: 36px; }\n.dif-root[data-compact-height=\"true\"] .dif-empty { justify-content: flex-start; padding-block: 20px; }\n.dif-root[data-compact-height=\"true\"] .dif-empty-art { width: 125px; height: 86px; margin-bottom: 0; }\n.dif-root[data-compact-height=\"true\"] .dif-empty-steps { display: none; }\n@media (pointer: coarse) {\n  .dif-root .dif-btn, .dif-root .dif-icon-btn, .dif-root .dif-menu > summary, .dif-root .dif-note-head .dif-icon-btn, .dif-root .dif-zoom .dif-icon-btn { min-width: 40px; min-height: 40px; height: auto; }\n  .dif-root .dif-toolgroup .dif-btn { min-height: 40px; }\n  .dif-root .dif-note-row { min-height: 44px; }\n  .dif-root .dif-toolbar { flex-wrap: wrap; }\n}\n@media (forced-colors: active) {\n  .dif-root .dif-btn[aria-pressed=\"true\"], .dif-root .dif-inspector:focus-within, .dif-root .dif-asset[aria-pressed=\"true\"] { outline: 2px solid Highlight; outline-offset: -2px; }\n  .dif-root .dif-number { border: 1px solid CanvasText; }\n  .dif-root .dif-save-state::before { border: 1px solid CanvasText; }\n}\n@keyframes dif-reveal { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: translateY(0); } }\n@media (prefers-reduced-motion: reduce) {\n  .dif-root *, .dif-root *::before, .dif-root *::after { animation: none; transition: none; scroll-behavior: auto; }\n}\n";
const MESSAGES={"zh":{"openFile":"选择图片","library":"会话图片","replace":"更换","options":"更多选项","tools":"图片反馈工具","path":"路径 / Base64","import":"导入","workspace":"图片审阅工作台","workflow":"图片反馈步骤","stepMark":"框选批注","stepMove":"拖动调整","stepSend":"发回会话","dropImage":"松开，开始审阅这张图片","sendIncludes":"原图 + 编号参考图，发回当前会话","paste":"让修改，落在准确的位置。","pasteHint":"粘贴截图、拖入图片，或从当前会话选择。","select":"选择","point":"点批注","selectHelp":"框选直接写批注，拖动选区调整位置；Shift 拖动可新建范围","pointHelp":"点击画面写批注；已有标记可直接拖动，点击标记继续编辑","selectHint":"框选即批注 · 拖动选区调整位置","pointHint":"点击添加批注 · 拖动标记调整位置","panHint":"拖动画布 · 也可使用空格或中键","pan":"平移视图","undo":"撤销","redo":"重做","fit":"适应画布","zoomIn":"放大","zoomOut":"缩小","global":"全局","blockNote":"图块","positionNote":"位置","addGlobal":"全局意见","notes":"修改项","commentItem":"批注","moveItem":"移动","moveOnly":"已调整位置","itemCount":"项修改","zoomHint":"滚轮 / 触控板捏合缩放 · 空格拖动平移","hostUpdate":"编号规则已更新。请保存当前修改，完整退出并重新打开 Harness 后再发送，避免图片与文字编号不一致。","noteCount":"条意见","emptyNotes":"直接在图片上框选，意见会出现在这里。","placeholder":"希望这里怎么改？","blockPlaceholder":"还需要补充什么修改？（可选）","optionalComment":"位置调整会自动回传，文字可留空","layoutChange":"布局调整","delete":"删除这条意见","reset":"复位图块","removeBlock":"移除选中图块","fill":"填入文字","send":"发送反馈","sending":"发送中…","saved":"已保存","saving":"保存中","loading":"读取中","ready":"已就绪","unsaved":"待保存","error":"操作失败","accepted":"反馈已排队，原聊天草稿保持不变。","inserted":"反馈文字已填入，尚未发送。","fillFailed":"输入框状态已改变，未插入。请重试；原草稿未被覆盖。","fillTextOnly":"只填入反馈文字；携带原图和布局参考请使用“发送反馈”。","feedbackChanged":"准备参考图时反馈发生了变化，请重新发送。","noImages":"当前会话还没有图片，可以直接粘贴或选择文件。","reload":"重新读取","unsupported":"请选择 PNG、JPEG、WebP 或 GIF 图片。","invalidPaste":"未发现图片、有效图片路径或 Base64。文字请粘贴到意见框。","deleteConfirm":"图块绑定了意见。确认同时移除图块和这些意见？","confirm":"确认","cancel":"取消","dismiss":"收起提示","export":"导出反馈 JSON","more":"更多图片","retrySave":"重试保存","changes":"处布局调整","newImageConfirm":"当前修改会先保存，切换后可从会话图片恢复。","switch":"保存并切换","reference":"图片与布局画布","sendAgain":"这份反馈已经发送；修改后可以再次发送。","sessionChanged":"会话已切换，反馈仍保留在原会话，未发送。","commandDraft":"输入框中已有斜杠命令，请先完成或退出该命令，再填入反馈。","reloadConfirm":"重新读取会放弃未保存的本地修改。建议先导出反馈 JSON。确认放弃并读取宿主版本？","cutOverlap":"这个范围包含已被移动走的源像素，不能再次拆出同一份。请直接拖动当前可见图块；原有内容和意见已保留。","keyboardHint":"空格 / 中键平移 · Ctrl/Cmd+Z 撤销 · 方向键微调图块"},"en":{"openFile":"Choose image","library":"Session images","replace":"Replace","options":"More options","tools":"Image feedback tools","path":"Path / Base64","import":"Import","workspace":"Image review desk","workflow":"Image feedback steps","stepMark":"Mark a detail","stepMove":"Move a region","stepSend":"Send to chat","dropImage":"Drop to start reviewing this image","sendIncludes":"Source + numbered reference, sent to this chat","paste":"Good feedback starts with a clear point.","pasteHint":"Paste a screenshot, drop an image, or choose from this session.","select":"Select","point":"Point","selectHelp":"Draw to write feedback, drag a region to move it; Shift-drag starts a new region","pointHelp":"Click to write a point note; drag an existing pin to reposition it, or click to edit","selectHint":"Draw to comment · Drag a region to move it","pointHint":"Click to comment · Drag a pin to reposition it","panHint":"Drag to pan · Space or middle button also works","pan":"Pan view","undo":"Undo","redo":"Redo","fit":"Fit canvas","zoomIn":"Zoom in","zoomOut":"Zoom out","global":"Global","blockNote":"Block","positionNote":"Position","addGlobal":"Global note","notes":"Changes","commentItem":"Comment","moveItem":"Move","moveOnly":"Position adjusted","itemCount":"changes","zoomHint":"Wheel / trackpad pinch to zoom · Space-drag to pan","hostUpdate":"Review numbering has changed. Save your work and fully restart Harness before sending so image and text labels stay consistent.","noteCount":"notes","emptyNotes":"Draw a region on the image. Your feedback appears here.","placeholder":"What would you like to change here?","blockPlaceholder":"Any other changes to this block? (Optional)","optionalComment":"Layout changes are included automatically; text is optional","layoutChange":"Layout change","delete":"Delete this note","reset":"Reset block","removeBlock":"Remove selected block","fill":"Insert text","send":"Send feedback","sending":"Sending…","saved":"Saved","saving":"Saving","loading":"Loading","ready":"Ready","unsaved":"Unsaved","error":"Failed","accepted":"Feedback queued. Your chat draft is unchanged.","inserted":"Feedback text inserted, not sent.","fillFailed":"The composer changed; nothing was inserted. Retry. Your draft was not overwritten.","fillTextOnly":"Inserts text only. Use Send feedback to include the source and layout reference images.","feedbackChanged":"Feedback changed while preparing the reference. Please retry.","noImages":"No images in this session yet. Paste or choose an image.","reload":"Reload","unsupported":"Choose a PNG, JPEG, WebP or GIF image.","invalidPaste":"No image, valid image path or Base64 found. Paste text into a feedback field.","deleteConfirm":"This block has notes. Remove the block and its attached notes?","confirm":"Confirm","cancel":"Cancel","dismiss":"Dismiss notice","export":"Export feedback JSON","more":"More images","retrySave":"Retry save","changes":"layout changes","newImageConfirm":"Current changes will be saved first. Reopen them from session images later.","switch":"Save and switch","reference":"Image and layout canvas","sendAgain":"This feedback was already sent. Edit it before sending again.","sessionChanged":"The viewed session changed. Feedback remains in the original session and was not sent.","commandDraft":"The composer contains a slash command. Finish or clear that command before inserting feedback.","reloadConfirm":"Reload discards unsaved local changes. Export feedback JSON first if needed. Discard and load the Host version?","cutOverlap":"This range includes source pixels already moved away. Drag the currently visible block instead; existing content and notes are unchanged.","keyboardHint":"Space / middle button to pan · Ctrl/Cmd+Z to undo · Arrow keys to nudge blocks"}};
/** Pure session state machine. Browser/Host details are injected; no React or DOM. */
function createSessionState({sessionId,core,rpc,recovery,delay=400}) {
  let state={draft:null,asset:null,history:null,status:'loading',error:'',version:0,ready:false,sending:false};
  let saveTimer,queue=Promise.resolve(),disposed=false,lastSaved=null,epoch=0,loading=null,sendFlight=null,submission=null,textEdit=null,savingDraft=null;
  const subscribers=new Set();
  const same=(a,b)=>a&&b?core.serializeDraft(a)===core.serializeDraft(b):a===b;
  const publish=patch=>{if(disposed)return;state={...state,...patch};for(const fn of subscribers)fn();};
  // A cancelled preview still needs recovery if that preview's save is in flight.
  const isDirty=(draft=state.draft)=>Boolean(draft&&(draft!==lastSaved||(savingDraft&&draft!==savingDraft)));
  function previewValue(next) {
    const baseline=textEdit.baseline;
    const candidate=core.validateDraft(typeof next==='function'?next(state.draft):next,{sessionId,asset:baseline.asset});
    if(JSON.stringify(candidate.asset)!==JSON.stringify(baseline.asset))throw new core.CoreError('IDENTITY_MISMATCH','Text editing cannot replace the bound source asset.');
    const sources=new Map([...baseline.blocks,...state.draft.blocks].map(block=>[block.id,block.source]));
    for(const block of candidate.blocks){
      const source=sources.get(block.id);
      if(source&&['x','y','width','height'].some(key=>source[key]!==block.source[key]))throw new core.CoreError('IDENTITY_MISMATCH','Text editing cannot change an existing block source.');
    }
    return candidate;
  }
  function persist() {
    const dirty=isDirty();
    try{
      if(dirty||submission)recovery.write({schema:1,version:state.version,draft:dirty?state.draft:null,submission});
      else recovery.clear();
      return true;
    }catch(error){publish({error:'Local recovery unavailable: '+error.message});return false;}
  }
  const api={
    getSnapshot:()=>state,
    subscribe:fn=>{subscribers.add(fn);return()=>subscribers.delete(fn);},
    ensureLoaded(){return state.ready?Promise.resolve():loading??api.load();},
    getTextEditKey:()=>textEdit?.key??null,
    // Begin before staging a new annotation so creation and typing share one undo.
    beginTextEdit(key){
      if(disposed||!state.ready||!state.history)return state.draft;
      if(typeof key!=='string'||!key.trim())throw new TypeError('A text edit needs a nonempty string key.');
      if(textEdit?.key===key)return state.draft;
      api.finishTextEdit();
      textEdit={key,baseline:state.history.current};epoch++;
      if(state.status==='loading')publish({status:isDirty()?'unsaved':'saved'});
      return state.draft;
    },
    // Only the live draft advances here. Autosave must not close the undo group.
    previewText(next){
      if(disposed||!state.ready||!state.history)return state.draft;
      if(!textEdit)throw new Error('Begin a text edit before previewing text.');
      const draft=previewValue(next);
      if(draft===state.draft)return draft;
      epoch++;publish({draft,status:isDirty(draft)?'unsaved':'saved',error:''});persist();api.schedule();
      return draft;
    },
    finishTextEdit(){
      if(disposed||!textEdit)return state.draft;
      state.history.commit(state.draft);
      textEdit=null;epoch++;
      publish({draft:state.history.current,status:isDirty()?'unsaved':'saved',error:''});persist();
      if(isDirty())api.schedule();
      return state.draft;
    },
    cancelTextEdit(){
      if(disposed||!textEdit)return state.draft;
      const draft=textEdit.baseline;
      textEdit=null;epoch++;
      publish({draft,status:isDirty(draft)?'unsaved':'saved',error:''});persist();api.schedule();
      return draft;
    },
    load({discard=false}={}){
      if(disposed)return Promise.resolve();
      api.finishTextEdit();
      if(loading&&!discard)return loading;
      const started=++epoch;
      const task=(async()=>{
        if(state.ready&&!discard)await api.flush();
        if(disposed||started!==epoch)return;
        if(discard){clearTimeout(saveTimer);recovery.clear();submission=null;}
        publish({status:'loading',error:''});
        try{
          const result=await rpc({action:'loadDraft'});
          const remote=result.draft?core.validateDraft(result.draft,{sessionId}):null;
          let selected=remote,conflict=false,cached=null;
          try{cached=recovery.read();}catch{}
          if(cached?.schema===1){
            if(cached.submission)submission=cached.submission;
            if(cached.draft){
              const local=core.validateDraft(cached.draft,{sessionId});
              if(!same(local,remote)){selected=local;conflict=cached.version!==result.version;}
            }
          }
          const asset=selected?(await rpc({action:'read',assetId:selected.asset.assetId})).asset:null;
          if(disposed||started!==epoch)return;
          lastSaved=same(selected,remote)?selected:remote;
          publish({draft:selected,asset,history:selected?new core.History(selected,{limit:100}):null,version:conflict?cached.version:result.version,ready:true,
            status:conflict?'error':selected!==lastSaved?'unsaved':'saved',error:conflict?'A newer draft exists on the Host. Local recovery is retained. Export it or explicitly discard and reload before saving.':''});
          persist();if(selected!==lastSaved&&!conflict)api.schedule();
        }catch(error){if(!disposed&&started===epoch)publish({status:'error',error:error.message});}
      })().finally(()=>{if(loading===task)loading=null;});
      loading=task;return task;
    },
    commit(next){if(disposed||!state.ready||!state.history)return;api.finishTextEdit();state.history.commit(next);epoch++;publish({draft:state.history.current,status:'unsaved',error:''});persist();api.schedule();},
    undo(){if(disposed||!state.ready||!state.history)return;api.finishTextEdit();epoch++;state.history.undo();publish({draft:state.history.current,status:'unsaved',error:''});persist();api.schedule();},
    redo(){if(disposed||!state.ready||!state.history)return;api.finishTextEdit();epoch++;state.history.redo();publish({draft:state.history.current,status:'unsaved',error:''});persist();api.schedule();},
    schedule(){clearTimeout(saveTimer);if(!disposed)saveTimer=setTimeout(()=>{api.flush().catch(()=>{});},delay);},
    flush(){
      clearTimeout(saveTimer);
      queue=queue.catch(()=>{}).then(async()=>{
        const draft=state.draft;if(!draft||draft===lastSaved||disposed)return;
        savingDraft=draft;publish({status:'saving'});
        try{
          const result=await rpc({action:'saveDraft',draft,expectedVersion:state.version});
          if(disposed)return;
          lastSaved=draft;publish({version:result.version,status:state.draft===draft?'saved':'unsaved',error:''});persist();
        }catch(error){savingDraft=null;publish({status:'error',error:error.message});persist();throw error;}
        finally{savingDraft=null;}
      });return queue;
    },
    async useAsset(asset){
      await api.ensureLoaded();if(!state.ready)throw new Error('Load the saved state before importing a new image.');
      api.finishTextEdit();
      const beforeSave=epoch;
      await api.flush();
      if(disposed||beforeSave!==epoch)throw new Error('The current draft changed while saving. Its newer edits are retained; retry image selection.');
      const started=++epoch;
      const fields={assetId:asset.assetId,attachmentId:asset.attachmentId,width:asset.width,height:asset.height};
      const saved=await rpc({action:'loadDraft',assetId:asset.assetId});
      if(disposed||started!==epoch)throw new Error('The draft changed while selecting an image. Please retry.');
      const draft=saved.draft?core.validateDraft(saved.draft,{sessionId,asset:fields}):core.createDraft({sessionId,asset:fields});
      lastSaved=null;publish({asset,draft,history:new core.History(draft,{limit:100}),version:saved.version,status:'unsaved',error:''});persist();await api.flush();
    },
    getSubmission:()=>submission,
    setSubmission(value){submission=value;persist();},
    runSubmission(operation){
      if(sendFlight)return sendFlight;
      publish({sending:true});
      sendFlight=Promise.resolve().then(operation).finally(()=>{sendFlight=null;publish({sending:false});persist();});return sendFlight;
    },
    dispose(){if(disposed)return;api.finishTextEdit();persist();disposed=true;clearTimeout(saveTimer);subscribers.clear();},
    setError:error=>publish({error:String(error?.message||error),status:'error'})
  };
  return api;
}

/** Pure view helpers. Zoom never mutates a draft or consumes an undo step. */
function wheelZoomScale(scale,deltaY,deltaMode=0,viewportHeight=600,pinch=false) {
  if(![scale,deltaY,viewportHeight].every(Number.isFinite)||scale<=0)return scale;
  const pixels=deltaY*(deltaMode===1?16:deltaMode===2?Math.max(1,viewportHeight):1);
  return Math.max(.02,Math.min(8,scale*Math.exp(-Math.max(-240,Math.min(240,pixels))*(pinch ? .01 : .002))));
}
function anchoredZoomPlan({width,height,viewportWidth,viewportHeight,scale,nextScale,scrollLeft=0,scrollTop=0,x,y,padding=20,anchor=null}) {
  if(![width,height,viewportWidth,viewportHeight,scale,nextScale,scrollLeft,scrollTop,x,y,padding].every(Number.isFinite)||scale<=0||nextScale<=0)throw new Error('Invalid zoom geometry');
  const next=Math.max(.02,Math.min(8,nextScale));
  if(anchor!==null&&![anchor.x,anchor.y].every(Number.isFinite))throw new Error('Invalid zoom anchor');
  function axis(size,viewport,scroll,point,fixed){
    const origin=Math.max(padding,(viewport-size*scale)/2),assetPoint=fixed??(scroll+point-origin)/scale;
    const newOrigin=Math.max(padding,(viewport-size*next)/2),maximum=Math.max(0,size*next+2*padding-viewport);
    return {anchor:assetPoint,scroll:Math.max(0,Math.min(maximum,newOrigin+assetPoint*next-point))};
  }
  const horizontal=axis(width,viewportWidth,scrollLeft,x,anchor?.x),vertical=axis(height,viewportHeight,scrollTop,y,anchor?.y);
  return {scale:next,scrollLeft:horizontal.scroll,scrollTop:vertical.scroll,point:{x:horizontal.anchor,y:vertical.anchor}};
}

/** Pure direct-edit interaction rules; selecting a block never creates an empty comment. */
function settleFeedbackText(core,controller,noteId=null) {
  const state=controller.getSnapshot();
  if(!controller.getTextEditKey()||!state.draft)return;
  const baseline=state.history.current;
  // Blank newly staged notes are transient UI, not permanent feedback.
  if(state.draft.annotations.some(note=>!note.text.trim()&&!baseline.annotations.some(old=>old.id===note.id))){controller.cancelTextEdit();return;}
  const note=state.draft.annotations.find(item=>item.id===noteId);
  if(note&&note.text!==note.text.trim())controller.previewText(core.updateAnnotation(state.draft,note.id,{text:note.text.trim()}));
  controller.finishTextEdit();
}
function selectionIntent({tool='select',blockId=null,noteId=null,noteKind=null,noteLocalKind=null,forceNew=false}={}) {
  if(tool==='pan')return 'pan';
  if(noteId&&!forceNew){
    if((tool==='select'||tool==='point')&&(noteKind==='point'||(noteKind==='block'&&noteLocalKind==='point')))return 'move-point';
    return tool==='select'&&noteKind==='region'?'move-region':'edit-note';
  }
  if(tool==='point')return 'point';
  if(blockId&&!forceNew)return 'move-block';
  return 'draw-region';
}
function selectionRectangle(start,end,scale=1) {
  if(Math.hypot(end.x-start.x,end.y-start.y)*scale<4)return null;
  const x=Math.round(Math.min(start.x,end.x)),y=Math.round(Math.min(start.y,end.y));
  const rect={x,y,width:Math.round(Math.max(start.x,end.x))-x,height:Math.round(Math.max(start.y,end.y))-y};
  return rect.width>=2&&rect.height>=2?rect:null;
}
/** Move only a point anchor in layout pixels; its free/local binding and all image blocks stay unchanged. */
function movePointAnnotation(core,draft,noteId,layoutPoint) {
  const current=core.validateDraft(draft),note=current.annotations.find(item=>item.id===noteId);
  if(!note)throw new core.CoreError('MISSING_ANNOTATION','Select an existing point annotation before moving it.');
  const target=note.target,local=target.kind==='block'&&target.local?.kind==='point';
  if(target.kind!=='point'&&!local)throw new core.CoreError('INVALID_DRAFT','Only point annotations can be moved with a point gesture.');
  // Identity transform shares the core's strict finite {x,y} validation without changing coordinates.
  const position=core.viewToAsset(layoutPoint,{scale:1});
  const clamp=(value,size)=>Math.max(0,Math.min(Math.max(0,size-1),value));
  let nextTarget,blockId;
  if(local){
    blockId=target.blockId;
    const block=current.blocks.find(item=>item.id===blockId);
    const point={x:clamp(position.x-block.destination.x,block.source.width),y:clamp(position.y-block.destination.y,block.source.height)};
    nextTarget={...target,local:{...target.local,point}};
  }else{
    nextTarget={...target,point:{x:clamp(position.x,current.asset.width),y:clamp(position.y,current.asset.height)}};
  }
  const result={draft:core.updateAnnotation(current,noteId,{target:nextTarget}),noteId};
  if(blockId!==undefined)result.blockId=blockId;
  return result;
}
/** Validate before settling text; a newly staged blank point keeps creation+move+typing in one group. */
function commitPointMove(core,controller,noteId,layoutPoint) {
  const state=controller.getSnapshot();
  if(!state.draft||!state.history)throw new Error('Load an image before moving a point annotation.');
  const checked=movePointAnnotation(core,state.draft,noteId,layoutPoint);
  const note=state.draft.annotations.find(item=>item.id===noteId);
  const freshBlank=Boolean(controller.getTextEditKey()&&!note.text.trim()&&!state.history.current.annotations.some(item=>item.id===noteId));
  if(freshBlank)controller.previewText(checked.draft);
  else{controller.finishTextEdit();controller.commit(checked.draft);}
  return {...checked,draft:controller.getSnapshot().draft};
}
function promoteRegion(core,draft,noteId) {
  const note=draft.annotations.find(n=>n.id===noteId);
  if(!note||note.target.kind!=='region')throw new Error('Select a rectangle annotation before moving its pixels.');
  const rect=note.target.rect;
  // Exact visible frames refer to an existing component, not a second cut of its pixels.
  // Core drafts are ordered bottom-to-top; match the same topmost block as hitTest.
  const existing=[...draft.blocks].reverse().find(block=>['x','y','width','height'].every(key=>block.destination[key]===rect[key]));
  if(existing)return {draft:core.updateAnnotation(draft,noteId,{target:{kind:'block',blockId:existing.id}}),blockId:existing.id};
  // Only source ownership must be disjoint. Layout destinations may overlap freely.
  if(draft.blocks.some(block=>core.rectanglesOverlap(rect,block.source)))throw new Error('This region overlaps already-owned source pixels. Select that block or draw a separate region; the original pixels have not been changed.');
  const next=core.addBlock(draft,rect),blockId=next.blocks[next.blocks.length-1].id;
  return {draft:core.updateAnnotation(next,noteId,{target:{kind:'block',blockId}}),blockId};
}
/** Cut and optionally move a selected frame in one history step; destination is absolute and clamped. */
function promoteSelectedRegion(core,controller,noteId,destination) {
  const state=controller.getSnapshot(),note=state.draft?.annotations.find(n=>n.id===noteId);
  if(!state.draft||!state.history)throw new Error('Load an image before moving its pixels.');
  // Build every candidate before settling input: invalid cuts or coordinates must retain pending text.
  const checked=promoteRegion(core,state.draft,noteId);
  const freshBlank=Boolean(controller.getTextEditKey()&&note&&!note.text.trim()&&!state.history.current.annotations.some(n=>n.id===noteId));
  let draft=checked.draft,blockId=checked.blockId;
  if(freshBlank){
    const baseline=state.history.current;
    if(state.draft.blocks.some(block=>block.id===blockId)){
      if(!baseline.blocks.some(block=>block.id===blockId))throw new Error('Finish creating the selected block before moving it.');
      draft=baseline;
    }else{
      draft=core.addBlock(baseline,note.target.rect);
      blockId=draft.blocks[draft.blocks.length-1].id;
    }
  }
  if(destination!==undefined)draft=core.moveBlock(draft,blockId,destination,{bounds:'clamp'});
  if(freshBlank)controller.cancelTextEdit();
  else controller.finishTextEdit();
  controller.commit(draft);
  return {draft:controller.getSnapshot().draft,blockId,noteId:freshBlank?null:noteId};
}
function blockComment(draft, blockId, selectedNoteId) {
  const selected=draft.annotations.find(note=>note.id===selectedNoteId);
  if(selected?.target.kind==='block'&&selected.target.blockId===blockId)return selected;
  return draft.annotations.find(note=>note.target.kind==='block'&&note.target.blockId===blockId&&!note.target.local)||null;
}
function writeBlockComment(core,draft,blockId,text,selectedNoteId) {
  const note=blockComment(draft,blockId,selectedNoteId);
  if(note)return {draft:core.updateAnnotation(draft,note.id,{text}),noteId:note.id};
  if(!text.length)return {draft,noteId:null};
  const next=core.addAnnotation(draft,{text,target:{kind:'block',blockId}});
  return {draft:next,noteId:next.annotations[next.annotations.length-1].id};
}

/* Native sidebar view. Only the image canvas consumes gestures; no document listeners. */
function createEditorView({React,ctx,EDITOR_NS,Icon,controller,rpc,readFile,targetPoint,renderReference}) {
  const h=React.createElement;
  const settleText=c=>settleFeedbackText(core,c);
  const paths={
    select:'M5 3l14 10-7 1-3 7z',layout:'M4 9V4h5m6 0h5v5m0 6v5h-5m-6 0H4v-5M9 9h6v6H9z',
    point:'M12 21s6-6.6 6-12a6 6 0 0 0-12 0c0 5.4 6 12 6 12zM12 7v4m-2-2h4',
    pan:'M8 12V6a2 2 0 0 1 4 0v6m0-4a2 2 0 0 1 4 0v5m0-3a2 2 0 0 1 4 0v5c0 4-2 6-6 6h-1c-2 0-3-1-4-3l-4-5a2 2 0 0 1 3-2l3 3',
    undo:'M8 5L3 10l5 5M3 10h11a6 6 0 0 1 0 12',redo:'M16 5l5 5-5 5m5-5H10a6 6 0 0 0 0 12',
    fit:'M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5',plus:'M12 5v14M5 12h14',minus:'M5 12h14',
    trash:'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6m4-6v6',reset:'M4 10a8 8 0 1 1 1 8M4 4v6h6',
    send:'M21 3L3 10l7 4 4 7zM10 14L21 3',more:'M5 12h.01M12 12h.01M19 12h.01',
    image:'M3 4h18v16H3zM3 16l6-6 5 5 3-3 4 4M16 8h.01',note:'M4 4h16v12H9l-5 4zM8 8h8m-8 4h5',
    close:'M6 6l12 12M6 18L18 6',download:'M12 3v12m-4-4l4 4 4-4M4 16v5h16v-5',chevron:'M9 5l7 7-7 7',check:'M5 12l4 4L19 6'
  };
  const glyph=name=>h('svg',{className:'dif-icon',viewBox:'0 0 24 24',width:18,height:18,fill:'none',stroke:'currentColor',strokeWidth:1.6,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},h('path',{d:paths[name]||paths.note}));
  const emptyArtwork=()=>h('svg',{className:'dif-empty-art',viewBox:'0 0 190 130',fill:'none','aria-hidden':true},
    h('rect',{className:'dif-art-back',x:30,y:12,width:130,height:94,rx:9,transform:'rotate(-6 95 59)'}),
    h('rect',{className:'dif-art-sheet',x:22,y:22,width:140,height:94,rx:8}),
    h('circle',{cx:33,cy:32,r:2,fill:'currentColor',opacity:.35}),h('circle',{cx:40,cy:32,r:2,fill:'currentColor',opacity:.2}),
    h('path',{d:'M23 41H161',stroke:'currentColor',opacity:.15}),
    h('rect',{className:'dif-art-skeleton',x:33,y:51,width:42,height:52,rx:4}),
    h('rect',{className:'dif-art-skeleton',x:86,y:53,width:50,height:5,rx:2.5}),
    h('rect',{className:'dif-art-skeleton',x:86,y:65,width:61,height:4,rx:2}),
    h('rect',{className:'dif-art-skeleton',x:86,y:75,width:40,height:4,rx:2}),
    h('rect',{className:'dif-art-skeleton',x:86,y:91,width:29,height:12,rx:3}),
    h('rect',{className:'dif-art-selection',x:80,y:46,width:74,height:39,rx:3}),
    h('circle',{className:'dif-art-pin',cx:154,cy:46,r:10}),
    h('text',{className:'dif-art-number',x:154,y:46,textAnchor:'middle',dominantBaseline:'central'},'1'),
    h('path',{d:'m132 95 4 18 4-6 7-2z',fill:'var(--dsw-alias-label-primary)',stroke:'var(--dsw-alias-bg-base)',strokeWidth:1.5}));
  return function Editor(props) {
    React.useSyncExternalStore(fn=>ctx.locale.subscribe(fn),()=>ctx.locale.getSnapshot());
    const t=ctx.locale.bind(EDITOR_NS),c=React.useMemo(()=>controller(props.sessionId),[props.sessionId]);
    const state=React.useSyncExternalStore(c.subscribe,c.getSnapshot),{draft,asset}=state;
    const inputPhase=props.useInput(input=>input.phase);
    const [tool,setTool]=React.useState('select'),[selected,setSelected]=React.useState(null),[selectedNote,setSelectedNote]=React.useState(null);
    const [zoom,setZoom]=React.useState(null),[boxSize,setBoxSize]=React.useState({width:500,height:320});
    const [transient,setTransient]=React.useState(null),[busy,setBusy]=React.useState(false),[notice,setNotice]=React.useState('');
    const [library,setLibrary]=React.useState(null),[pathOpen,setPathOpen]=React.useState(false),[pathValue,setPathValue]=React.useState('');
    const [confirmation,setConfirmation]=React.useState(null),[focusRequest,setFocusRequest]=React.useState(0);
    const [compactHeight,setCompactHeight]=React.useState(false),[fileHover,setFileHover]=React.useState(false),[panning,setPanning]=React.useState(false);
    const rootRef=React.useRef(null),notesScrollRef=React.useRef(null),confirmationRef=React.useRef(null),dragDepth=React.useRef(0);
    // Reveal only inside our own two scrollports; never scroll the chat or shell.
    function revealInEditor(target){
      if(!target)return;
      for(const scroll of [notesScrollRef.current,rootRef.current]){
        if(!scroll?.contains(target))continue;
        const r=target.getBoundingClientRect(),box=scroll.getBoundingClientRect(),top=box.top+scroll.clientTop,bottom=top+scroll.clientHeight;
        if(r.top<top||r.height>scroll.clientHeight)scroll.scrollTop+=r.top-top;
        else if(r.bottom>bottom)scroll.scrollTop+=r.bottom-bottom;
      }
    }
    const svgRef=React.useRef(null),stageRef=React.useRef(null),fileRef=React.useRef(null),editorRef=React.useRef(null),menuRef=React.useRef(null);
    const pointer=React.useRef(null),busyRef=React.useRef(false),alive=React.useRef(true),space=React.useRef(false);
    const zoomIO=React.useRef(null),pendingZoom=React.useRef(null),nativeGesture=React.useRef(null),wheelGesture=React.useRef(null),wheelTimer=React.useRef(null);
    const clipId=React.useId().replace(/:/g,'')+'-dif';
    React.useEffect(()=>{alive.current=true;c.ensureLoaded();return()=>{alive.current=false;settleText(c);c.flush().catch(()=>{});};},[c]);
    React.useEffect(()=>{const stage=stageRef.current;if(!stage)return;const observer=new ResizeObserver(entries=>{const r=entries[0].contentRect;setBoxSize({width:r.width,height:r.height});});observer.observe(stage);return()=>observer.disconnect();},[!!draft]);
    React.useEffect(()=>{if(focusRequest){editorRef.current?.focus({preventScroll:true});revealInEditor(editorRef.current);}},[focusRequest]);
    React.useEffect(()=>{
      if(!confirmation)return;
      const previous=document.activeElement;
      confirmationRef.current?.focus({preventScroll:true});revealInEditor(confirmationRef.current);
      return()=>{if(previous?.isConnected&&rootRef.current?.contains(previous)){previous.focus({preventScroll:true});revealInEditor(previous);}};
    },[confirmation]);
    React.useEffect(()=>{const root=rootRef.current;if(!root)return;const observer=new ResizeObserver(entries=>setCompactHeight(entries[0].contentRect.height<480));observer.observe(root);return()=>observer.disconnect();},[]);
    const scale=draft?Math.max(.02,zoom??Math.min((boxSize.width-40)/draft.asset.width,(boxSize.height-40)/draft.asset.height,1)):1;
    const marker=10/Math.max(.05,scale),block=draft?.blocks.find(b=>b.id===selected);
    const activeNote=draft&&(block?blockComment(draft,block.id,selectedNote):draft.annotations.find(n=>n.id===selectedNote));
    const showDraft=(transient?.kind==='region-move'||transient?.kind==='point-move')?transient.draft:draft&&transient?.kind==='move'?{...draft,blocks:draft.blocks.map(b=>b.id===transient.id?{...b,destination:{...b.destination,...transient.point}}:b)}:draft;
    const displaySelected=transient?.kind==='region-move'?transient.blockId:selected;
    const moves=draft?core.getMoves(draft):[],items=draft?core.getReviewItems(draft):[],displayItems=showDraft?core.getReviewItems(showDraft):[],isLocked=busy||state.sending;
    const activeItem=items.find(item=>activeNote?item.annotationId===activeNote.id:block&&item.key==='block:'+block.id)||null;
    const editKey=block?'block:'+block.id:activeNote?'note:'+activeNote.id:null;
    function clearWheelGesture(){if(wheelTimer.current!==null)clearTimeout(wheelTimer.current);wheelTimer.current=null;wheelGesture.current=null;}
    function viewCenter(){const stage=stageRef.current,r=stage.getBoundingClientRect();return {x:r.left+stage.clientLeft+stage.clientWidth/2,y:r.top+stage.clientTop+stage.clientHeight/2};}
    function screenAnchor(client){const svg=svgRef.current,matrix=svg?.getScreenCTM();if(!matrix)return null;const p=svg.createSVGPoint();p.x=client.x;p.y=client.y;const result=p.matrixTransform(matrix.inverse());return {x:result.x,y:result.y};}
    function correctAnchor(point,client){const svg=svgRef.current,stage=stageRef.current,matrix=svg?.getScreenCTM();if(!matrix||!stage)return;const p=svg.createSVGPoint();p.x=point.x;p.y=point.y;const result=p.matrixTransform(matrix);stage.scrollLeft+=result.x-client.x;stage.scrollTop+=result.y-client.y;}
    function zoomTo(value,client=viewCenter(),fixedPoint=null){
      const stage=stageRef.current;if(!draft||!stage||!Number.isFinite(value))return;if(!fixedPoint)clearWheelGesture();
      const pending=pendingZoom.current,current=pending?.scale??scale,next=Math.max(.02,Math.min(8,value));
      if(next===current&&!fixedPoint)return;
      const r=stage.getBoundingClientRect(),plan=anchoredZoomPlan({width:draft.asset.width,height:draft.asset.height,viewportWidth:stage.clientWidth,viewportHeight:stage.clientHeight,scale:current,nextScale:next,scrollLeft:pending?.scrollLeft??stage.scrollLeft,scrollTop:pending?.scrollTop??stage.scrollTop,x:client.x-r.left-stage.clientLeft,y:client.y-r.top-stage.clientTop,anchor:fixedPoint});
      const point=fixedPoint||(pending?plan.point:screenAnchor(client));if(!point)return;
      if(next===scale){pendingZoom.current=null;correctAnchor(point,client);setZoom(next);return;}
      pendingZoom.current={...plan,point,client};setZoom(next);
    }
    zoomIO.current={
      wheel:event=>{
        if(!draft||isLocked)return;
        if(!event.ctrlKey&&(event.shiftKey||Math.abs(event.deltaX)>Math.abs(event.deltaY)))return;
        event.preventDefault();event.stopPropagation();
        if(pointer.current||nativeGesture.current)return;
        const client={x:event.clientX,y:event.clientY};let gesture=wheelGesture.current;
        if(!gesture||gesture.pinch!==event.ctrlKey||(!event.ctrlKey&&Math.hypot(client.x-gesture.client.x,client.y-gesture.client.y)>4)){
          gesture={point:screenAnchor(client),client,pinch:event.ctrlKey};wheelGesture.current=gesture;
        }
        if(!gesture.point)return;
        if(wheelTimer.current!==null)clearTimeout(wheelTimer.current);
        wheelTimer.current=setTimeout(()=>{wheelGesture.current=null;wheelTimer.current=null;},250);
        zoomTo(wheelZoomScale(pendingZoom.current?.scale??scale,event.deltaY,event.deltaMode,stageRef.current.clientHeight,event.ctrlKey),client,gesture.point);
      },
      start:event=>{if(!draft||isLocked||pointer.current)return;clearWheelGesture();event.preventDefault();event.stopPropagation();const client=Number.isFinite(event.clientX)&&Number.isFinite(event.clientY)?{x:event.clientX,y:event.clientY}:viewCenter();nativeGesture.current={scale:pendingZoom.current?.scale??scale,point:screenAnchor(client),client};},
      change:event=>{const gesture=nativeGesture.current;if(!gesture)return;event.preventDefault();event.stopPropagation();if(isLocked||pointer.current||!Number.isFinite(event.scale)||event.scale<=0)return;const client=Number.isFinite(event.clientX)&&Number.isFinite(event.clientY)?{x:event.clientX,y:event.clientY}:gesture.client;zoomTo(gesture.scale*event.scale,client,gesture.point);},
      end:event=>{if(nativeGesture.current){event.preventDefault();event.stopPropagation();nativeGesture.current=null;}}
    };
    React.useLayoutEffect(()=>{const pending=pendingZoom.current,stage=stageRef.current;if(!pending||pending.scale!==scale||!stage)return;stage.scrollLeft=pending.scrollLeft;stage.scrollTop=pending.scrollTop;correctAnchor(pending.point,pending.client);pendingZoom.current=null;},[scale]);
    React.useEffect(()=>{
      const stage=stageRef.current;if(!stage||!draft)return;
      const wheel=e=>zoomIO.current.wheel(e),start=e=>zoomIO.current.start(e),change=e=>zoomIO.current.change(e),end=e=>zoomIO.current.end(e),options={passive:false};
      stage.addEventListener('wheel',wheel,options);stage.addEventListener('gesturestart',start,options);stage.addEventListener('gesturechange',change,options);stage.addEventListener('gestureend',end,options);
      return()=>{stage.removeEventListener('wheel',wheel);stage.removeEventListener('gesturestart',start);stage.removeEventListener('gesturechange',change);stage.removeEventListener('gestureend',end);clearWheelGesture();pendingZoom.current=null;nativeGesture.current=null;};
    },[draft?.asset.assetId]);
    function error(e){setNotice('');c.setError(e?.code==='SOURCE_OVERLAP'||/overlaps already-owned source pixels/i.test(e?.message)?t('cutOverlap'):e);}
    async function act(fn){if(busyRef.current)return;busyRef.current=true;setBusy(true);setNotice('');try{await fn();}catch(e){if(alive.current)error(e);}finally{busyRef.current=false;if(alive.current)setBusy(false);}}
    function finishEditor(){settleFeedbackText(core,c,activeNote?.id);}
    function change(fn){try{finishEditor();const now=c.getSnapshot().draft;if(now)c.commit(fn(now));}catch(e){error(e);}}
    function focusEditor(){setFocusRequest(n=>n+1);}
    function chooseNote(id,focus=true){if(activeNote?.id!==id)finishEditor();const n=c.getSnapshot().draft?.annotations.find(n=>n.id===id);setSelected(n?.target.kind==='block'?n.target.blockId:null);setSelectedNote(n?.id||null);if(n&&focus)focusEditor();}
    function chooseBlock(id,focus=false){finishEditor();const now=c.getSnapshot().draft;setSelected(id);setSelectedNote(id?blockComment(now,id,null)?.id||null:null);if(id&&focus)focusEditor();}
    function addNote(target){
      try{finishEditor();const now=c.getSnapshot().draft;if(!now)return;const next=core.addAnnotation(now,{text:'',target}),id=next.annotations[next.annotations.length-1].id;
        c.beginTextEdit(target.kind==='block'?'block:'+target.blockId:'note:'+id);c.previewText(next);
        setSelected(target.kind==='block'?target.blockId:null);setSelectedNote(id);focusEditor();
      }catch(e){error(e);}
    }
    function editText(value){
      try{if(!editKey)return;c.beginTextEdit(editKey);const now=c.getSnapshot().draft;
        if(block){const result=writeBlockComment(core,now,block.id,value,activeNote?.id);c.previewText(result.draft);if(result.noteId!==selectedNote){setSelectedNote(result.noteId);focusEditor();}}
        else if(activeNote)c.previewText(core.updateAnnotation(now,activeNote.id,{text:value}));
      }catch(e){error(e);}
    }
    function setMode(value){try{finishEditor();setTool(value);}catch(e){error(e);}}
    function checkSession(){if(ctx.sidebarRight.mounted.getSnapshot()!==props.sessionId)throw new Error(t('sessionChanged'));}
    async function importSource(source){
      const result=await rpc(props.sessionId,source.kind==='stored'?{action:'read',assetId:source.assetId}:{action:'import',source});
      if(!alive.current)return;await c.useAsset(result.asset);setZoom(null);setSelected(null);setSelectedNote(null);setLibrary(null);setTool('select');setNotice('');
    }
    function requestImport(source){finishEditor();const now=c.getSnapshot().draft;if(now&&(now.blocks.length||now.annotations.length)){setConfirmation({kind:'switch',run:()=>act(()=>importSource(source))});return;}act(()=>importSource(source));}
    async function fromFile(file){if(!file)return;if(!/^image\/(png|jpeg|webp|gif)$/.test(file.type))throw new Error(t('unsupported'));if(file.size>20*1024*1024)throw new Error('Image exceeds 20 MiB');const data=await readFile(file);requestImport({kind:'base64',data,mediaType:file.type,name:file.name||'clipboard.png'});}
    function sourceOf(text){text=text.trim();if(/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(text)||(/^[A-Za-z0-9+/\r\n]+=*$/.test(text)&&text.length>100))return {kind:'base64',data:text};if(/^(?:[A-Za-z]:[\\/]|\\\\|\/|\.\.?[\\/])/.test(text))return {kind:'path',path:text.replace(/^"|"$/g,'')};throw new Error(t('invalidPaste'));}
    function paste(event){if(event.target.closest('textarea,input,[contenteditable=true]')||isLocked)return;const file=[...event.clipboardData.files].find(f=>f.type.startsWith('image/'));if(file){event.preventDefault();fromFile(file).catch(error);return;}const text=event.clipboardData.getData('text/plain');if(text){event.preventDefault();try{requestImport(sourceOf(text));}catch(e){error(e);}}}
    function openLibrary(){if(menuRef.current)menuRef.current.open=false;act(async()=>setLibrary(await rpc(props.sessionId,{action:'list',limit:30})));}
    function point(event){const r=svgRef.current.getBoundingClientRect();return {x:Math.max(0,Math.min(draft.asset.width,(event.clientX-r.left)/r.width*draft.asset.width)),y:Math.max(0,Math.min(draft.asset.height,(event.clientY-r.top)/r.height*draft.asset.height))};}
    function down(event){
      if(!draft||isLocked||pointer.current||![0,1].includes(event.button))return;
      event.preventDefault();
      if(event.button===1||space.current||tool==='pan'){
        finishEditor();stageRef.current?.focus({preventScroll:true});
        pointer.current={kind:'pan',x:event.clientX,y:event.clientY,left:stageRef.current.scrollLeft,top:stageRef.current.scrollTop};setPanning(true);event.currentTarget.setPointerCapture(event.pointerId);return;
      }
      const p=point(event),noteId=event.target.closest('[data-note-id]')?.getAttribute('data-note-id');
      const markerHit=!!event.target.closest('[data-note-marker]'),now=c.getSnapshot().draft;
      const visibleBlock=core.hitTest(now,p),blockId=event.target.closest('[data-block-id]')?.getAttribute('data-block-id')||(!markerHit?visibleBlock?.id:null);
      const note=now.annotations.find(n=>n.id===noteId);
      // Inactive transparent notes must not intercept a block; an explicitly selected frame keeps its drag intent.
      const routedNoteId=blockId&&!markerHit&&note?.target.kind==='region'&&activeNote?.id!==noteId?null:noteId;
      const intent=selectionIntent({tool,blockId,noteId:routedNoteId,noteKind:note?.target.kind,noteLocalKind:note?.target.local?.kind,forceNew:event.shiftKey});
      if(intent==='edit-note'){chooseNote(noteId);return;}
      if(intent==='move-point'){
        if(activeNote?.id!==noteId)finishEditor();
        const current=c.getSnapshot().draft.annotations.find(n=>n.id===noteId);if(!current)return;
        setSelected(current.target.kind==='block'?current.target.blockId:null);setSelectedNote(noteId);
        pointer.current={kind:'point-move',noteId,start:p,origin:targetPoint(c.getSnapshot().draft,current),version:c.getSnapshot().history.version,assetId:draft.asset.assetId};
        event.currentTarget.setPointerCapture(event.pointerId);return;
      }
      if(intent==='move-region'){
        // A newly framed empty note remains pending until we know whether this is a click or a move.
        if(activeNote?.id!==noteId)finishEditor();
        const current=c.getSnapshot().draft.annotations.find(n=>n.id===noteId);if(!current)return;
        const r=current.target.rect;setSelected(null);setSelectedNote(noteId);
        pointer.current={kind:'region-move',noteId,start:p,origin:{x:r.x,y:r.y},width:r.width,height:r.height,version:c.getSnapshot().history.version,assetId:draft.asset.assetId};
        event.currentTarget.setPointerCapture(event.pointerId);return;
      }
      finishEditor();stageRef.current?.focus({preventScroll:true});
      if(intent==='point'){
        const b=draft.blocks.find(b=>b.id===blockId);
        addNote(b?{kind:'block',blockId,local:{kind:'point',point:{x:Math.min(b.source.width-1,Math.max(0,p.x-b.destination.x)),y:Math.min(b.source.height-1,Math.max(0,p.y-b.destination.y))}}}:{kind:'point',space:'layout',point:{x:Math.min(draft.asset.width-1,p.x),y:Math.min(draft.asset.height-1,p.y)}});return;
      }
      if(intent==='move-block'){
        chooseBlock(blockId);const b=c.getSnapshot().draft.blocks.find(b=>b.id===blockId);
        pointer.current={kind:'move',id:blockId,start:p,origin:{x:b.destination.x,y:b.destination.y},width:b.source.width,height:b.source.height,version:c.getSnapshot().history.version,assetId:draft.asset.assetId};
      }else pointer.current={kind:intent,start:p,version:c.getSnapshot().history.version,assetId:draft.asset.assetId};
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    function destination(a,p){return {x:Math.round(Math.max(0,Math.min(draft.asset.width-a.width,a.origin.x+p.x-a.start.x))),y:Math.round(Math.max(0,Math.min(draft.asset.height-a.height,a.origin.y+p.y-a.start.y)))};}
    function move(event){
      const a=pointer.current;if(!a)return;
      if(a.kind==='pan'){stageRef.current.scrollLeft=a.left-event.clientX+a.x;stageRef.current.scrollTop=a.top-event.clientY+a.y;return;}
      const p=point(event);
      if(a.kind==='move'){setTransient({kind:'move',id:a.id,point:destination(a,p)});return;}
      if(a.kind==='point-move'){
        if(Math.hypot(p.x-a.start.x,p.y-a.start.y)*scale<4){setTransient(null);return;}
        try{const preview=movePointAnnotation(core,c.getSnapshot().draft,a.noteId,{x:a.origin.x+p.x-a.start.x,y:a.origin.y+p.y-a.start.y}).draft;setTransient({kind:'point-move',draft:preview});}
        catch(e){cancelPointer();if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);error(e);}
        return;
      }
      if(a.kind==='region-move'){
        if(Math.hypot(p.x-a.start.x,p.y-a.start.y)*scale<4){setTransient(null);return;}
        try{
          if(!a.preview)a.preview=promoteRegion(core,c.getSnapshot().draft,a.noteId);
          const preview=core.moveBlock(a.preview.draft,a.preview.blockId,destination(a,p),{bounds:'clamp'});
          setTransient({kind:'region-move',draft:preview,blockId:a.preview.blockId});
        }catch(e){cancelPointer();if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);error(e);}
        return;
      }
      setTransient({kind:a.kind,rect:{x:Math.min(a.start.x,p.x),y:Math.min(a.start.y,p.y),width:Math.abs(p.x-a.start.x),height:Math.abs(p.y-a.start.y)}});
    }
    function cancelPointer(){pointer.current=null;setTransient(null);setPanning(false);}
    function up(event){
      const a=pointer.current;if(!a)return;cancelPointer();if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
      if(a.kind==='pan'||a.version!==c.getSnapshot().history.version||a.assetId!==c.getSnapshot().draft.asset.assetId)return;
      const p=point(event),dragged=Math.hypot(p.x-a.start.x,p.y-a.start.y)*scale>=4;
      if(a.kind==='point-move'){
        if(!dragged){chooseNote(a.noteId,true);return;}
        try{const result=commitPointMove(core,c,a.noteId,{x:a.origin.x+p.x-a.start.x,y:a.origin.y+p.y-a.start.y});const note=result.draft.annotations.find(n=>n.id===a.noteId);setSelected(note?.target.kind==='block'?note.target.blockId:null);setSelectedNote(a.noteId);focusEditor();}catch(e){error(e);}return;
      }
      if(a.kind==='region-move'){
        const d=destination(a,p);
        if(!dragged||(d.x===a.origin.x&&d.y===a.origin.y)){chooseNote(a.noteId,true);return;}
        try{const result=promoteSelectedRegion(core,c,a.noteId,d);setSelected(result.blockId);setSelectedNote(result.noteId);stageRef.current?.focus({preventScroll:true});}catch(e){error(e);}return;
      }
      if(a.kind==='move'){
        if(!dragged){chooseBlock(a.id,true);return;}
        change(d=>core.moveBlock(d,a.id,destination(a,p),{bounds:'clamp'}));return;
      }
      const rect=selectionRectangle(a.start,p,scale);if(!rect){setSelected(null);setSelectedNote(null);return;}
      addNote({kind:'region',space:'layout',rect});
    }
    function key(event){
      if(event.nativeEvent?.isComposing)return;
      if(event.key==='Escape'&&pathOpen&&event.target.closest('.dif-import')){event.preventDefault();setPathOpen(false);stageRef.current?.focus({preventScroll:true});return;}
      if(event.target.closest('textarea,input,[contenteditable=true]'))return;
      // Keyboard history and movement obey the same submission lock as buttons.
      if(isLocked)return;
      if(event.code==='Space'&&!event.target.closest('button,summary,a,select')){space.current=true;event.preventDefault();return;}
      if(event.key==='Escape'){c.cancelTextEdit();cancelPointer();setConfirmation(null);setLibrary(null);setPathOpen(false);if(menuRef.current)menuRef.current.open=false;setSelected(null);setSelectedNote(null);return;}
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();event.shiftKey?c.redo():c.undo();return;}
      if(block&&stageRef.current?.contains(event.target)&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();const n=event.shiftKey?10:1;change(d=>{const b=d.blocks.find(x=>x.id===selected);return core.moveBlock(d,selected,{x:b.destination.x+(event.key==='ArrowRight'?n:event.key==='ArrowLeft'?-n:0),y:b.destination.y+(event.key==='ArrowDown'?n:event.key==='ArrowUp'?-n:0)},{bounds:'clamp'});});}
    }
    function removeBlock(){if(!block)return;const id=block.id,run=()=>change(d=>{setSelected(null);setSelectedNote(null);return core.removeBlock(d,id,{annotationPolicy:'remove'});});if(draft.annotations.some(a=>a.target.kind==='block'&&a.target.blockId===id))setConfirmation({kind:'delete',run});else run();}
    function removeNote(){if(!activeNote)return;const id=activeNote.id;finishEditor();const now=c.getSnapshot().draft;if(now.annotations.some(n=>n.id===id))c.commit(core.removeAnnotation(now,id));setSelectedNote(null);}
    async function send(){
      finishEditor();checkSession();await c.flush();const captured=c.getSnapshot().draft;if(!captured||!core.hasFeedback(captured))return;
      const fingerprint='unified-v1\n'+core.serializeDraft(captured);let record=c.getSubmission();
      if(record?.fingerprint===fingerprint&&record.accepted){setNotice(t('sendAgain'));return;}
      if(record?.fingerprint!==fingerprint){record={fingerprint,clientTimeZone:Intl.DateTimeFormat().resolvedOptions().timeZone};c.setSubmission(record);}
      if(!record.referenceAssetId){const data=await renderReference(captured,c.getSnapshot().asset),ref=await rpc(props.sessionId,{action:'import',source:{kind:'base64',data,mediaType:'image/png',name:'image-feedback-layout-reference.png'}});record.referenceAssetId=ref.asset.assetId;c.setSubmission(record);}
      if(!record.requestId){const bytes=new TextEncoder().encode(fingerprint+'\n'+record.referenceAssetId+'\n'+record.clientTimeZone);record.requestId='feedback-'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');c.setSubmission(record);}
      checkSession();if(c.getSnapshot().draft!==captured)throw new Error(t('feedbackChanged'));
      const result=await rpc(props.sessionId,{action:'submit',draft:captured,requestId:record.requestId,referenceAssetId:record.referenceAssetId,clientTimeZone:record.clientTimeZone});
      if(result.accepted){record.accepted=true;c.setSubmission(record);if(alive.current)setNotice(t('accepted'));}
    }
    function fill(){finishEditor();checkSession();const captured=c.getSnapshot().draft;if(!captured)return;if(inputPhase==='claimed')throw new Error(t('commandDraft'));const s=props.inputActions.captureInsertion(),span={...s,start:s.end,end:s.end};if(!props.inputActions.insertText('\n'+core.buildFeedback(captured).text+'\n',span))throw new Error(t('fillFailed'));setNotice(t('inserted')+' '+t('fillTextOnly'));}
    function exportJSON(){finishEditor();const now=c.getSnapshot().draft;if(!now)return;const url=URL.createObjectURL(new Blob([core.serializeDraft(now)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='image-feedback.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),0);if(menuRef.current)menuRef.current.open=false;}
    function button(label,fn,{icon,iconOnly=false,disabled=false,className='',...extra}={}){return h('button',{type:'button',className:'dif-btn '+(iconOnly?'dif-icon-btn ':'')+className,onClick:fn,disabled:isLocked||disabled,title:t(label),'aria-label':t(label),...extra},icon&&glyph(icon),!iconOnly&&h('span',{className:'dif-tool-label'},t(label)));}
    const itemKind=item=>t(item?.kind==='global'?'global':item?.kind==='move'?'moveItem':'commentItem');
    const signed=n=>(n>=0?'+':'')+Math.round(n);
    const moveLabel=item=>item.move?`${signed(item.move.delta.x)}, ${signed(item.move.delta.y)} px`:'';
    function activateItem(item){
      if(item.annotationId)chooseNote(item.annotationId);else chooseBlock(item.blockId,true);
      const anchor=item.layout,stage=stageRef.current,svg=svgRef.current;if(!anchor||!stage||!svg)return;
      const p=anchor.kind==='point'?anchor.point:{x:anchor.rect.x+anchor.rect.width/2,y:anchor.rect.y+anchor.rect.height/2};
      const r=svg.getBoundingClientRect(),v=stage.getBoundingClientRect();
      stage.scrollLeft+=r.left+p.x*scale-(v.left+stage.clientLeft+stage.clientWidth/2);
      stage.scrollTop+=r.top+p.y*scale-(v.top+stage.clientTop+stage.clientHeight/2);
    }
    const thumbnail=item=>item.move&&h('svg',{className:'dif-item-thumb',viewBox:`${item.block.source.x} ${item.block.source.y} ${item.block.source.width} ${item.block.source.height}`,preserveAspectRatio:'xMidYMid slice','aria-hidden':true},h('image',{href:asset.url,width:draft.asset.width,height:draft.asset.height}));
    const drawSvg=()=>h('svg',{ref:svgRef,className:'dif-canvas',width:Math.max(1,draft.asset.width*scale),height:Math.max(1,draft.asset.height*scale),viewBox:`0 0 ${draft.asset.width} ${draft.asset.height}`,role:'img','aria-label':t('reference'),style:{cursor:panning?'grabbing':tool==='pan'?'grab':tool==='select'?'default':'crosshair'},onPointerDown:down,onPointerMove:move,onPointerUp:up,onPointerCancel:cancelPointer,onLostPointerCapture:cancelPointer},
      h('defs',null,h('mask',{id:clipId,maskUnits:'userSpaceOnUse',x:0,y:0,width:draft.asset.width,height:draft.asset.height},h('rect',{width:draft.asset.width,height:draft.asset.height,fill:'white'}),...showDraft.blocks.map(b=>h('rect',{key:b.id,...b.source,fill:'black'})))),
      h('image',{href:asset.url,width:draft.asset.width,height:draft.asset.height,mask:`url(#${clipId})`,pointerEvents:'none'}),
      ...showDraft.blocks.filter(b=>b.destination.x!==b.source.x||b.destination.y!==b.source.y).map(b=>h('rect',{key:'hole'+b.id,...b.source,fill:'none',stroke:'var(--dsw-alias-border-l2)',strokeWidth:1/scale,strokeDasharray:`${4/scale} ${3/scale}`,pointerEvents:'none'})),
      ...[...showDraft.blocks].sort((a,b)=>a.zIndex-b.zIndex).map(b=>h('g',{key:b.id,'data-block-id':b.id,className:'dif-block'},
        h('svg',{x:b.destination.x,y:b.destination.y,width:b.source.width,height:b.source.height,viewBox:`${b.source.x} ${b.source.y} ${b.source.width} ${b.source.height}`,overflow:'hidden'},h('image',{href:asset.url,width:draft.asset.width,height:draft.asset.height})),
        h('rect',{...b.destination,fill:'transparent',stroke:b.id===displaySelected?'var(--dif-annotation)':'var(--dsw-alias-border-l2)',strokeWidth:(b.id===displaySelected?2:.75)/scale}),
        b.id===displaySelected&&[[0,0],[1,0],[0,1],[1,1]].map(([x,y],i)=>h('rect',{key:i,x:b.destination.x+x*b.destination.width-2.5/scale,y:b.destination.y+y*b.destination.height-2.5/scale,width:5/scale,height:5/scale,fill:'var(--dsw-alias-bg-base)',stroke:'var(--dif-annotation)',strokeWidth:1/scale,pointerEvents:'none'}))
      )),
             ...displayItems.map(item=>{const anchor=item.layout;if(!anchor)return null;const p=anchor.kind==='point'?anchor.point:anchor.rect,hot=activeItem?.key===item.key;const x=Math.max(marker,Math.min(draft.asset.width-marker,p.x)),y=Math.max(marker,Math.min(draft.asset.height-marker,p.y));return h('g',{key:item.key,'data-note-id':item.annotationId||undefined,'data-block-id':item.annotationId?undefined:item.blockId},
         anchor.kind==='region'&&h('rect',{...anchor.rect,fill:'transparent',pointerEvents:item.annotation?.target.kind==='region'?undefined:'none',style:{cursor:tool==='select'?'move':'crosshair'},stroke:'var(--dif-annotation)',strokeWidth:(hot?2:1.5)/scale,strokeDasharray:hot?undefined:[4/scale,3/scale].join(' ')}),
         h('circle',{'data-note-marker':item.annotationId?true:undefined,style:{cursor:anchor.kind==='point'?'grab':tool==='select'?'move':'pointer'},cx:x,cy:y,r:marker,fill:'var(--dif-annotation)',stroke:'var(--dsw-alias-bg-base)',strokeWidth:(hot?2:1)/scale}),
         h('text',{x,y,fill:'var(--dif-annotation-ink)',fontSize:marker*1.15,fontWeight:600,textAnchor:'middle',dominantBaseline:'central',pointerEvents:'none'},item.number));}),
transient?.rect&&h('rect',{...transient.rect,fill:'color-mix(in srgb,var(--dif-annotation) 8%,transparent)',stroke:'var(--dif-annotation)',strokeWidth:2/scale,pointerEvents:'none'})
    );
    const menu=()=>h('details',{className:'dif-menu',ref:menuRef},h('summary',{className:'dif-btn dif-icon-btn',title:t('options'),'aria-label':t('options')},glyph('more')),h('div',{className:'dif-menu-body'},
      button('openFile',()=>{menuRef.current.open=false;fileRef.current.click();},{icon:'image',disabled:!state.ready}),button('library',openLibrary,{icon:'image',disabled:!state.ready}),button('path',()=>{setPathOpen(x=>!x);menuRef.current.open=false;},{disabled:!state.ready}),
      draft&&button('export',exportJSON,{icon:'download'}),block&&button('removeBlock',()=>{menuRef.current.open=false;removeBlock();},{icon:'trash'}),draft&&h('p',{className:'dif-subtle'},t('keyboardHint'))));
    const inspector=(activeNote||block)&&h('div',{className:'dif-inspector','data-testid':'active-feedback'},
      h('div',{className:'dif-note-head'},h('span',{className:'dif-number'},activeItem?.number||'—'),h('span',{className:'dif-kind'},itemKind(activeItem)),h('span',{className:'dif-subtle'},block?`${block.destination.x-block.source.x>=0?'+':''}${block.destination.x-block.source.x}, ${block.destination.y-block.source.y>=0?'+':''}${block.destination.y-block.source.y} px`:''),h('span',{className:'dif-spacer'}),block&&button('reset',()=>change(d=>core.resetBlock(d,block.id)),{icon:'reset',iconOnly:true}),button(activeNote?'delete':'removeBlock',activeNote?removeNote:removeBlock,{icon:'trash',iconOnly:true})),
      h('textarea',{ref:editorRef,value:activeNote?.text||'',placeholder:t(block?'blockPlaceholder':'placeholder'),rows:2,maxLength:10000,'aria-label':t('notes'),disabled:isLocked,onFocus:()=>{if(editKey)c.beginTextEdit(editKey);},onChange:e=>editText(e.target.value),onBlur:e=>{if(e.relatedTarget?.getAttribute?.('data-feedback-action')!=='undo'&&!['region-move','point-move'].includes(pointer.current?.kind))finishEditor();},onKeyDown:e=>{
        if(e.nativeEvent.isComposing)return;
        if(e.key==='Escape'){e.preventDefault();e.stopPropagation();cancelPointer();c.cancelTextEdit();editorRef.current?.blur();}
        else if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();finishEditor();editorRef.current?.blur();stageRef.current?.focus({preventScroll:true});}
      }}),block&&!activeNote?.text&&h('div',{className:'dif-note-help'},t('optionalComment')));
    return h('section',{ref:rootRef,className:'dif-root','data-image-feedback-ui':'3.1','data-compact-height':compactHeight,'data-image-feedback-state':draft?'editing':'empty','aria-label':t('workspace'),onPaste:paste,onKeyDown:key,onKeyUp:e=>{if(e.code==='Space')space.current=false;},onBlur:e=>{if(!e.currentTarget.contains(e.relatedTarget))space.current=false;},onDragEnter:e=>{if(!isLocked&&e.dataTransfer.types.includes('Files')){e.preventDefault();dragDepth.current++;setFileHover(true);}},onDragLeave:()=>{dragDepth.current=Math.max(0,dragDepth.current-1);if(!dragDepth.current)setFileHover(false);},onDragOver:e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();e.dataTransfer.dropEffect=isLocked?'none':'copy';}},onDrop:e=>{dragDepth.current=0;setFileHover(false);if(e.dataTransfer.types.includes('Files'))e.preventDefault();if(isLocked)return;const file=[...e.dataTransfer.files].find(f=>f.type.startsWith('image/'));if(file)fromFile(file).catch(error);}},
       fileHover&&h('div',{className:'dif-drop-target',role:'status'},glyph('image'),h('span',null,t('dropImage'))),
      h('style',null,CSS),h('input',{ref:fileRef,type:'file',accept:'image/png,image/jpeg,image/webp,image/gif',hidden:true,onChange:e=>{fromFile(e.target.files?.[0]).catch(error);e.target.value='';}}),
      draft&&h('header',{className:'dif-source'},glyph('image'),h('div',{className:'dif-source-info'},h('span',{className:'dif-source-name',title:asset.name||t('reference')},asset.name||t('reference')),h('span',{className:'dif-dimensions'},`${draft.asset.width} × ${draft.asset.height} px`)),h('span',{className:'dif-save-state','data-state':state.status,role:'status',title:state.error||t(state.status in MESSAGES.en?state.status:'ready')},h('span',null,t(state.status in MESSAGES.en?state.status:'ready'))),button('replace',openLibrary,{className:'dif-text-action'}),menu()),
      draft&&h('div',{className:'dif-toolbar',role:'toolbar','aria-label':t('tools')},h('div',{className:'dif-toolgroup'},...['select','point'].map(k=>button(k,()=>setMode(k),{icon:k,'aria-pressed':tool===k,title:t(k+'Help')}))),h('span',{className:'dif-spacer'}),h('i',{className:'dif-divider'}),button('undo',()=>c.undo(),{icon:'undo',iconOnly:true,'data-feedback-action':'undo',onPointerDown:e=>e.preventDefault(),disabled:!state.history.canUndo&&!c.getTextEditKey()}),button('redo',()=>{finishEditor();c.redo();},{icon:'redo',iconOnly:true,disabled:!state.history.canRedo})),
      pathOpen&&h('div',{className:'dif-import'},h('input',{type:'text',value:pathValue,placeholder:t('path'),'aria-label':t('path'),onChange:e=>setPathValue(e.target.value)}),button('import',()=>{try{requestImport(sourceOf(pathValue));setPathOpen(false);setPathValue('');}catch(e){error(e);}},{disabled:!state.ready}),button('cancel',()=>setPathOpen(false),{icon:'close',iconOnly:true})),
      library&&h('div',{className:'dif-library'},h('div',{className:'dif-library-head'},h('strong',null,t('library')),h('span',{className:'dif-spacer'}),button('openFile',()=>fileRef.current.click(),{icon:'image'}),button('cancel',()=>setLibrary(null),{icon:'close',iconOnly:true})),library.items.length?h('div',{className:'dif-asset-grid'},...library.items.map(a=>h('button',{key:a.assetId||a.attachmentId,type:'button',className:'dif-asset',disabled:isLocked,'aria-pressed':!!draft&&(a.assetId===draft.asset.assetId||a.attachmentId===draft.asset.attachmentId),onClick:()=>requestImport(a.assetId?{kind:'stored',assetId:a.assetId}:{kind:'history',attachmentId:a.attachmentId})},a.url?h('img',{src:a.url,alt:'',loading:'lazy'}):glyph('image'),h('span',null,a.name||t('reference')),h('small',null,`${a.width} × ${a.height}`)))):h('p',{className:'dif-subtle'},t('noImages')),library.nextOffset!=null&&button('more',()=>act(async()=>{const next=await rpc(props.sessionId,{action:'list',offset:library.nextOffset,limit:30});setLibrary({...next,items:[...library.items,...next.items]});}))),
      confirmation&&h('div',{ref:confirmationRef,className:'dif-inline-confirm',role:'alert',tabIndex:-1},h('span',null,t(confirmation.kind==='switch'?'newImageConfirm':confirmation.kind==='reload'?'reloadConfirm':'deleteConfirm')),button(confirmation.kind==='switch'?'switch':'confirm',()=>{const fn=confirmation.run;setConfirmation(null);fn();}),button('cancel',()=>setConfirmation(null))),
      h('div',{className:'dif-canvas-area'},h('div',{className:'dif-stage',ref:stageRef,tabIndex:0,'aria-label':t('reference')},draft?h('div',{className:'dif-canvas-wrap'},drawSvg()):h('div',{className:'dif-empty'},emptyArtwork(),h('span',{className:'dif-eyebrow'},t('workspace')),h('strong',null,t('paste')),h('p',null,t('pasteHint')),h('div',{className:'dif-empty-actions'},button('openFile',()=>fileRef.current.click(),{icon:'image',className:'dif-primary',disabled:!state.ready}),button('library',openLibrary,{className:'dif-secondary',disabled:!state.ready})),button('path',()=>setPathOpen(x=>!x),{className:'dif-empty-more dif-text-action',disabled:!state.ready}),h('ol',{className:'dif-empty-steps','aria-label':t('workflow')},...['stepMark','stepMove','stepSend'].map((step,i)=>h('li',{key:step},h('span',{'aria-hidden':true},'0'+(i+1)),t(step)))))),
        draft&&h('div',{className:'dif-mode-hint'},t(tool==='point'?'pointHint':tool==='pan'?'panHint':'selectHint')),
        draft&&h('div',{className:'dif-zoom',title:t('zoomHint'),'aria-label':t('zoomHint')},button('pan',()=>setMode(tool==='pan'?'select':'pan'),{icon:'pan',iconOnly:true,'aria-pressed':tool==='pan'}),h('i',{className:'dif-divider'}),button('zoomOut',()=>zoomTo(scale/1.25),{icon:'minus',iconOnly:true}),h('span',null,Math.round(scale*100)+'%'),button('zoomIn',()=>zoomTo(scale*1.25),{icon:'plus',iconOnly:true}),button('fit',()=>{clearWheelGesture();pendingZoom.current=null;nativeGesture.current=null;setZoom(null);},{icon:'fit',iconOnly:true}))),
      draft&&h('div',{className:'dif-bottom'},h('div',{className:'dif-list-title'},h('strong',null,t('notes')),h('span',{className:'dif-count'},items.length),h('span',{className:'dif-spacer'}),button('addGlobal',()=>addNote({kind:'global'}),{icon:'plus',className:'dif-text-action'})),
                 h('div',{className:'dif-notes-scroll',ref:notesScrollRef},
           ...items.map(item=>h('div',{key:item.key,'data-review-key':item.key},activeItem?.key===item.key?inspector:h('button',{type:'button',className:'dif-note-row',onClick:()=>activateItem(item),disabled:isLocked,title:(item.text||itemKind(item))+(item.move?' · '+moveLabel(item):'')},h('span',{className:'dif-number'},item.number),thumbnail(item),h('span',{className:'dif-row-main'},h('span',{className:'dif-row-title'},h('span',{className:'dif-kind'},itemKind(item)),h('span',{className:'dif-note-snippet'},item.text||(item.move?t('moveOnly'):t('placeholder')))),item.move&&h('span',{className:'dif-row-meta'},moveLabel(item))),glyph('chevron')))),
           !activeItem&&block&&inspector,
           !items.length&&!block&&h('p',{className:'dif-empty-notes'},t('emptyNotes')))),
(state.error||notice)&&h('div',{className:'dif-status',role:state.error?'alert':'status','data-error':!!state.error},h('span',null,state.error||notice),state.error&&button('retrySave',()=>act(()=>c.flush())),state.error&&button('reload',()=>setConfirmation({kind:'reload',run:()=>act(()=>c.load({discard:true}))})),!state.error&&button('dismiss',()=>setNotice(''),{icon:'close',iconOnly:true})),
      draft&&h('footer',{className:'dif-footer'},h('div',{className:'dif-summary'},h('strong',null,`${items.length} ${t('itemCount')} · ${moves.length} ${t('changes')}`),h('span',null,t('sendIncludes'))),h('div',{className:'dif-footer-actions'},button('fill',()=>{try{fill();}catch(e){error(e);}},{className:'dif-secondary',title:t('fillTextOnly'),disabled:!core.hasFeedback(draft)}),button(state.sending?'sending':'send',()=>act(()=>c.runSubmission(send)),{icon:'send',className:'dif-primary',title:t('sendIncludes'),'aria-busy':state.sending,disabled:!state.ready||!core.hasFeedback(draft)})))
    );
  };
}

function createEditor({React,ctx,NS,Icon}) {
  const EDITOR_NS=NS+'Editor';
  ctx.effect(()=>ctx.locale.register(EDITOR_NS,MESSAGES));
  const controllers=new Map(),lifetime=new AbortController(),grants=new Map();
  ctx.effect(()=>()=>{for(const c of controllers.values()){settleFeedbackText(core,c);c.dispose();}lifetime.abort();controllers.clear();});
  async function rpc(sessionId,payload,retryAuthorization=true) {
    let grant=grants.get(sessionId);
    if(!grant||grant.expiresAt<Date.now()+30000){
      const response=await fetch('/api/image-feedback/authorize?sessionId='+encodeURIComponent(sessionId),{credentials:'same-origin',signal:lifetime.signal,cache:'no-store'});
      grant=await response.json();if(!response.ok)throw new Error(grant.error||'Owner authentication required');grants.set(sessionId,grant);
    }
    if(payload.action==='submit'&&grant.reviewLabels!=='unified-v1')throw new Error(ctx.locale.bind(EDITOR_NS)('hostUpdate'));
    if(!ctx.sessions.scope(sessionId))throw new Error('Session is no longer retained');
    // Background imports and autosaves are private panel operations, not chat commands.
    // No command fallback: an older Host must report failure rather than resume log spam.
    const response=await fetch('/api/image-feedback/operations',{method:'POST',credentials:'same-origin',cache:'no-store',signal:lifetime.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,sessionId,authorization:grant.authorization})});
    let result;try{result=await response.json();}catch{throw new Error('Image Feedback background API is unavailable. Restart Harness to load the updated Host plugin.');}
    if(!response.ok&&result?.ok!==false)throw new Error('Image Feedback background operation failed ('+response.status+').');
    if(!result.ok&&result.error?.code==='OWNER_AUTH_REQUIRED'&&retryAuthorization){grants.delete(sessionId);return rpc(sessionId,payload,false);}
    if(!result.ok)throw new Error(typeof result.error==='string'?result.error:result.error?.message||result.message||'Host rejected the operation');
    return result;
  }
  function controller(sessionId) {
    if(controllers.has(sessionId))return controllers.get(sessionId);
    const key='dsh.image-feedback.recovery.v1.'+sessionId;
    const api=createSessionState({sessionId,core,rpc:payload=>rpc(sessionId,payload),recovery:{
      read:()=>{const value=localStorage.getItem(key);return value?JSON.parse(value):null;},
      write:value=>localStorage.setItem(key,JSON.stringify(value)),clear:()=>localStorage.removeItem(key)
    }});controllers.set(sessionId,api);return api;
  }
  function readFile(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file);});}
  function loadImage(url){return new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('Image read failed'));image.src=url;});}
  function targetPoint(draft,note){
    const a=note.target;if(a.kind==='global')return null;if(a.kind==='point')return a.point;if(a.kind==='region')return {x:a.rect.x,y:a.rect.y};
    const block=draft.blocks.find(b=>b.id===a.blockId);if(!block)return null;
    const local=a.local?.kind==='point'?a.local.point:a.local?.kind==='region'?a.local.rect:{x:0,y:0};
    return {x:block.destination.x+local.x,y:block.destination.y+local.y};
  }
  async function renderReference(draft,asset) {
    const image=await loadImage(asset.url),canvas=document.createElement('canvas');canvas.width=draft.asset.width;canvas.height=draft.asset.height;
    const draw=canvas.getContext('2d');if(!draw)throw new Error('Canvas unavailable');draw.drawImage(image,0,0,canvas.width,canvas.height);
    // Exported evidence has a fixed, readable palette; changing the UI theme must not change its identity.
    const neutral='#f3f4f6',accent='#dc2626',label='#ffffff';
    for(const block of draft.blocks){const s=block.source;draw.clearRect(s.x,s.y,s.width,s.height);draw.fillStyle=neutral;draw.fillRect(s.x,s.y,s.width,s.height);}
    for(const block of [...draft.blocks].sort((a,b)=>a.zIndex-b.zIndex)){const s=block.source,d=block.destination;draw.drawImage(image,s.x,s.y,s.width,s.height,d.x,d.y,d.width,d.height);}
    const radius=Math.max(10,Math.min(canvas.width,canvas.height)/60);draw.lineWidth=Math.max(2,radius/5);draw.strokeStyle=accent;draw.font=`bold ${radius*1.1}px sans-serif`;draw.textAlign='center';draw.textBaseline='middle';
    for(const item of core.getReviewItems(draft)){
      const anchor=item.layout;if(!anchor)continue;
      const p=anchor.kind==='point'?anchor.point:anchor.rect;
      if(anchor.kind==='region'){const r=anchor.rect;draw.strokeRect(r.x,r.y,r.width,r.height);}
      const x=Math.max(radius,Math.min(canvas.width-radius,p.x)),y=Math.max(radius,Math.min(canvas.height-radius,p.y));
      draw.beginPath();draw.arc(x,y,radius,0,Math.PI*2);draw.fillStyle=accent;draw.fill();draw.fillStyle=label;draw.fillText(String(item.number),x,y);
    }
    return new Promise((resolve,reject)=>canvas.toBlob(async blob=>{try{if(!blob)throw new Error('Reference image encoding failed');const data=await readFile(blob);canvas.width=canvas.height=0;resolve(data);}catch(error){canvas.width=canvas.height=0;reject(error);}},'image/png'));
  }
  return createEditorView({React,ctx,EDITOR_NS,Icon,controller,rpc,readFile,targetPoint,renderReference});
}

return {createEditor};
}});
