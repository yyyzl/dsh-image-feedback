import test from 'node:test';
import assert from 'node:assert/strict';
import core from '../editor-core.js';
import { createSessionState } from '../src/session-state.js';

// Test the pure injected state machine, not a React/DOM or visual-acceptance mock.
// Every async interleaving uses a deferred gate; long timers are always disposed.
const SESSION = 'session-test';
const LONG_DELAY = 1_000_000_000;
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const A = { assetId: 'asset-a', attachmentId: `sha256:${'a'.repeat(64)}`, width: 200, height: 100 };
const B = { assetId: 'asset-b', attachmentId: `sha256:${'b'.repeat(64)}`, width: 200, height: 100 };
const draftFor = asset => core.createDraft({ sessionId: SESSION, asset });
const note = (draft, text) => core.addAnnotation(draft, { text, target: { kind: 'global' } });
const checkpoint = (draft, version, submission = null) => ({ schema: 1, version, draft, submission });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function memoryRecovery(initial = null) {
  let value = clone(initial);
  const store = {
    writes: [], clears: 0, failWrite: false,
    read: () => clone(value),
    write(next) {
      if (store.failWrite) throw new Error('storage quota');
      value = clone(next); store.writes.push(clone(next));
    },
    clear() { value = null; store.clears++; },
    peek: () => clone(value),
  };
  return store;
}

function memoryHost(initial = draftFor(A), version = 1) {
  const documents = new Map();
  const assets = new Map([[A.assetId, A], [B.assetId, B]]);
  const holds = [];
  let currentId = initial?.asset.assetId ?? null;
  if (initial) documents.set(currentId, { draft: clone(initial), version });
  const host = {
    calls: [],
    put(draft, nextVersion, makeCurrent = true) {
      documents.set(draft.asset.assetId, { draft: clone(draft), version: nextVersion });
      assets.set(draft.asset.assetId, clone(draft.asset));
      if (makeCurrent) currentId = draft.asset.assetId;
    },
    document(id = currentId) { return clone(documents.get(id) ?? { draft: null, version: 0 }); },
    count(action, predicate = () => true) { return host.calls.filter(call => call.action === action && predicate(call)).length; },
    reply(request) {
      switch (request.action) {
        case 'loadDraft': return host.document(request.assetId ?? currentId);
        case 'read': {
          const asset = assets.get(request.assetId);
          if (!asset) throw new Error('ASSET_NOT_FOUND');
          return { asset: { ...clone(asset), url: `test-only:${asset.assetId}` } };
        }
        case 'saveDraft': {
          const id = request.draft.asset.assetId;
          const previous = host.document(id);
          if (request.expectedVersion !== previous.version) throw new Error('VERSION_CONFLICT');
          host.put(request.draft, previous.version + 1);
          return { version: previous.version + 1 };
        }
        default: throw new Error(`Unexpected RPC action ${request.action}`);
      }
    },
    hold(action, predicate = () => true) {
      const entered = deferred(), result = deferred();
      const gate = { action, predicate, entered: entered.promise, request: null,
        resolve: value => result.resolve(value), reject: error => result.reject(error),
        release: () => {
          assert.ok(gate.request, 'RPC must enter its gate before release');
          try { result.resolve(host.reply(gate.request)); } catch (error) { result.reject(error); }
        },
        mark: request => { gate.request = request; entered.resolve(request); }, result: result.promise };
      holds.push(gate);
      return gate;
    },
    async rpc(request) {
      host.calls.push(clone(request));
      const index = holds.findIndex(gate => gate.action === request.action && gate.predicate(request));
      if (index !== -1) {
        const [gate] = holds.splice(index, 1);
        gate.mark(request);
        return gate.result;
      }
      return host.reply(request);
    },
  };
  return host;
}

function fixture(t, options = {}) {
  const host = options.host ?? memoryHost(options.remote ?? draftFor(A), options.version ?? 1);
  const recovery = options.recovery ?? memoryRecovery(options.recovered ?? null);
  const state = createSessionState({ sessionId: SESSION, core, rpc: host.rpc, recovery, delay: LONG_DELAY });
  t.after(() => state.dispose());
  return { host, recovery, state };
}

const assertDraftEqual = (actual, expected) => assert.equal(core.serializeDraft(actual), core.serializeDraft(expected));

function stageText(state, text = '') {
  const staged = core.addAnnotation(state.getSnapshot().draft, { text: '', target: { kind: 'global' } });
  const id = staged.annotations.at(-1).id;
  state.beginTextEdit(id);
  state.previewText(staged);
  if (text) state.previewText(core.updateAnnotation(state.getSnapshot().draft, id, { text }));
  return id;
}

