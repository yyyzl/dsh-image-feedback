import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import Core, {
  SCHEMA_VERSION, LIMITS, CoreError, createDraft, validateDraft, serializeDraft, deserializeDraft,
  rectanglesOverlap, containsPoint, rectFromPoints, viewToAsset, assetToView, subtractRect, getSourceRemainders,
  addBlock, moveBlock, resetBlock, resetAllMoves, reorderBlock, removeBlock, splitBlock, cutBlock, hitTest,
  addAnnotation, updateAnnotation, removeAnnotation, resolveAnnotation, getMoves, hasFeedback, buildFeedback, History,
} from '../editor-core.js';

const rect = (x, y, width, height) => ({ x, y, width, height });
const point = (x, y) => ({ x, y });
const asset = { assetId: 'asset-1', attachmentId: `sha256:${'a'.repeat(64)}`, sourceEventId: 'event-1', width: 200, height: 100 };
const empty = () => createDraft({ sessionId: 'session-1', asset });
const block = (draft = empty(), source = rect(10, 10, 30, 20), id = 'a') => addBlock(draft, source, { id });
const annotation = (draft, id, target, text = 'comment') => addAnnotation(draft, { id, text, target });
const layoutPoint = (x, y) => ({ kind: 'point', space: 'layout', point: point(x, y) });
const layoutRegion = (r) => ({ kind: 'region', space: 'layout', rect: r });
const component = (blockId, local) => local ? ({ kind: 'block', blockId, local }) : ({ kind: 'block', blockId });
const clone = (draft) => JSON.parse(JSON.stringify(draft));
const code = (expected) => (error) => error instanceof CoreError && error.code === expected;
const area = (regions) => regions.reduce((total, r) => total + r.width * r.height, 0);
const disjoint = (regions) => {
  for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) {
    assert.equal(rectanglesOverlap(regions[i], regions[j]), false, `overlap at ${i}, ${j}`);
  }
};

test('fresh drafts bind immutable normalized source identity and dimensions', () => {
  const input = { sessionId: 'session-1', asset: { ...asset } };
  const draft = createDraft(input);
  input.asset.width = 999;
  assert.equal(draft.schemaVersion, SCHEMA_VERSION);
  assert.equal(draft.asset.width, 200);
  assert.equal(draft.asset.coordinateSpace, 'asset-pixels');
  assert.equal(draft.revision, 0);
  assert.equal(draft.nextAnnotationNumber, 1);
  assert.ok(Object.isFrozen(draft));
  assert.ok(Object.isFrozen(draft.asset));
  assert.ok(Object.isFrozen(draft.blocks));
  assert.throws(() => { draft.asset.width = 999; }, TypeError);
  assert.throws(() => { draft.sessionId = 'another'; }, TypeError);
  assert.equal(validateDraft(draft), draft);
  assert.equal(Object.isFrozen(Core), true);
});

test('invalid dimensions, asset metadata and fake attachment IDs are rejected', () => {
  for (const width of [NaN, Infinity, -Infinity, 0, -1, 10.1, '200', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createDraft({ sessionId: 'session-1', asset: { ...asset, width } }), code('INVALID_NUMBER'));
  }
  assert.throws(() => createDraft({ sessionId: '', asset }), code('INVALID_DRAFT'));
  assert.throws(() => createDraft({ sessionId: 'ok', asset: { ...asset, attachmentId: 'draft-local-id' } }), code('INVALID_DRAFT'));
  assert.throws(() => createDraft({ sessionId: 'ok', asset: { ...asset, path: 'G:/private/image.png' } }), code('INVALID_DRAFT'));
  assert.throws(() => createDraft({ sessionId: 'ok', asset: { ...asset, coordinateSpace: 'css-pixels' } }), code('INVALID_DRAFT'));
  assert.throws(() => createDraft({ sessionId: 'ok', asset: { ...asset, coordinateSpace: null } }), code('INVALID_DRAFT'));
});

