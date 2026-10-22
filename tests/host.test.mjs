import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { installHost, IMAGE_ROUTE, AUTH_ROUTE, decodeBase64, historicalImages } from '../host.js';
import * as core from '../editor-core.js';

// No fixture creates a real Agent, calls the GUI, opens sockets, or touches profile files.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6M1sAAAAASUVORK5CYII=', 'base64');
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const copy = value => structuredClone(value);
const signal = () => new AbortController().signal;
function reference(bytes = PNG, name = 'test.png') {
  return { attachmentId: hash(bytes), mediaType: 'image/png', bytes: bytes.length, width: 100, height: 80, name };
}
function fixture(backing = { rows: new Map(), images: new Map() }) {
  const agents = new Map();
  const commands = new Map();
  const tools = new Map();
  const routes = new Map();
  const projections = new Map();
  const effects = [];
  const calls = { save: [], prompt: [], flush: 0, fs: [], histories: [], closes: 0, initiating: [] };
  let failPut = false, failFlush = false, failPrompt = false;
  const fs = {
    resolve: async (path, options) => { calls.fs.push({ path, options }); if (path === 'denied.png') throw Object.assign(new Error('Denied by provider'), { code: 'FS_PERMISSION_DENIED' }); return { targetKey: path, displayPath: path }; },
    readBytes: async (_target, _signal, maxBytes) => { assert.equal(maxBytes, 1024 * 1024); return PNG; },
  };
  const ctx = {
    commands: { register: def => { commands.set(def.name, def); return () => commands.delete(def.name); } },
    tools: { register: def => { tools.set(def.name, def); return () => tools.delete(def.name); } },
    agents: { get: id => agents.get(id), withInitiator: (agent, op) => { calls.initiating.push(agent.id); return op(); } },
    sessions: { flush: async () => { calls.flush++; if (failFlush) throw new Error('Disk unavailable'); return true; } },
    attachments: {
      imageLimits: { maxImageBytes: 1024 * 1024, maxImagesPerMessage: 20, maxMessageImageBytes: 2 * 1024 * 1024, maxImagePixels: 64000000, maxImageDimension: 8192, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
      saveImage: async input => { calls.save.push(input); const ref = reference(input.data, input.name); backing.images.set(ref.attachmentId, { ref, data: Buffer.from(input.data) }); return copy(ref); },
      readImage: async ref => { const value = backing.images.get(ref.attachmentId); if (!value) throw new Error('Missing image'); return { ref: copy(value.ref), data: Buffer.from(value.data) }; },
    },
    storageDomain: {
      open: async spec => {
        assert.match(spec.name, /^[a-z][a-z0-9_]*$/);
        for (const name of Object.keys(spec.tables)) assert.match(name, /^[a-z][a-z0-9_]*$/);
        return {
        table: name => ({
          get: key => backing.rows.get(key),
          put: async (key, value) => { if (failPut) throw new Error('Storage unavailable'); backing.rows.set(key, copy(spec.tables[name].valueSchema.parse(value))); },
        }),
        close: async () => { calls.closes++; },
        };
      },
    },
    sessionProjections: {
      register: def => { projections.set(def.key, def); return () => projections.delete(def.key); },
      stateOf: (session, key) => { const def = projections.get(key); return session.events.reduce(def.apply, def.init()); },
    },
    sessionController: {
      resolveAgent: async id => agents.has(id) ? { agent: agents.get(id) } : { error: { message: 'Session not found' } },
      attachment: async req => {
        calls.histories.push(req);
        const own = agents.get(req.sessionId).session.events.reduce(historicalImages, []).find(item => item.ref.attachmentId === req.attachmentId);
        if (!own) throw Object.assign(new Error('Image not referenced'), { code: 'session/attachment-invalid' });
        return { attachment: own.ref, data: backing.images.get(req.attachmentId).data.toString('base64') };
      },
      prompt: async req => { if (failPrompt) throw Object.assign(new Error('Model does not support images'), { code: 'session/attachment-invalid' }); calls.prompt.push(copy(req)); return { accepted: true }; },
    },
    connection: {
      admit: ({ headers }) => headers.get('x-test-peer') === 'owner' ? { peer: { principal: { kind: 'owner' } } } : headers.get('x-test-peer') === 'guest' ? { peer: { principal: { kind: 'guest' } } } : { rejection: 401 },
      fetch: { register: route => { routes.set(route.path, route); return async () => routes.delete(route.path); } },
    },
    workingDirectory: { get: session => session.cwd },
    fs: { resolve: () => { throw new Error('Root filesystem must never be used'); } },
    effect: init => { effects.push(init()); },
  };
  const newAgent = (id = 'session-test') => {
    const agent = { id, ctx: { get: name => name === 'fs' ? fs : undefined }, session: { id, cwd: 'X:\\workspace', events: [] } };
    agents.set(id, agent); return agent;
  };
  const agent = newAgent();
  const start = () => installHost(ctx, { core });
  const http = (route, params, peer = 'owner', method = 'GET') => routes.get(route).fetch(new Request(`http://fixture.invalid${route}?${new URLSearchParams(params)}`, { method, headers: { 'x-test-peer': peer } }));
  const addHistory = (target = agent, bytes = PNG, seq = 0) => {
    const ref = reference(bytes);
    backing.images.set(ref.attachmentId, { ref, data: bytes });
    target.session.events.push({ type: 'user/message', seq, time: 20 + seq, data: { content: [{ type: 'image', attachment: ref }] } });
    return ref;
  };
  return { ctx, agent, newAgent, agents, commands, tools, routes, projections, effects, calls, backing, start, http, addHistory,
    set failPut(value) { failPut = value; }, set failFlush(value) { failFlush = value; }, set failPrompt(value) { failPrompt = value; } };
}
const importPng = (service, agent, extra = {}) => service.execute(agent, { action: 'import', source: { kind: 'base64', data: PNG.toString('base64') }, ...extra }, signal());
function draftFor(asset, sessionId = asset.sessionId) {
  return core.createDraft({ sessionId, asset: { assetId: asset.assetId, attachmentId: asset.attachmentId, width: asset.width, height: asset.height } });
}

test('normalizes import through official store, deduplicates ownership and excludes base64 from persistent records', async () => {
  const f = fixture(); const host = await f.start();
  const first = await importPng(host, f.agent);
  assert.equal(first.ok, true); assert.equal(first.asset.width, 100);
  assert.equal(first.asset.coordinateSpace, 'asset-pixels');
  assert.match(first.asset.url, /^\/api\/image-feedback\/image\?/);
  const second = await importPng(host, f.agent);
  assert.equal(first.asset.assetId, second.asset.assetId);
  assert.equal([...f.backing.rows.values()][0].assets.length, 1);
  assert.equal(JSON.stringify([...f.backing.rows.values()]).includes(PNG.toString('base64')), false);
  assert.equal(f.calls.prompt.length, 0);
  await host.dispose();
});

test('strict canonical base64, MIME and maximum encoded size fail before attachment writes', async () => {
  assert.equal(decodeBase64({ data: `data:image/png;base64,${PNG.toString('base64')}` }, 1024).mediaType, 'image/png');
  for (const source of [{ data: 'a===' }, { data: 'Zg==' }, { data: PNG.toString('base64'), mediaType: 'image/jpeg' }, { data: `data:text/plain;base64,${PNG.toString('base64')}` }]) {
    assert.throws(() => decodeBase64(source, 1024));
  }
  assert.throws(() => decodeBase64({ data: PNG.toString('base64') }, 8));
  const large = Buffer.concat([PNG, Buffer.alloc(900000)]);
  assert.equal(decodeBase64({ data: large.toString('base64') }, 1024 * 1024).data.length, large.length);
  const f = fixture(); const host = await f.start();
  const result = await host.execute(f.agent, { action: 'import', source: { kind: 'base64', data: 'not base64' } }, signal());
  assert.equal(result.ok, false); assert.equal(f.calls.save.length, 0);
  await host.dispose();
});

test('path import uses exact Agent scoped provider and denial never falls back', async () => {
  const f = fixture(); const host = await f.start();
  const imported = await host.execute(f.agent, { action: 'import', source: { kind: 'path', path: 'folder/test.png' } }, signal());
  assert.equal(imported.ok, true); assert.equal(imported.asset.name, 'test.png');
  assert.equal(f.calls.fs[0].options.cwd, 'X:\\workspace');
  assert.ok(f.calls.initiating.includes(f.agent.id));
  const denied = await host.execute(f.agent, { action: 'import', source: { kind: 'path', path: 'denied.png' } }, signal());
  assert.equal(denied.error.code, 'FS_PERMISSION_DENIED'); assert.equal(f.calls.save.length, 1);
  const fake = await host.execute(f.agent, { action: 'import', source: { kind: 'path', path: 'C:\\fakepath\\test.png' } }, signal());
  assert.equal(fake.error.code, 'INVALID_PATH');
  await host.dispose();
});

test('session mismatch, unknown asset, swapped agent identity and forged history reference fail closed', async () => {
  const f = fixture(); const host = await f.start(); const image = await importPng(host, f.agent);
  const other = f.newAgent('session-other');
  assert.equal((await host.execute(other, { action: 'read', assetId: image.asset.assetId }, signal())).error.code, 'ASSET_NOT_OWNED');
  assert.equal((await host.execute(f.agent, { action: 'list', sessionId: other.id }, signal())).error.code, 'SESSION_MISMATCH');
  assert.equal((await host.execute(f.agent, { action: 'import', source: { kind: 'history', attachmentId: image.asset.attachmentId } }, signal())).error.code, 'session/attachment-invalid');
  f.agents.set(f.agent.id, { ...f.agent });
  assert.equal((await host.execute(f.agent, { action: 'list' }, signal())).error.code, 'SESSION_UNAVAILABLE');
  await host.dispose();
});

test('history projection is narrow, ignores unrelated payloads, lists history alongside staged images', async () => {
  const f = fixture(); const host = await f.start(); const ref = f.addHistory();
  f.agent.session.events.push({ type: 'plugin:untrusted', seq: 1, time: 30, data: { content: [{ type: 'image', attachment: reference(Buffer.from('other')) }] } });
  const empty = []; assert.equal(historicalImages(empty, { type: 'tool/call', data: { content: [{ type: 'image', attachment: ref }] } }), empty);
  const listed = await host.execute(f.agent, { action: 'list' }, signal());
  assert.equal(listed.items.length, 1); assert.equal(listed.items[0].source, 'history');
  assert.equal(listed.items[0].sourceEventId, '0');
  assert.equal((await host.execute(f.agent, { action: 'read', assetId: listed.items[0].assetId }, signal())).ok, true);
  const imported = await host.execute(f.agent, { action: 'import', source: { kind: 'history', attachmentId: ref.attachmentId } }, signal());
  assert.equal(imported.ok, true); assert.equal(f.calls.histories.length, 1); assert.equal(f.calls.save.length, 0);
  await host.dispose();
});

test('draft CAS rejects stale saves; per-image archives survive close, reload and active image switching', async () => {
  const f = fixture(); let host = await f.start(); const first = (await importPng(host, f.agent)).asset;
  const bytes = Buffer.concat([PNG, Buffer.from([1])]);
  const second = (await host.execute(f.agent, { action: 'import', source: { kind: 'bytes', data: [...bytes] } }, signal())).asset;
  const a = core.addAnnotation(draftFor(first), { text: 'First image', target: { kind: 'global' } });
  const b = core.addAnnotation(draftFor(second), { text: 'Second image', target: { kind: 'global' } });
  assert.deepEqual(await host.execute(f.agent, { action: 'saveDraft', draft: a, expectedVersion: 0 }, signal()), { ok: true, version: 1 });
  assert.equal((await host.execute(f.agent, { action: 'saveDraft', draft: b, expectedVersion: 0 }, signal())).error.code, 'DRAFT_CONFLICT');
  assert.equal((await host.execute(f.agent, { action: 'saveDraft', draft: b, expectedVersion: 1 }, signal())).version, 2);
  assert.deepEqual((await host.execute(f.agent, { action: 'loadDraft', assetId: first.assetId }, signal())).draft, a);
  await host.dispose(); host = await f.start();
  assert.deepEqual((await host.execute(f.agent, { action: 'loadDraft' }, signal())).draft, b);
  assert.deepEqual((await host.execute(f.agent, { action: 'loadDraft', assetId: first.assetId }, signal())).draft, a);
  const changedDimensions = copy(a); changedDimensions.asset.width++;
  assert.equal((await host.execute(f.agent, { action: 'saveDraft', draft: changedDimensions, expectedVersion: 2 }, signal())).error.code, 'ASSET_MISMATCH');
  await host.dispose();
});

test('storage failure never reports imported image or saved draft as persisted', async () => {
  const f = fixture(); const host = await f.start();
  f.failPut = true;
  const failed = await importPng(host, f.agent);
  assert.equal(failed.ok, false); assert.equal(f.backing.rows.size, 0);
  f.failPut = false; const asset = (await importPng(host, f.agent)).asset;
  f.failPut = true;
  assert.equal((await host.execute(f.agent, { action: 'saveDraft', draft: draftFor(asset), expectedVersion: 0 }, signal())).ok, false);
  f.failPut = false;
  assert.equal((await host.execute(f.agent, { action: 'loadDraft' }, signal())).draft, null);
  await host.dispose();
});

test('submit sends original and optional reference image parts, preserves move-only feedback, and deduplicates concurrent clicks', async () => {
  const f = fixture(); const host = await f.start(); const asset = (await importPng(host, f.agent)).asset;
  const previewBytes = Buffer.concat([PNG, Buffer.from([2])]);
  const preview = (await host.execute(f.agent, { action: 'import', source: { kind: 'bytes', data: [...previewBytes] } }, signal())).asset;
  let draft = core.addBlock(draftFor(asset), { x: 0, y: 0, width: 10, height: 10 }, { id: 'block-one' });
  draft = core.moveBlock(draft, 'block-one', { x: 30, y: 25 });
  const request = { action: 'submit', draft, requestId: 'explicit-mock-only-submit', referenceAssetId: preview.assetId };
  const results = await Promise.all([host.execute(f.agent, request, signal()), host.execute(f.agent, request, signal())]);
  assert.equal(results[0].accepted, true); assert.equal(results[1].duplicate, true);
  assert.equal(f.calls.prompt.length, 1); assert.equal(f.calls.flush, 1);
  const prompt = f.calls.prompt[0];
  assert.equal(prompt.sessionId, f.agent.id); assert.equal(prompt.mode, 'queue');
  assert.deepEqual(prompt.content.map(p => p.type), ['image', 'image', 'text']);
  assert.equal(prompt.content[0].data, PNG.toString('base64'));
  assert.match(prompt.content[2].text, /block-one/); assert.match(prompt.content[2].text, /30/);
  assert.equal(prompt.content[2].text.includes(PNG.toString('base64')), false);
  assert.equal('composer' in f.ctx, false); // There is deliberately no composer capability to call.
  const changed = { ...request, draft: core.resetBlock(draft, 'block-one') };
  assert.equal((await host.execute(f.agent, changed, signal())).error.code, 'IDEMPOTENCY_CONFLICT');
  await host.dispose();
  const restarted = await f.start();
  assert.equal((await restarted.execute(f.agent, request, signal())).duplicate, true);
  assert.equal(f.calls.prompt.length, 1);
  await restarted.dispose();
});

test('pre-admission failure is retryable with same id; flush failure reports accepted with uncertain durability', async () => {
  const f = fixture(); const host = await f.start(); const asset = (await importPng(host, f.agent)).asset;
  const request = { action: 'submit', requestId: 'mock-retry', draft: draftFor(asset) };
  f.failPrompt = true;
  assert.equal((await host.execute(f.agent, request, signal())).ok, false);
  f.failPrompt = false; f.failFlush = true;
  const accepted = await host.execute(f.agent, request, signal());
  assert.equal(accepted.accepted, true); assert.equal(accepted.durable, false); assert.match(accepted.warning, /same requestId/);
  await host.dispose();
});

test('cancelled import and submit cannot wake an Agent', async () => {
  const f = fixture(); const host = await f.start();
  const stop = new AbortController(); stop.abort();
  const result = await host.execute(f.agent, { action: 'import', source: { kind: 'base64', data: PNG.toString('base64') } }, stop.signal);
  assert.equal(result.ok, false); assert.equal(f.calls.prompt.length, 0); assert.equal(f.calls.save.length, 0);
  await host.dispose();
});

test('authenticated binary preview rejects unauthenticated, nonowner and cross-session requests, without command base64 results', async () => {
  const f = fixture(); const host = await f.start(); const asset = (await importPng(host, f.agent)).asset;
  const params = { sessionId: f.agent.id, assetId: asset.assetId };
  assert.equal((await f.http(IMAGE_ROUTE, params, 'anonymous')).status, 401);
  assert.equal((await f.http(IMAGE_ROUTE, params, 'guest')).status, 403);
  assert.equal((await f.http(IMAGE_ROUTE, { ...params, sessionId: 'different' })).status, 404);
  const response = await f.http(IMAGE_ROUTE, params);
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  const metadata = await host.execute(f.agent, { action: 'read', assetId: asset.assetId }, signal());
  assert.equal(JSON.stringify(metadata).includes(PNG.toString('base64')), false);
  await host.dispose();
});

test('owner command capability is session-scoped and shares implementation with the tool', async () => {
  const f = fixture(); const host = await f.start(); const command = f.commands.get('image-feedback');
  assert.equal(command.recordInput, false);
  assert.equal((await f.http(AUTH_ROUTE, { sessionId: f.agent.id }, 'guest')).status, 403);
  assert.equal((await f.http(AUTH_ROUTE, { sessionId: 'does-not-exist' })).status, 409);
  assert.equal((await f.http(AUTH_ROUTE, {})).status, 400);
  const { authorization } = await (await f.http(AUTH_ROUTE, { sessionId: f.agent.id })).json();
  const invoke = (agent, operation) => command.handler({ agent, rawInput: JSON.stringify(operation), attachments: [], signal: signal() });
  assert.equal(JSON.parse((await invoke(f.agent, { action: 'list' })).text).error.code, 'OWNER_AUTH_REQUIRED');
  const other = f.newAgent('session-other');
  assert.equal(JSON.parse((await invoke(other, { action: 'list', authorization })).text).error.code, 'OWNER_AUTH_REQUIRED');
  const cmd = await invoke(f.agent, { action: 'import', authorization, source: { kind: 'base64', data: PNG.toString('base64') } });
  assert.equal(cmd.kind, 'success'); assert.equal(cmd.text.includes(PNG.toString('base64')), false);
  const tool = f.tools.get('image_feedback');
  const listed = await tool.execute({ action: 'list' }, { agent: f.agent, signal: signal() });
  assert.equal(listed.items[0].assetId, JSON.parse(cmd.text).asset.assetId);
  const read = await tool.execute({ action: 'read', assetId: listed.items[0].assetId }, { agent: f.agent, signal: signal() });
  assert.equal(tool.output.render({ action: 'read' }, read)[1].type, 'image');
  assert.equal((await tool.execute({ action: 'list', authorization }, { agent: f.agent, signal: signal() })).ok, false);
  await host.dispose(); assert.equal(f.routes.size, 0); assert.equal(f.commands.size, 0); assert.equal(f.tools.size, 0); assert.equal(f.calls.closes, 1);
});