function previewText(state, id, text) {
  return state.previewText(core.updateAnnotation(state.getSnapshot().draft, id, { text }));
}

test('initial ensureLoaded is shared, and image adoption waits for that initial load', async t => {
  const { state, host } = fixture(t);
  const initial = host.hold('loadDraft', request => !request.assetId);
  const load = state.ensureLoaded();
  assert.equal(state.ensureLoaded(), load);
  const selecting = state.useAsset(B);
  await initial.entered;
  assert.equal(state.getSnapshot().ready, false);
  assert.equal(host.count('loadDraft'), 1);
  assert.equal(host.count('saveDraft'), 0);
  initial.release();
  await load;
  await selecting;
  const snapshot = state.getSnapshot();
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.draft.asset.assetId, B.assetId);
  assert.equal(snapshot.asset.assetId, B.assetId);
  assert.equal(snapshot.history.current, snapshot.draft);
  assert.equal(snapshot.status, 'saved');
  assert.equal(host.count('loadDraft', request => request.assetId === B.assetId), 1);
  assert.equal(host.document(B.assetId).version, 1);
});

test('completed loads release promise ownership and an explicit reload performs a fresh RPC', async t => {
  const { state, host } = fixture(t);
  await state.ensureLoaded();
  const firstHistory = state.getSnapshot().history;
  await state.load();
  assert.equal(host.count('loadDraft'), 2);
  assert.notEqual(state.getSnapshot().history, firstHistory);
  await state.ensureLoaded();
  assert.equal(host.count('loadDraft'), 2, 'ensureLoaded does not reload an already-ready document');
});

test('a slow reload result cannot replace a comment committed after the request started', async t => {
  const { state, host, recovery } = fixture(t);
  await state.ensureLoaded();
  const held = host.hold('loadDraft', request => !request.assetId);
  const reloading = state.load();
  await held.entered;
  const edited = note(state.getSnapshot().draft, 'newer local comment');
  const history = state.getSnapshot().history;
  state.commit(edited);
  held.release();
  await reloading;
  assert.equal(state.getSnapshot().draft, edited);
  assert.equal(state.getSnapshot().history, history);
  assert.equal(state.getSnapshot().status, 'unsaved');
  assertDraftEqual(recovery.peek().draft, edited);
  assert.equal(host.count('saveDraft'), 0);
});

test('a slow asset read during reload cannot replace newer history', async t => {
  const { state, host, recovery } = fixture(t);
  await state.ensureLoaded();
  const held = host.hold('read');
  const reloading = state.load();
  await held.entered;
  const edited = note(state.getSnapshot().draft, 'edited while image metadata was loading');
  state.commit(edited);
  held.release();
  await reloading;
  assert.equal(state.getSnapshot().draft, edited);
  assert.equal(state.getSnapshot().history.current, edited);
  assertDraftEqual(recovery.peek().draft, edited);
});

test('commit during the reload pre-save phase leaves the latest state marked unsaved', async t => {
  const { state, host } = fixture(t);
  await state.ensureLoaded();
  state.commit(note(state.getSnapshot().draft, 'first change'));
  const held = host.hold('saveDraft');
  const reloading = state.load();
  await held.entered;
  const latest = note(state.getSnapshot().draft, 'second change during save');
  state.commit(latest);
  held.release();
  await reloading;
  assert.equal(state.getSnapshot().draft, latest);
  assert.equal(state.getSnapshot().history.current, latest);
  assert.equal(state.getSnapshot().status, 'unsaved', 'stale reload must not leave a newer edit stuck as loading');
});

test('selecting another image flushes the current dirty draft before per-image loading', async t => {
  const { state, host } = fixture(t);
  await state.ensureLoaded();
  const edited = note(state.getSnapshot().draft, 'keep old image comments');
  state.commit(edited);
  const held = host.hold('saveDraft', request => request.draft.asset.assetId === A.assetId);
  const selecting = state.useAsset(B);
  await held.entered;
  assert.equal(host.count('loadDraft', request => request.assetId === B.assetId), 0);
  assert.equal(state.getSnapshot().draft.asset.assetId, A.assetId);
  held.release();
  await selecting;
  assertDraftEqual(host.document(A.assetId).draft, edited);
  assert.equal(host.document(A.assetId).version, 2);
  assert.equal(state.getSnapshot().draft.asset.assetId, B.assetId);
  assert.equal(host.document(B.assetId).version, 1);
});