test('rectangles reject nonfinite/coerced coordinates, zero area and out-of-bounds cuts', () => {
  for (const bad of [NaN, Infinity, -Infinity, '1', null, undefined]) {
    assert.throws(() => block(empty(), rect(bad, 0, 10, 10)), code('INVALID_NUMBER'));
    assert.throws(() => block(empty(), rect(0, 0, bad, 10)), code('INVALID_NUMBER'));
  }
  for (const bad of [rect(0, 0, 0, 10), rect(0, 0, 10, -1)]) {
    assert.throws(() => block(empty(), bad), code('INVALID_RECT'));
  }
  for (const bad of [rect(-1, 0, 10, 10), rect(0, -1, 10, 10), rect(199, 0, 2, 2), rect(0, 99, 2, 2)]) {
    assert.throws(() => block(empty(), bad), code('OUT_OF_BOUNDS'));
  }
  assert.throws(() => rectanglesOverlap(rect(Number.MAX_VALUE, 0, Number.MAX_VALUE, 1), rect(0, 0, 1, 1)), code('INVALID_RECT'));
  const normalized = block(empty(), rect(-0, -0, 0.5, 0.25));
  assert.equal(Object.is(normalized.blocks[0].source.x, -0), false);
});

test('source overlap is rejected, but touching edges and destination overlap are legal', () => {
  const original = block();
  assert.throws(() => addBlock(original, rect(20, 15, 3, 3)), code('SOURCE_OVERLAP'));
  assert.throws(() => addBlock(original, rect(0, 0, 100, 80)), code('SOURCE_OVERLAP'));
  let draft = block(original, rect(40, 10, 30, 20), 'b');
  assert.equal(draft.blocks.length, 2);
  draft = moveBlock(draft, 'b', point(10, 10));
  assert.equal(hitTest(draft, point(15, 15)).id, 'b');
  assert.equal(original.blocks.length, 1);
  assert.throws(() => block(draft, rect(100, 0, 10, 10), 'a'), code('INVALID_DRAFT'));
});

test('repeated absolute moves retain the identical source and unchanged metadata', () => {
  const initial = block();
  const source = initial.blocks[0].source;
  let draft = initial;
  for (let i = 0; i < 50; i++) draft = moveBlock(draft, 'a', point(50 + i / 2, 30 + i / 4));
  assert.equal(draft.blocks[0].source, source);
  assert.equal(draft.asset, initial.asset);
  assert.equal(draft.annotations, initial.annotations);
  assert.deepEqual(draft.blocks[0].source, rect(10, 10, 30, 20));
  assert.deepEqual(draft.blocks[0].destination, rect(74.5, 42.25, 30, 20));
  assert.deepEqual(getMoves(draft)[0].delta, point(64.5, 32.25));
  assert.deepEqual(initial.blocks[0].destination, source);
  assert.equal(moveBlock(draft, 'a', point(74.5, 42.25)), draft);
  assert.throws(() => moveBlock(draft, 'a', { x: 80, y: 40, width: 4, height: 4 }), code('INVALID_DRAFT'));
});

test('fixed-canvas moves reject by default; explicit clamp preserves size', () => {
  const draft = block();
  assert.throws(() => moveBlock(draft, 'a', point(-1, 0)), code('OUT_OF_BOUNDS'));
  assert.throws(() => moveBlock(draft, 'a', point(171, 80)), code('OUT_OF_BOUNDS'));
  assert.throws(() => moveBlock(draft, 'a', point(0, Infinity), { bounds: 'clamp' }), code('INVALID_NUMBER'));
  assert.throws(() => moveBlock(draft, 'a', point(0, 0), { bounds: 'whatever' }), code('INVALID_DRAFT'));
  const clamped = moveBlock(draft, 'a', point(-999, 999), { bounds: 'clamp' });
  assert.deepEqual(clamped.blocks[0].destination, rect(0, 80, 30, 20));
  assert.deepEqual(clamped.blocks[0].source, rect(10, 10, 30, 20));
  const full = block(empty(), rect(0, 0, 200, 100));
  assert.equal(moveBlock(full, 'a', point(99, 99), { bounds: 'clamp' }), full);
  assert.throws(() => moveBlock(full, 'missing', point(0, 0)), code('MISSING_BLOCK'));
});