test('an edit during image-switch pre-save is saved or keeps the original image selected', async t => {
  const { state, host, recovery } = fixture(t);
  await state.ensureLoaded();
  state.commit(note(state.getSnapshot().draft, 'first change before switch'));
  const held = host.hold('saveDraft', request => request.draft.asset.assetId === A.assetId);
  const selecting = state.useAsset(B).then(() => ({ accepted: true }), error => ({ accepted: false, error }));
  await held.entered;
  const latest = note(state.getSnapshot().draft, 'newer change during image-switch save');
  state.commit(latest);
  held.release();
  const outcome = await selecting;
  if (outcome.accepted) {
    assert.equal(state.getSnapshot().draft.asset.assetId, B.assetId);
    assertDraftEqual(host.document(A.assetId).draft, latest);
  } else {
    assert.equal(state.getSnapshot().draft, latest, 'a rejected image switch must leave the newer local edit intact');
    assertDraftEqual(recovery.peek().draft, latest);
  }
});

test('per-image loading preserves existing comments, moves, numbering and source identity', async t => {
  const { state, host } = fixture(t);
  let savedB = core.addBlock(draftFor(B), { x: 10, y: 10, width: 20, height: 20 }, { id: 'block-b' });
  savedB = core.moveBlock(savedB, 'block-b', { x: 80, y: 50 });
  savedB = core.addAnnotation(savedB, { text: 'existing component note', target: { kind: 'block', blockId: 'block-b' } });
  host.put(savedB, 7, false);
  await state.ensureLoaded();
  await state.useAsset(B);
  assertDraftEqual(state.getSnapshot().draft, savedB);
  assert.equal(state.getSnapshot().draft.annotations[0].number, 1);
  assert.equal(state.getSnapshot().draft.blocks[0].source.x, 10);
  assert.equal(state.getSnapshot().draft.blocks[0].destination.x, 80);
  assert.equal(state.getSnapshot().history.current, state.getSnapshot().draft);
  assert.equal(host.calls.find(call => call.action === 'saveDraft').expectedVersion, 7);
  assert.equal(state.getSnapshot().version, 8);
});

test('edits during a slow per-image load reject adoption rather than discard the current document', async t => {
  const { state, host, recovery } = fixture(t);
  await state.ensureLoaded();
  const held = host.hold('loadDraft', request => request.assetId === B.assetId);
  const selecting = state.useAsset(B);
  const rejection = assert.rejects(selecting, /draft changed while selecting an image/u);
  await held.entered;
  const edited = note(state.getSnapshot().draft, 'keep current image');
  state.commit(edited);
  held.release();
  await rejection;
  assert.equal(state.getSnapshot().draft, edited);
  assert.equal(state.getSnapshot().asset.assetId, A.assetId);
  assertDraftEqual(recovery.peek().draft, edited);
  assert.equal(host.count('saveDraft', request => request.draft.asset.assetId === B.assetId), 0);
});

test('dispose before debounce synchronously preserves dirty metadata for a fresh controller', async t => {
  const { state, host, recovery } = fixture(t);
  await state.ensureLoaded();
  const edited = note(state.getSnapshot().draft, 'recover after unload');
  state.commit(edited);
  assertDraftEqual(recovery.peek().draft, edited);
  state.dispose();
  await state.flush();
  assert.equal(host.count('saveDraft'), 0);
  assertDraftEqual(recovery.peek().draft, edited);
  const restored = fixture(t, { host, recovery }).state;
  await restored.ensureLoaded();
  assertDraftEqual(restored.getSnapshot().draft, edited);
  assert.equal(restored.getSnapshot().status, 'unsaved');
  assert.equal(restored.getSnapshot().version, 1);
  assert.equal(restored.getSnapshot().history.current, restored.getSnapshot().draft);
  assert.equal(host.count('saveDraft'), 0, 'recovery schedules rather than synchronously spams saves');
});

test('successful flush clears a clean draft checkpoint and a repeated flush is a no-op', async t => {
  const { state, host, recovery } = fixture(t);
  await state.ensureLoaded();
  const edited = note(state.getSnapshot().draft, 'persist this');
  state.commit(edited);
  const clearCount = recovery.clears;
  await state.flush();
  assert.equal(state.getSnapshot().status, 'saved');
  assert.equal(state.getSnapshot().version, 2);
  assert.equal(state.getSnapshot().draft, edited);
  assertDraftEqual(host.document().draft, edited);
  assert.equal(recovery.peek(), null);
  assert.ok(recovery.clears > clearCount);
  await state.flush();
  assert.equal(host.count('saveDraft'), 1);
});

test('an older save acknowledgement retains a newer dirty checkpoint with the updated host version', async t => {
  const { state, host, recovery } = fixture(t);
  await state.ensureLoaded();
  const first = note(state.getSnapshot().draft, 'first');
  state.commit(first);
  const held = host.hold('saveDraft');
  const saving = state.flush();
  await held.entered;
  const second = note(state.getSnapshot().draft, 'second');
  state.commit(second);
  held.release();
  await saving;
  assert.equal(state.getSnapshot().draft, second);
  assert.equal(state.getSnapshot().status, 'unsaved');
  assert.equal(state.getSnapshot().version, 2);
  assertDraftEqual(recovery.peek().draft, second);
  assert.equal(recovery.peek().version, 2);
  assertDraftEqual(host.document().draft, first);
  await state.flush();
  assert.equal(state.getSnapshot().version, 3);
  assert.equal(recovery.peek(), null);
  assertDraftEqual(host.document().draft, second);
});

test('a save failing host compare-and-swap cannot overwrite another window and retains recovery', async t => {
  const { state, host, recovery } = fixture(t);
  await state.ensureLoaded();
  const local = note(state.getSnapshot().draft, 'local window');
  state.commit(local);
  const otherWindow = note(draftFor(A), 'other window already saved');
  host.put(otherWindow, 2);
  await assert.rejects(state.flush(), /VERSION_CONFLICT/u);
  assert.equal(state.getSnapshot().status, 'error');
  assert.equal(state.getSnapshot().draft, local);
  assert.equal(state.getSnapshot().version, 1);
  assertDraftEqual(recovery.peek().draft, local);
  assertDraftEqual(host.document().draft, otherWindow);
  assert.equal(host.document().version, 2);
});

test('cross-window recovery conflicts are explicit, never auto-saved, and require explicit discard', async t => {
  const remote = note(draftFor(A), 'newer host draft');
  const local = note(draftFor(A), 'older window unsaved recovery');
  const { state, host, recovery } = fixture(t, { remote, version: 3, recovered: checkpoint(local, 1) });
  await state.ensureLoaded();
  assert.equal(state.getSnapshot().ready, true);
  assert.equal(state.getSnapshot().status, 'error');
  assert.match(state.getSnapshot().error, /newer draft exists/u);
  assert.equal(state.getSnapshot().version, 1, 'keep the stale CAS version rather than overwriting the new host draft');
  assertDraftEqual(state.getSnapshot().draft, local);
  assertDraftEqual(recovery.peek().draft, local);
  assert.equal(host.count('saveDraft'), 0);
  await assert.rejects(state.flush(), /VERSION_CONFLICT/u);
  assertDraftEqual(host.document().draft, remote);
  await state.load({ discard: true });
  assertDraftEqual(state.getSnapshot().draft, remote);
  assert.equal(state.getSnapshot().version, 3);
  assert.equal(state.getSnapshot().status, 'saved');
  assert.equal(recovery.peek(), null);
  assert.equal(host.count('saveDraft'), 1, 'discard must not make a second overwriting save attempt');
});

test('a host save completing after disposal is reconciled and clears recovery on the next load', async t => {
  const { state, host, recovery } = fixture(t);
  await state.ensureLoaded();
  const edited = note(state.getSnapshot().draft, 'saved while unloading');
  state.commit(edited);
  const held = host.hold('saveDraft');
  const saving = state.flush();
  await held.entered;
  state.dispose();
  held.release();
  await saving;
  assertDraftEqual(recovery.peek().draft, edited);
  assertDraftEqual(host.document().draft, edited);
  const restored = fixture(t, { host, recovery }).state;
  await restored.ensureLoaded();
  assertDraftEqual(restored.getSnapshot().draft, edited);
  assert.equal(restored.getSnapshot().status, 'saved');
  assert.equal(restored.getSnapshot().version, 2);
  assert.equal(recovery.peek(), null);
});