test('layer order and half-open hit tests are deterministic after overlapping moves', () => {
  let draft = block(block(empty(), rect(0, 0, 20, 20), 'a'), rect(30, 0, 20, 20), 'b');
  draft = moveBlock(draft, 'b', point(0, 0));
  assert.equal(hitTest(draft, point(5, 5)).id, 'b');
  assert.equal(hitTest(draft, point(20, 10)), null);
  assert.equal(hitTest(draft, point(-1, 5)), null);
  assert.equal(hitTest(draft, point(200, 100)), null);
  const reordered = reorderBlock(draft, 'a', 'front');
  assert.equal(hitTest(reordered, point(5, 5)).id, 'a');
  assert.deepEqual(reordered.blocks.map((item) => item.zIndex), [0, 1]);
  assert.equal(reorderBlock(reordered, 'a', 1), reordered);
  assert.equal(hitTest(reorderBlock(reordered, 'a', 'back'), point(5, 5)).id, 'b');
  assert.throws(() => reorderBlock(reordered, 'a', 2), code('OUT_OF_BOUNDS'));
  assert.equal(containsPoint(rect(0, 0, 10, 10), point(0, 0)), true);
  assert.equal(containsPoint(rect(0, 0, 10, 10), point(10, 0)), false);
});

test('split creates disjoint source children and preserves the moved layout offset', () => {
  const parent = moveBlock(block(), 'a', point(70, 40));
  const draft = splitBlock(parent, 'a', { axis: 'x', at: 10 });
  assert.equal(draft.blocks.length, 2);
  assert.ok(draft.blocks.every((item) => item.id !== 'a'));
  assert.deepEqual(draft.blocks.map((item) => item.source), [rect(10, 10, 10, 20), rect(20, 10, 20, 20)]);
  assert.deepEqual(draft.blocks.map((item) => item.destination), [rect(70, 40, 10, 20), rect(80, 40, 20, 20)]);
  assert.deepEqual(draft.blocks.map((item) => item.zIndex), [0, 1]);
  disjoint(draft.blocks.map((item) => item.source));
  assert.equal(area(draft.blocks.map((item) => item.source)), area([parent.blocks[0].source]));
  const vertical = splitBlock(parent, 'a', { axis: 'y', at: 5.5 });
  assert.deepEqual(vertical.blocks.map((item) => item.source), [rect(10, 10, 30, 5.5), rect(10, 15.5, 30, 14.5)]);
  assert.deepEqual(parent.blocks.map((item) => item.id), ['a']);
  for (const at of [0, 30, -1, 31]) assert.throws(() => splitBlock(parent, 'a', { axis: 'x', at }), code('OUT_OF_BOUNDS'));
  assert.throws(() => splitBlock(parent, 'a', { axis: 'x', at: NaN }), code('INVALID_NUMBER'));
  assert.throws(() => splitBlock(parent, 'a', { axis: 'z', at: 1 }), code('INVALID_DRAFT'));
});

test('an inner rectangle cut partitions pixels instead of duplicating them', () => {
  const parent = moveBlock(block(empty(), rect(10, 10, 60, 40)), 'a', point(100, 50));
  const draft = cutBlock(parent, 'a', rect(10, 5, 20, 10));
  assert.equal(draft.blocks.length, 5);
  const selected = draft.blocks.at(-1);
  assert.deepEqual(selected.source, rect(20, 15, 20, 10));
  assert.deepEqual(selected.destination, rect(110, 55, 20, 10));
  assert.equal(area(draft.blocks.map((item) => item.source)), 60 * 40);
  disjoint(draft.blocks.map((item) => item.source));
  for (const item of draft.blocks) {
    assert.equal(item.destination.x - item.source.x, 90);
    assert.equal(item.destination.y - item.source.y, 40);
  }
  assert.equal(cutBlock(parent, 'a', rect(0, 0, 60, 40)), parent);
  assert.throws(() => cutBlock(parent, 'a', rect(59, 0, 2, 2)), code('OUT_OF_BOUNDS'));
  const movedChild = moveBlock(draft, selected.id, point(0, 0));
  assert.equal(movedChild.blocks.at(-1).source, selected.source);
});

test('source remainder rendering creates real holes with exact disjoint coverage', () => {
  let draft = block(empty(), rect(10, 10, 30, 20), 'a');
  draft = block(draft, rect(50, 20, 40, 30), 'b');
  draft = moveBlock(draft, 'a', point(150, 60));
  const remaining = getSourceRemainders(draft);
  disjoint(remaining);
  disjoint([...remaining, ...draft.blocks.map((item) => item.source)]);
  assert.equal(area(remaining) + area(draft.blocks.map((item) => item.source)), 200 * 100);
  assert.equal(remaining.some((r) => containsPoint(r, point(15, 15))), false);
  assert.equal(remaining.some((r) => containsPoint(r, point(0, 0))), true);
  assert.deepEqual(getSourceRemainders(block(empty(), rect(0, 0, 200, 100))), []);
  assert.deepEqual(subtractRect(rect(0, 0, 10, 10), rect(20, 20, 3, 3)), [rect(0, 0, 10, 10)]);
  assert.deepEqual(subtractRect(rect(0, 0, 10, 10), rect(-2, -2, 20, 20)), []);
  assert.deepEqual(subtractRect(rect(0, 0, 10, 10), rect(10, 0, 5, 5)), [rect(0, 0, 10, 10)]);
});

test('deterministic grid cuts conserve all source pixels', () => {
  let draft = empty();
  for (let y = 0; y < 100; y += 10) for (let x = 0; x < 200; x += 10) {
    draft = addBlock(draft, rect(x, y, 10, 10));
  }
  assert.equal(draft.blocks.length, 200);
  assert.equal(new Set(draft.blocks.map((item) => item.id)).size, 200);
  assert.deepEqual(getSourceRemainders(draft), []);
  disjoint(draft.blocks.map((item) => item.source));
  assert.equal(area(draft.blocks.map((item) => item.source)), 20000);
  assert.deepEqual(deserializeDraft(serializeDraft(draft)), draft);
});

test('free layout annotations remain fixed when pixels beneath them are cut and moved', () => {
  let draft = annotation(empty(), 'p', layoutPoint(15, 15), 'position');
  draft = annotation(draft, 'r', layoutRegion(rect(0, 0, 100, 50)), 'cross-block region');
  const initialAnnotations = draft.annotations;
  draft = block(draft);
  draft = moveBlock(draft, 'a', point(100, 50));
  assert.equal(draft.annotations, initialAnnotations);
  assert.deepEqual(resolveAnnotation(draft, 'p').layout, { kind: 'point', point: point(15, 15) });
  assert.equal(resolveAnnotation(draft, 'p').source, null);
  assert.deepEqual(resolveAnnotation(draft, 'r').layout, { kind: 'region', rect: rect(0, 0, 100, 50) });
  assert.equal(resolveAnnotation(draft, 'r').source, null);
});

test('block-local point/region and whole-block anchors track destination but retain source', () => {
  let draft = block();
  draft = annotation(draft, 'p', component('a', { kind: 'point', point: point(5, 6) }));
  draft = annotation(draft, 'r', component('a', { kind: 'region', rect: rect(1, 2, 10, 8) }));
  draft = annotation(draft, 'whole', component('a'));
  draft = annotation(draft, 'g', { kind: 'global' }, 'overall');
  draft = moveBlock(draft, 'a', point(80, 60));
  assert.deepEqual(resolveAnnotation(draft, 'p').source, { kind: 'point', point: point(15, 16) });
  assert.deepEqual(resolveAnnotation(draft, 'p').layout, { kind: 'point', point: point(85, 66) });
  assert.deepEqual(resolveAnnotation(draft, 'r').source, { kind: 'region', rect: rect(11, 12, 10, 8) });
  assert.deepEqual(resolveAnnotation(draft, 'r').layout, { kind: 'region', rect: rect(81, 62, 10, 8) });
  assert.deepEqual(resolveAnnotation(draft, 'whole').layout, { kind: 'region', rect: rect(80, 60, 30, 20) });
  assert.equal(resolveAnnotation(draft, 'g').source, null);
  assert.equal(resolveAnnotation(draft, 'g').layout, null);
});