test('runSubmission shares a flight across subscriber remounts and persists its retry identity', async t => {
  const { state, host, recovery } = fixture(t);
  await state.ensureLoaded();
  const entered = deferred(), response = deferred();
  let firstCalls = 0, duplicateCalls = 0;
  let unsubscribe = state.subscribe(() => {});
  const fingerprint = core.serializeDraft(state.getSnapshot().draft);
  const record = { fingerprint, requestId: 'request-stable', referenceAssetId: 'reference-stable' };
  const first = state.runSubmission(async () => {
    firstCalls++;
    state.setSubmission(record);
    entered.resolve();
    const result = await response.promise;
    state.setSubmission({ ...state.getSubmission(), accepted: true });
    return result;
  });
  await entered.promise;
  assert.equal(state.getSnapshot().sending, true);
  unsubscribe();
  unsubscribe = state.subscribe(() => {}); // a new consumer, the same persisted controller
  const second = state.runSubmission(async () => { duplicateCalls++; return { accepted: true }; });
  assert.equal(first, second);
  assert.equal(state.getSubmission().requestId, 'request-stable');
  assert.equal(recovery.peek().draft, null, 'clean drafts do not need a duplicate recovery snapshot');
  assert.equal(recovery.peek().submission.requestId, 'request-stable');
  response.resolve({ accepted: true, queued: true });
  assert.deepEqual(await first, { accepted: true, queued: true });
  assert.deepEqual(await second, { accepted: true, queued: true });
  assert.equal(firstCalls, 1);
  assert.equal(duplicateCalls, 0);
  assert.equal(state.getSnapshot().sending, false);
  assert.equal(state.getSubmission().accepted, true);
  unsubscribe();
  state.dispose();
  const restored = fixture(t, { host, recovery }).state;
  await restored.ensureLoaded();
  assert.deepEqual(restored.getSubmission(), { ...record, accepted: true });
  assert.equal(recovery.peek().submission.accepted, true);
});

test('a rejected submission releases the flight but preserves the same request ID for retry', async t => {
  const { state, recovery } = fixture(t);
  await state.ensureLoaded();
  const record = { fingerprint: core.serializeDraft(state.getSnapshot().draft), requestId: 'same-on-retry' };
  const failed = state.runSubmission(async () => {
    state.setSubmission(record);
    throw new Error('response lost');
  });
  await assert.rejects(failed, /response lost/u);
  assert.equal(state.getSnapshot().sending, false);
  assert.equal(state.getSubmission().requestId, 'same-on-retry');
  assert.equal(recovery.peek().submission.requestId, 'same-on-retry');
  let retryId;
  const retried = await state.runSubmission(async () => {
    retryId = state.getSubmission().requestId;
    return { accepted: true };
  });
  assert.equal(retryId, 'same-on-retry');
  assert.deepEqual(retried, { accepted: true });
});

test('submission metadata survives successful draft save and clearing it never deletes dirty recovery', async t => {
  const { state, recovery } = fixture(t);
  await state.ensureLoaded();
  const edited = note(state.getSnapshot().draft, 'draft and submission recovery');
  state.commit(edited);
  const record = { fingerprint: core.serializeDraft(edited), requestId: 'combined', referenceAssetId: 'ref-1' };
  state.setSubmission(record);
  assertDraftEqual(recovery.peek().draft, edited);
  assert.deepEqual(recovery.peek().submission, record);
  await state.flush();
  assert.equal(recovery.peek().draft, null);
  assert.deepEqual(recovery.peek().submission, record);
  state.setSubmission(null);
  assert.equal(recovery.peek(), null);
  state.commit(note(state.getSnapshot().draft, 'another edit'));
  state.setSubmission(record);
  state.setSubmission(null);
  assert.equal(recovery.peek().draft.annotations.length, 2);
  assert.equal(recovery.peek().submission, null);
});

test('recovery storage failure is visible without rolling back the edit or blocking an explicit host save', async t => {
  const { state, host, recovery } = fixture(t);
  await state.ensureLoaded();
  recovery.failWrite = true;
  const edited = note(state.getSnapshot().draft, 'must not disappear on quota failure');
  state.commit(edited);
  assert.equal(state.getSnapshot().draft, edited);
  assert.match(state.getSnapshot().error, /Local recovery unavailable: storage quota/u);
  await state.flush();
  assertDraftEqual(host.document().draft, edited);
  assert.equal(state.getSnapshot().status, 'saved');
});

test('twenty character previews update recovery but finish as exactly one undo step', async t => {
  const { state, recovery, host } = fixture(t, { remote: note(draftFor(A), 'before') });
  await state.ensureLoaded();
  const baseline = state.getSnapshot().draft;
  const history = state.getSnapshot().history;
  const id = baseline.annotations[0].id;
  const text = 'abcdefghijklmnopqrst';
  state.beginTextEdit(id);
  for (let length = 1; length <= text.length; length++) {
    previewText(state, id, text.slice(0, length));
    assert.equal(history.current, baseline);
    assert.equal(history.undoCount, 0);
    assert.equal(history.version, 0);
    assert.equal(recovery.peek().draft.annotations[0].text, text.slice(0, length));
  }
  assert.equal(host.count('saveDraft'), 0);
  const edited = state.getSnapshot().draft;
  assert.equal(state.finishTextEdit(), edited);
  assert.equal(state.getTextEditKey(), null);
  assert.equal(history.current, edited);
  assert.equal(history.undoCount, 1);
  assert.equal(history.version, 1);
  state.undo();
  assert.equal(state.getSnapshot().draft, baseline);
  state.redo();
  assert.equal(state.getSnapshot().draft, edited);
});