test('invalid anchor spaces, missing blocks and bad local coordinates are rejected', () => {
  const draft = block();
  for (const target of [
    { kind: 'point', point: point(5, 5) },
    { kind: 'point', space: 'source', point: point(5, 5) },
    { kind: 'global', blockId: 'a' },
    component('a', { kind: 'global' }),
  ]) assert.throws(() => annotation(draft, 'bad', target), code('INVALID_DRAFT'));
  assert.throws(() => annotation(draft, 'bad', component('missing')), code('MISSING_BLOCK'));
  assert.throws(() => annotation(draft, 'bad', component('a', { kind: 'point', point: point(31, 0) })), code('OUT_OF_BOUNDS'));
  assert.throws(() => annotation(draft, 'bad', component('a', { kind: 'region', rect: rect(20, 10, 11, 5) })), code('OUT_OF_BOUNDS'));
  assert.throws(() => annotation(draft, 'bad', layoutPoint(201, 0)), code('OUT_OF_BOUNDS'));
  assert.throws(() => annotation(draft, 'bad', layoutPoint(NaN, 0)), code('INVALID_NUMBER'));
  assert.doesNotThrow(() => annotation(draft, 'edge', layoutPoint(200, 100)));
});

test('numbering survives edits, removals, serialization and explicit rebindings', () => {
  let draft = annotation(block(), 'one', { kind: 'global' }, 'one');
  draft = annotation(draft, 'two', layoutPoint(12, 13), 'two');
  const stableNumber = draft.annotations[1].number;
  draft = removeAnnotation(draft, 'one');
  draft = updateAnnotation(draft, 'two', { text: 'updated', target: component('a', { kind: 'point', point: point(2, 3) }) });
  assert.equal(draft.annotations[0].number, stableNumber);
  draft = removeAnnotation(draft, 'two');
  draft = deserializeDraft(serializeDraft(draft));
  draft = annotation(draft, 'three', { kind: 'global' });
  assert.equal(draft.annotations[0].number, 3);
  assert.equal(updateAnnotation(draft, 'three', { text: 'comment' }), draft);
  assert.throws(() => updateAnnotation(draft, 'three', { number: 42 }), code('INVALID_DRAFT'));
  assert.throws(() => removeAnnotation(draft, 'missing'), code('MISSING_ANNOTATION'));
});

test('resetting one/all moves preserves comments, local binding, numbers and z order', () => {
  let draft = block(block(), rect(100, 0, 20, 20), 'b');
  draft = annotation(draft, 'note', component('a'), 'keep me');
  draft = annotation(draft, 'global', { kind: 'global' }, 'keep me too');
  draft = moveBlock(moveBlock(draft, 'a', point(70, 60)), 'b', point(0, 70));
  const notes = draft.annotations;
  const oneReset = resetBlock(draft, 'a');
  assert.equal(oneReset.annotations, notes);
  assert.equal(getMoves(oneReset).length, 1);
  assert.equal(getMoves(oneReset)[0].blockId, 'b');
  const allReset = resetAllMoves(oneReset);
  assert.equal(allReset.annotations, notes);
  assert.equal(getMoves(allReset).length, 0);
  assert.equal(resetAllMoves(allReset), allReset);
  assert.deepEqual(allReset.blocks.map((item) => item.id), ['a', 'b']);
});

test('removal and re-splitting never silently orphan or retarget component comments', () => {
  let draft = annotation(block(), 'component', component('a'));
  draft = annotation(draft, 'position', layoutPoint(15, 15));
  assert.throws(() => removeBlock(draft, 'a'), code('ANNOTATIONS_ATTACHED'));
  assert.throws(() => splitBlock(draft, 'a', { axis: 'x', at: 5 }), code('ANNOTATIONS_ATTACHED'));
  assert.throws(() => cutBlock(draft, 'a', rect(5, 5, 10, 10)), code('ANNOTATIONS_ATTACHED'));
  assert.equal(cutBlock(draft, 'a', rect(0, 0, 30, 20)), draft);
  const removed = removeBlock(draft, 'a', { annotationPolicy: 'remove' });
  assert.deepEqual(removed.blocks, []);
  assert.deepEqual(removed.annotations.map((item) => item.id), ['position']);
  assert.deepEqual(getSourceRemainders(removed), [rect(0, 0, 200, 100)]);
  const split = splitBlock(draft, 'a', { axis: 'x', at: 5 }, { annotationPolicy: 'remove' });
  assert.deepEqual(split.annotations.map((item) => item.id), ['position']);
  assert.equal(split.blocks.length, 2);
  assert.doesNotThrow(() => deserializeDraft(serializeDraft(split)));
  assert.throws(() => removeBlock(draft, 'a', { annotationPolicy: 'guess' }), code('INVALID_DRAFT'));
});