test('new annotation creation and subsequent typing share one undo group', async t => {
  const { state } = fixture(t);
  await state.ensureLoaded();
  const baseline = state.getSnapshot().draft;
  const id = stageText(state);
  for (const text of ['h', 'he', 'hel', 'hell', 'hello']) previewText(state, id, text);
  const edited = state.getSnapshot().draft;
  assert.equal(state.getSnapshot().history.undoCount, 0);
  state.finishTextEdit();
  assert.equal(state.getSnapshot().history.undoCount, 1);
  assert.equal(edited.annotations[0].text, 'hello');
  state.undo();
  assert.equal(state.getSnapshot().draft, baseline);
  assert.equal(state.getSnapshot().draft.annotations.length, 0);
  assert.equal(state.getSnapshot().draft.nextAnnotationNumber, 1);
  state.redo();
  assert.equal(state.getSnapshot().draft, edited);
});

test('cancel removes a new staged annotation without adding any history', async t => {
  const { state, recovery, host } = fixture(t);
  await state.ensureLoaded();
  const baseline = state.getSnapshot().draft;
  const history = state.getSnapshot().history;
  stageText(state, 'cancel this entire note');
  assert.equal(state.cancelTextEdit(), baseline);
  assert.equal(state.getTextEditKey(), null);
  assert.equal(state.getSnapshot().draft, baseline);
  assert.equal(history.current, baseline);
  assert.equal(history.undoCount, 0);
  assert.equal(history.redoCount, 0);
  assert.equal(history.version, 0);
  assert.equal(recovery.peek(), null);
  assert.equal(state.cancelTextEdit(), baseline);
  assert.equal(state.finishTextEdit(), baseline);
  await state.flush();
  assert.equal(host.count('saveDraft'), 0);
});

test('autosaving a preview does not split its undo group and cancel compensates on the next flush', async t => {
  const { state, recovery, host } = fixture(t);
  await state.ensureLoaded();
  const baseline = state.getSnapshot().draft;
  const id = stageText(state, 'preview saved before blur');
  await state.flush();
  assert.equal(state.getTextEditKey(), id);
  assert.equal(state.getSnapshot().history.current, baseline);
  assert.equal(state.getSnapshot().history.undoCount, 0);
  assert.equal(state.getSnapshot().version, 2);
  assert.equal(host.document().draft.annotations[0].text, 'preview saved before blur');
  state.cancelTextEdit();
  assert.equal(state.getSnapshot().draft, baseline);
  assert.equal(state.getSnapshot().status, 'unsaved');
  assertDraftEqual(recovery.peek().draft, baseline);
  assert.equal(recovery.peek().version, 2);
  await state.flush();
  assertDraftEqual(host.document().draft, baseline);
  assert.equal(state.getSnapshot().version, 3);
  assert.equal(state.getSnapshot().history.undoCount, 0);
  assert.equal(recovery.peek(), null);
});

test('repeated focus on the same text key does not split history or replace the baseline', async t => {
  const { state } = fixture(t, { remote: note(draftFor(A), '') });
  await state.ensureLoaded();
  const baseline = state.getSnapshot().draft;
  const id = baseline.annotations[0].id;
  for (let i = 1; i <= 20; i++) {
    state.beginTextEdit(id);
    state.beginTextEdit(id);
    previewText(state, id, 'x'.repeat(i));
    assert.equal(state.getSnapshot().history.undoCount, 0);
  }
  state.finishTextEdit();
  assert.equal(state.getSnapshot().history.undoCount, 1);
  state.undo();
  assert.equal(state.getSnapshot().draft, baseline);
});

test('beginning a different key finishes only the previous note transaction', async t => {
  const remote = note(note(draftFor(A), 'first'), 'second');
  const { state } = fixture(t, { remote });
  await state.ensureLoaded();
  const baseline = state.getSnapshot().draft;
  const [one, two] = baseline.annotations.map(annotation => annotation.id);
  state.beginTextEdit(one);
  previewText(state, one, 'first edited');
  const firstEdit = state.getSnapshot().draft;
  state.beginTextEdit(two);
  assert.equal(state.getTextEditKey(), two);
  assert.equal(state.getSnapshot().history.undoCount, 1);
  assert.equal(state.getSnapshot().history.current, firstEdit);
  previewText(state, two, 'second edited');
  state.finishTextEdit();
  assert.equal(state.getSnapshot().history.undoCount, 2);
  state.undo();
  assert.equal(state.getSnapshot().draft, firstEdit);
  state.undo();
  assert.equal(state.getSnapshot().draft, baseline);
});

test('an ordinary commit first settles text then records the separate operation', async t => {
  const { state } = fixture(t);
  await state.ensureLoaded();
  const baseline = state.getSnapshot().draft;
  stageText(state, 'keep this when undoing the cut');
  const typed = state.getSnapshot().draft;
  const cut = core.addBlock(typed, { x: 10, y: 10, width: 20, height: 20 });
  state.commit(cut);
  assert.equal(state.getTextEditKey(), null);
  assert.equal(state.getSnapshot().history.undoCount, 2);
  state.undo();
  assert.equal(state.getSnapshot().draft, typed);
  state.undo();
  assert.equal(state.getSnapshot().draft, baseline);
});

test('undo settles an active text edit, while redo never resurrects a branch replaced by typing', async t => {
  const { state } = fixture(t);
  await state.ensureLoaded();
  const baseline = state.getSnapshot().draft;
  stageText(state, 'first branch');
  const first = state.getSnapshot().draft;
  state.undo();
  assert.equal(state.getTextEditKey(), null);
  assert.equal(state.getSnapshot().draft, baseline);
  assert.equal(state.getSnapshot().history.redoCount, 1);
  state.redo();
  assert.equal(state.getSnapshot().draft, first);
  state.undo();
  stageText(state, 'different branch');
  const replacement = state.getSnapshot().draft;
  state.redo();
  assert.equal(state.getTextEditKey(), null);
  assert.equal(state.getSnapshot().draft, replacement);
  assert.equal(state.getSnapshot().history.redoCount, 0);
  state.undo();
  assert.equal(state.getSnapshot().draft, baseline);
});

test('reload settles and saves a text transaction before adopting the saved document', async t => {
  const { state, host } = fixture(t);
  await state.ensureLoaded();
  const history = state.getSnapshot().history;
  stageText(state, 'save text before reload');
  const edited = state.getSnapshot().draft;
  await state.load();
  assert.equal(state.getTextEditKey(), null);
  assert.equal(history.undoCount, 1);
  assert.equal(history.current, edited);
  assertDraftEqual(host.document().draft, edited);
  assertDraftEqual(state.getSnapshot().draft, edited);
  assert.equal(state.getSnapshot().status, 'saved');
});

test('text previews invalidate an already pending reload without adding history entries', async t => {
  const { state, host, recovery } = fixture(t, { remote: note(draftFor(A), 'before') });
  await state.ensureLoaded();
  const held = host.hold('loadDraft', request => !request.assetId);
  const reloading = state.load();
  await held.entered;
  const id = state.getSnapshot().draft.annotations[0].id;
  state.beginTextEdit(id);
  previewText(state, id, 'newer preview');
  const preview = state.getSnapshot().draft;
  held.release();
  await reloading;
  assert.equal(state.getSnapshot().draft, preview);
  assert.equal(state.getTextEditKey(), id);
  assert.equal(state.getSnapshot().history.undoCount, 0);
  assertDraftEqual(recovery.peek().draft, preview);
});

test('focusing text during a reload does not leave its stale loading status behind', async t => {
  const { state, host } = fixture(t, { remote: note(draftFor(A), 'unchanged') });
  await state.ensureLoaded();
  const baseline = state.getSnapshot().draft;
  const held = host.hold('loadDraft', request => !request.assetId);
  const reloading = state.load();
  await held.entered;
  const id = baseline.annotations[0].id;
  state.beginTextEdit(id);
  held.release();
  await reloading;
  assert.equal(state.getSnapshot().draft, baseline);
  assert.equal(state.getSnapshot().status, 'saved');
  assert.equal(state.getSnapshot().history.undoCount, 0);
  assert.equal(state.getTextEditKey(), id);
});

test('switching images settles text and saves the entire annotation on the old image', async t => {
  const { state, host } = fixture(t);
  await state.ensureLoaded();
  const history = state.getSnapshot().history;
  stageText(state, 'retain all typing on image A');
  const editedA = state.getSnapshot().draft;
  await state.useAsset(B);
  assert.equal(state.getTextEditKey(), null);
  assert.equal(history.undoCount, 1);
  assert.equal(history.current, editedA);
  assertDraftEqual(host.document(A.assetId).draft, editedA);
  assert.equal(state.getSnapshot().draft.asset.assetId, B.assetId);
});