test('history undo/redo restores comments and blocks as exact frozen snapshots', () => {
  const initial = block(); const history = new History(initial);
  const commented = history.commit((draft) => annotation(draft, 'note', component('a'), 'stay attached'));
  const movedDraft = history.commit((draft) => moveBlock(draft, 'a', point(80, 60)));
  assert.equal(history.version, 2);
  const reset = history.commit((draft) => resetBlock(draft, 'a'));
  assert.equal(reset.annotations, commented.annotations);
  assert.equal(history.undo(), movedDraft);
  assert.equal(history.undo(), commented);
  assert.equal(history.redo(), movedDraft);
  assert.equal(history.redo(), reset);
  assert.equal(history.redo(), reset);
  assert.equal(history.version, 7);
  assert.equal(history.undoCount, 3);
  assert.equal(history.redoCount, 0);
  assert.equal(history.current.annotations[0].text, 'stay attached');
  assert.equal(history.current.blocks[0].source, initial.blocks[0].source);
});

test('one pointer-up commit groups many previews; cancellation/no-op creates no history', () => {
  const original = block(); const history = new History(original);
  let preview = original;
  for (let i = 0; i < 50; i++) preview = moveBlock(preview, 'a', point(50 + i, 40));
  assert.equal(history.current, original);
  assert.equal(history.undoCount, 0);
  history.commit(preview);
  assert.equal(history.undoCount, 1);
  assert.equal(history.undo(), original);
  assert.equal(history.redo(), preview);
  history.commit((draft) => moveBlock(draft, 'a', point(99, 40)));
  assert.equal(history.undoCount, 1);
  history.undo();
  history.commit((draft) => annotation(draft, 'branch', { kind: 'global' }, 'new branch'));
  assert.equal(history.canRedo, false);
  assert.equal(history.current.annotations[0].text, 'new branch');
});

test('history limits snapshots, rejects identity/source replacement, restores removed annotations', () => {
  const history = new History(block(), { limit: 2 });
  history.commit((draft) => annotation(draft, 'note', component('a')));
  const withComment = history.current;
  history.commit((draft) => removeBlock(draft, 'a', { annotationPolicy: 'remove' }));
  assert.equal(history.current.annotations.length, 0);
  assert.equal(history.undo(), withComment);
  assert.equal(history.redo().blocks.length, 0);
  history.commit((draft) => annotation(draft, 'g', { kind: 'global' }));
  assert.equal(history.undoCount, 2);
  assert.throws(() => history.commit(createDraft({ sessionId: 'other', asset })), code('IDENTITY_MISMATCH'));
  assert.throws(() => history.commit(createDraft({ sessionId: 'session-1', asset: { ...asset, width: 201 } })), code('IDENTITY_MISMATCH'));
  const sameId = new History(block());
  const forged = clone(sameId.current); forged.blocks[0].source.x = 11; forged.blocks[0].destination.x = 11;
  assert.throws(() => sameId.commit(forged), code('IDENTITY_MISMATCH'));
  assert.equal(sameId.undoCount, 0);
  history.clear();
  assert.equal(history.canUndo, false); assert.equal(history.canRedo, false);
  assert.throws(() => new History(empty(), { limit: 0 }), code('INVALID_NUMBER'));
  assert.throws(() => new History(empty(), { limit: 1001 }), code('LIMIT_EXCEEDED'));
});

test('coordinate transforms roundtrip screen positions without DPR/resize leakage', () => {
  const source = point(10.125, 20.25);
  for (const scale of [0.1, 0.25, 1, 2, 4]) {
    const transform = { scale, offsetX: -15.5, offsetY: 120.25 };
    const actual = viewToAsset(assetToView(source, transform), transform);
    assert.ok(Math.abs(actual.x - source.x) < 1e-10);
    assert.ok(Math.abs(actual.y - source.y) < 1e-10);
  }
  assert.deepEqual(rectFromPoints(point(100, 80), point(20, 5)), rect(20, 5, 80, 75));
  assert.throws(() => rectFromPoints(point(1, 1), point(1, 2)), code('INVALID_RECT'));
  for (const scale of [0, -1, NaN, Infinity, '2']) assert.throws(() => viewToAsset(source, { scale }), code('INVALID_NUMBER'));
  assert.throws(() => assetToView(point(Number.MAX_VALUE, 1), { scale: 2 }), code('INVALID_NUMBER'));
});

test('serialization validates and canonicalizes JSON, not references to mutable inputs', () => {
  let draft = annotation(block(), 'note', component('a'), 'Unicode 评论\n"quotes" `fence`');
  draft = moveBlock(draft, 'a', point(100, 60));
  const json = serializeDraft(draft);
  const restored = deserializeDraft(json, { sessionId: 'session-1', asset: { assetId: 'asset-1', width: 200, height: 100 } });
  assert.deepEqual(restored, draft);
  assert.equal(serializeDraft(restored), json);
  assert.equal(Object.isFrozen(restored.annotations[0].target), true);
  const raw = clone(draft); const safe = validateDraft(raw); raw.blocks[0].source.x = 999;
  assert.equal(safe.blocks[0].source.x, 10);
  assert.throws(() => deserializeDraft(json, { sessionId: 'wrong' }), code('IDENTITY_MISMATCH'));
  assert.throws(() => deserializeDraft(json, { asset: { attachmentId: `sha256:${'b'.repeat(64)}` } }), code('IDENTITY_MISMATCH'));
  assert.throws(() => deserializeDraft('not json'), code('INVALID_DRAFT'));
  assert.throws(() => deserializeDraft('null'), code('INVALID_DRAFT'));
  assert.throws(() => deserializeDraft(' '.repeat(LIMITS.serialized + 1)), code('LIMIT_EXCEEDED'));
  assert.throws(() => serializeDraft(draft, { pretty: 'yes' }), code('INVALID_DRAFT'));
  const legacy = clone(draft); delete legacy.nextAnnotationNumber;
  assert.equal(validateDraft(legacy).nextAnnotationNumber, 2);
});

test('serialization rejects malformed numbers, duplicate IDs/layers/numbers and dangling references', () => {
  let draft = annotation(block(block(), rect(100, 0, 20, 20), 'b'), 'n1', component('a'));
  draft = annotation(draft, 'n2', { kind: 'global' });
  const mutations = [
    [d => { d.schemaVersion = 'future'; }, 'INVALID_DRAFT'],
    [d => { d.revision = NaN; }, 'INVALID_NUMBER'],
    [d => { d.blocks[0].source.x = NaN; }, 'INVALID_NUMBER'],
    [d => { d.blocks[0].destination.width = 31; }, 'INVALID_RECT'],
    [d => { d.blocks[0].destination.x = 190; }, 'OUT_OF_BOUNDS'],
    [d => { d.blocks[1].source = rect(20, 10, 20, 20); }, 'SOURCE_OVERLAP'],
    [d => { d.blocks[1].id = 'a'; }, 'INVALID_DRAFT'],
    [d => { d.blocks[1].zIndex = 0; }, 'INVALID_DRAFT'],
    [d => { d.blocks[0].zIndex = -1; }, 'INVALID_NUMBER'],
    [d => { d.blocks[1].zIndex = 3; }, 'INVALID_DRAFT'],
    [d => { d.annotations[0].target.blockId = 'gone'; }, 'MISSING_BLOCK'],
    [d => { d.annotations[1].id = 'n1'; }, 'INVALID_DRAFT'],
    [d => { d.annotations[1].number = 1; }, 'INVALID_DRAFT'],
    [d => { d.annotations[1].number = 1.5; }, 'INVALID_NUMBER'],
    [d => { d.nextAnnotationNumber = 2; }, 'INVALID_DRAFT'],
    [d => { d.asset.data = 'data:image/png;base64,not-state'; }, 'INVALID_DRAFT'],
    [d => { d.viewport = { dpr: 2 }; }, 'INVALID_DRAFT'],
  ];
  for (const [mutate, expected] of mutations) {
    const value = clone(draft); mutate(value);
    assert.throws(() => validateDraft(value), code(expected));
  }
  const shuffled = clone(draft); shuffled.blocks.reverse(); shuffled.annotations.reverse();
  assert.equal(serializeDraft(shuffled), serializeDraft(draft));
});