test('typing during the image-switch save still rejects adoption and preserves the newer preview', async t => {
  const { state, host, recovery } = fixture(t);
  await state.ensureLoaded();
  const id = stageText(state, 'initial text before switch');
  const held = host.hold('saveDraft', request => request.draft.asset.assetId === A.assetId);
  const selecting = state.useAsset(B);
  const rejection = assert.rejects(selecting, /current draft changed while saving/u);
  await held.entered;
  assert.equal(state.getTextEditKey(), null, 'image selection settled the earlier focus transaction');
  state.beginTextEdit(id);
  previewText(state, id, 'newer text during switch');
  const latest = state.getSnapshot().draft;
  held.release();
  await rejection;
  assert.equal(state.getSnapshot().draft, latest);
  assert.equal(state.getTextEditKey(), id);
  assert.equal(state.getSnapshot().history.undoCount, 1);
  assertDraftEqual(recovery.peek().draft, latest);
  assert.equal(host.document(A.assetId).draft.annotations[0].text, 'initial text before switch');
  await state.useAsset(B);
  assertDraftEqual(host.document(A.assetId).draft, latest);
  assert.equal(state.getSnapshot().draft.asset.assetId, B.assetId);
});

test('typing during per-image loading invalidates that late adoption', async t => {
  const { state, host, recovery } = fixture(t, { remote: note(draftFor(A), 'old') });
  await state.ensureLoaded();
  const held = host.hold('loadDraft', request => request.assetId === B.assetId);
  const selecting = state.useAsset(B);
  const rejection = assert.rejects(selecting, /draft changed while selecting an image/u);
  await held.entered;
  const id = state.getSnapshot().draft.annotations[0].id;
  state.beginTextEdit(id);
  previewText(state, id, 'preview that must remain on A');
  const latest = state.getSnapshot().draft;
  held.release();
  await rejection;
  assert.equal(state.getSnapshot().draft, latest);
  assert.equal(state.getTextEditKey(), id);
  assertDraftEqual(recovery.peek().draft, latest);
  assert.equal(state.getSnapshot().history.undoCount, 0);
});

test('disposal settles active text exactly once and recovery restores the unfinished input', async t => {
  const { state, host, recovery } = fixture(t);
  await state.ensureLoaded();
  const history = state.getSnapshot().history;
  stageText(state, 'typed immediately before unload');
  const edited = state.getSnapshot().draft;
  state.dispose();
  assert.equal(state.getTextEditKey(), null);
  assert.equal(history.current, edited);
  assert.equal(history.undoCount, 1);
  assertDraftEqual(recovery.peek().draft, edited);
  assert.equal(host.count('saveDraft'), 0);
  state.dispose();
  assert.equal(history.undoCount, 1);
  const restored = fixture(t, { host, recovery }).state;
  await restored.ensureLoaded();
  assertDraftEqual(restored.getSnapshot().draft, edited);
  assert.equal(restored.getTextEditKey(), null);
  assert.equal(restored.getSnapshot().status, 'unsaved');
});

test('cancelling while a preview save is in flight keeps a compensating recovery draft', async t => {
  const { state, host, recovery } = fixture(t);
  await state.ensureLoaded();
  const baseline = state.getSnapshot().draft;
  stageText(state, 'pending preview');
  const held = host.hold('saveDraft');
  const saving = state.flush();
  await held.entered;
  state.cancelTextEdit();
  assert.equal(state.getSnapshot().draft, baseline);
  assert.equal(state.getSnapshot().status, 'unsaved');
  assertDraftEqual(recovery.peek().draft, baseline);
  const restoring = state.flush();
  held.release();
  await saving;
  await restoring;
  assertDraftEqual(host.document().draft, baseline);
  assert.equal(state.getSnapshot().version, 3);
  assert.equal(state.getSnapshot().history.undoCount, 0);
  assert.equal(recovery.peek(), null);
});

test('text previews validate immutable identity and source before changing live state', async t => {
  const remote = core.addBlock(draftFor(A), { x: 10, y: 10, width: 20, height: 20 }, { id: 'immutable' });
  const { state } = fixture(t, { remote });
  await state.ensureLoaded();
  const baseline = state.getSnapshot().draft;
  assert.throws(() => state.previewText(note(baseline, 'no transaction')), /Begin a text edit/u);
  assert.throws(() => state.beginTextEdit(''), TypeError);
  state.beginTextEdit('key');
  assert.throws(() => state.previewText(draftFor(B)), error => error.code === 'IDENTITY_MISMATCH');
  const forged = clone(baseline);
  forged.blocks[0].source.x = 11;
  forged.blocks[0].destination.x = 11;
  assert.throws(() => state.previewText(forged), error => error.code === 'IDENTITY_MISMATCH');
  assert.equal(state.getSnapshot().draft, baseline);
  assert.equal(state.getSnapshot().history.undoCount, 0);
  assert.equal(state.getTextEditKey(), 'key');
  state.cancelTextEdit();
});