test('unknown/prototype/accessor fields and oversized input fail without retaining data', () => {
  const raw = clone(empty());
  Object.defineProperty(raw, 'sessionId', { get() { throw new Error('getter should never run'); }, enumerable: true });
  assert.throws(() => validateDraft(raw), code('INVALID_DRAFT'));
  assert.throws(() => deserializeDraft(serializeDraft(empty()).replace('"revision":0', '"__proto__":{},"revision":0')), code('INVALID_DRAFT'));
  assert.throws(() => validateDraft(Object.assign(Object.create({ inherited: true }), clone(empty()))), code('INVALID_DRAFT'));
  assert.throws(() => annotation(empty(), 'long', { kind: 'global' }, 'x'.repeat(LIMITS.text + 1)), code('LIMIT_EXCEEDED'));
  const excess = clone(empty()); excess.blocks = new Array(LIMITS.blocks + 1).fill(null);
  assert.throws(() => validateDraft(excess), code('LIMIT_EXCEEDED'));
  assert.equal({}.polluted, undefined);
});

test('feedback preserves real uncommented moves, full metadata and deterministic text+JSON', () => {
  const draft = moveBlock(block(), 'a', point(100, 60));
  const feedback = buildFeedback(draft);
  assert.equal(hasFeedback(draft), true);
  assert.equal(hasFeedback(block()), false);
  assert.equal(feedback.moves.length, 1);
  assert.match(feedback.text, /Moves \(1\)/u);
  assert.match(feedback.text, /source \(10, 10, 30, 20\) -> destination \(100, 60, 30, 20\)/u);
  assert.match(feedback.text, /No text comments; retain every move/u);
  assert.match(feedback.text, /cut out, not copied/u);
  assert.equal(feedback.text, buildFeedback(draft).text);
  assert.deepEqual(deserializeDraft(feedback.json), draft);
  assert.equal(feedback.text.split('```json\n')[1].split('\n```')[0], feedback.json);
  assert.equal(feedback.json.includes('data:'), false);
  assert.equal(feedback.json.includes('blob:'), false);
});

test('feedback explains global, fixed layout, block source/local layout and empty comments', () => {
  let draft = moveBlock(block(), 'a', point(100, 60));
  draft = annotation(draft, 'position', layoutPoint(15, 15), 'Keep this position');
  draft = annotation(draft, 'local', component('a', { kind: 'point', point: point(5, 5) }), 'Follow block');
  draft = annotation(draft, 'global', { kind: 'global' }, '整体意见\nnext line');
  draft = annotation(draft, 'empty', { kind: 'global' }, '');
  const feedback = buildFeedback(draft);
  assert.match(feedback.text, /#1 \[fixed layout point \(15, 15\) \(not an original-image anchor\)\]/u);
  assert.match(feedback.text, /#2 \[block "a", source point \(15, 15\), layout point \(105, 65\)\]/u);
  assert.match(feedback.text, /#3 \[global\]: "整体意见\\nnext line"/u);
  assert.match(feedback.text, /#4 \[global\]: ""/u);
  assert.equal(hasFeedback(annotation(empty(), 'blank', { kind: 'global' }, '  \n')), false);
  assert.equal(hasFeedback(annotation(empty(), 'text', { kind: 'global' }, 'do something')), true);
});

test('browser lazy factory can consume the standalone ESM without imports or bundler', async () => {
  const source = await readFile(new URL('../editor-core.js', import.meta.url), 'utf8');
  const transformed = source.replace(/^export (?=(?:const|function|class)\b)/gmu, '').replace(/^export default API;$/mu, 'return API;');
  const scope = vm.createContext({});
  const factory = vm.runInContext(`(function () { 'use strict';\n${transformed}\n})`, scope, { timeout: 1000 });
  const api = factory();
  // Build in the same realm: validation intentionally accepts only plain records.
  scope.api = api;
  const serialized = vm.runInContext(`api.serializeDraft(api.createDraft({sessionId:'s',asset:{assetId:'a',width:10,height:10}}))`, scope);
  assert.equal(JSON.parse(serialized).asset.width, 10);
  assert.deepEqual(Object.keys(api).sort(), Object.keys(Core).sort());
});
