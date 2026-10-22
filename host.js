import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

/** Host-only adapter. All application operations below are shared by command and tool. */
export const HOST_INJECT = [
  'commands', 'tools', 'attachments', 'storageDomain', 'agents', 'sessions',
  'sessionController', 'sessionProjections', 'workingDirectory', 'fs', 'connection',
];
export const inject = HOST_INJECT;
export const COMMAND_NAME = 'image-feedback';
export const TOOL_NAME = 'image_feedback';
export const IMAGE_ROUTE = '/api/image-feedback/image';
export const AUTH_ROUTE = '/api/image-feedback/authorize';
const AUTH_TTL_MS = 30 * 60 * 1000;
const HISTORY_KEY = 'localImageFeedbackHistory';
// dsh-storage UNIT_NAME_RE: /^[a-z][a-z0-9_]*$/ (safe filename and SQL identifier).
const DOMAIN_NAME = 'dsh_image_feedback';
const MAX_DRAFT_BYTES = 512 * 1024;
const MAX_ASSETS = 512;
const MAX_REQUESTS = 256;
const ID = z.string().min(1).max(256);
const MIME = z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const REF = z.object({
  attachmentId: ID, mediaType: MIME, bytes: z.number().int().positive(),
  width: z.number().int().positive(), height: z.number().int().positive(),
  name: z.string().max(512).optional(),
  originalDimensions: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
}).strict();
const ASSET = z.object({
  assetId: ID, sessionId: ID, ref: REF,
  source: z.enum(['import', 'history']), createdAt: z.number(),
  sourceEventSeq: z.number().int().nonnegative().optional(),
}).strict();
const DRAFT_RECORD = z.object({ version: z.number().int().nonnegative(), draft: z.json().nullable() }).strict();
const SUBMISSION = z.object({
  requestId: ID, promptRequestId: ID, digest: z.string().length(64),
  state: z.enum(['prepared', 'accepted']), createdAt: z.number(),
}).strict();
const SESSION_RECORD = z.object({
  sessionId: ID,
  assets: z.array(ASSET).max(MAX_ASSETS),
  feedback: DRAFT_RECORD,
  drafts: z.array(z.object({ assetId: ID, draft: z.json() }).strict()).max(128),
  submissions: z.array(SUBMISSION).max(MAX_REQUESTS),
}).strict();
const SOURCE = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('base64'), data: z.string(), mediaType: MIME.optional(), name: z.string().max(512).optional() }).strict(),
  z.object({ kind: z.literal('bytes'), data: z.array(z.number().int().min(0).max(255)), mediaType: MIME.optional(), name: z.string().max(512).optional() }).strict(),
  z.object({ kind: z.literal('path'), path: z.string().min(1).max(4096), name: z.string().max(512).optional() }).strict(),
  z.object({ kind: z.literal('history'), attachmentId: ID }).strict(),
]);
const BASE = { sessionId: ID.optional() };
const REQUEST = z.discriminatedUnion('action', [
  z.object({ ...BASE, action: z.literal('import'), source: SOURCE.optional() }).strict(),
  z.object({ ...BASE, action: z.literal('list'), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  z.object({ ...BASE, action: z.literal('read'), assetId: ID }).strict(),
  z.object({ ...BASE, action: z.literal('loadDraft'), assetId: ID.optional() }).strict(),
  z.object({ ...BASE, action: z.literal('saveDraft'), draft: z.json().nullable(), expectedVersion: z.number().int().nonnegative() }).strict(),
  z.object({ ...BASE, action: z.literal('submit'), draft: z.json(), requestId: ID,
    referenceAssetId: ID.optional(), clientTimeZone: z.string().max(128).optional() }).strict(),
]);

class FeedbackError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ImageFeedbackError';
    this.code = code;
    this.details = details;
  }
}
function fail(code, message, details) { throw new FeedbackError(code, message, details); }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function keyOf(sessionId) { return digest(sessionId); }
function assetIdOf(sessionId, attachmentId) { return `img-${digest(`${sessionId}\0${attachmentId}`)}`; }
function clone(value) { return structuredClone(value); }
function fresh(sessionId) { return { sessionId, assets: [], feedback: { version: 0, draft: null }, drafts: [], submissions: [] }; }
function cancelled(signal) { signal?.throwIfAborted(); }
function stableJSON(value) {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJSON(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function safeName(name) {
  if (!name) return undefined;
  return name.split(/[\\/]/u).at(-1).replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 200) || undefined;
}
function publicAsset(asset) {
  const { ref } = asset;
  return {
    assetId: asset.assetId, sessionId: asset.sessionId, ...clone(ref),
    coordinateSpace: 'asset-pixels', source: asset.source,
    ...(asset.sourceEventSeq === undefined ? {} : { sourceEventId: String(asset.sourceEventSeq) }),
    url: `${IMAGE_ROUTE}?sessionId=${encodeURIComponent(asset.sessionId)}&assetId=${encodeURIComponent(asset.assetId)}`,
  };
}
function errorValue(error) {
  if (error instanceof z.ZodError) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid image-feedback request.', issues: error.issues.slice(0, 6).map(x => ({ path: x.path.join('.'), message: x.message })) } };
  return { ok: false, error: {
    code: typeof error?.code === 'string' ? error.code : error?.name === 'AbortError' ? 'ABORTED' : 'IMAGE_FEEDBACK_FAILED',
    message: typeof error?.message === 'string' ? error.message.slice(0, 1200) : 'Image feedback failed.',
    ...(error instanceof FeedbackError && error.details !== undefined ? { details: error.details } : {}),
  } };
}
/** Narrow built-in event fields only: arbitrary tool metadata cannot grant access. */
export function historicalImages(state, event) {
  const blocks = [];
  const content = event.type === 'user/message' ? event.data?.content
    : ['assistant/message', 'developer/message', 'system/message', 'tool/result'].includes(event.type)
      ? event.data?.message?.content : undefined;
  if (Array.isArray(content)) blocks.push(...content);
  if (['assistant/message', 'assistant/attempt'].includes(event.type) && Array.isArray(event.data?.stream)) {
    for (const item of event.data.stream) {
      if (item?.type === 'chunk' && item.chunk?.type === 'block-end') blocks.push(item.chunk.block);
    }
  }
  let next = state;
  for (const block of blocks) {
    if (block?.type !== 'image') continue;
    const parsed = REF.safeParse(block.attachment);
    if (!parsed.success || state.some(item => item.ref.attachmentId === parsed.data.attachmentId)) continue;
    if (next === state) next = state.slice();
    if (!next.some(item => item.ref.attachmentId === parsed.data.attachmentId)) next.push({ ref: parsed.data, seq: event.seq, time: event.time });
  }
  return next;
}
function detectMime(data) {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6))) return 'image/gif';
  fail('INVALID_IMAGE', 'Only PNG, JPEG, WebP, and GIF raster images are supported.');
}
export function decodeBase64(source, maxBytes) {
  let encoded = source.data;
  let declared = source.mediaType;
  if (encoded.startsWith('data:')) {
    const comma = encoded.indexOf(',');
    const header = encoded.slice(0, comma);
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64$/u.exec(header);
    if (comma < 0 || !match) fail('INVALID_BASE64', 'Use an image data URL with a supported media type and base64 encoding.');
    if (declared && declared !== match[1]) fail('INVALID_IMAGE', 'Declared media type does not match the data URL.');
    declared = match[1];
    encoded = encoded.slice(comma + 1);
  }
  if (!encoded.length || encoded.length > Math.ceil(maxBytes / 3) * 4 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
    fail('INVALID_BASE64', 'Image base64 is malformed or exceeds the Host image byte limit.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > maxBytes || bytes.toString('base64') !== encoded) fail('INVALID_BASE64', 'Image base64 is not canonical or exceeds the Host image byte limit.');
  const mediaType = detectMime(bytes);
  if (declared && declared !== mediaType) fail('INVALID_IMAGE', 'Declared media type does not match the image bytes.');
  return { data: bytes, mediaType, ...(safeName(source.name) ? { name: safeName(source.name) } : {}) };
}

/**
 * Install once in a Host plugin context. It owns its registrations and storage handle.
 * For isolated tests, options.core supplies the same editor-core exports; it cannot enable sends.
 */
export async function installHost(ctx, options = {}) {
  const domain = await ctx.storageDomain.open({
    name: DOMAIN_NAME, version: 1, layout: 'per-record',
    tables: { sessions: { valueSchema: SESSION_RECORD } },
  });
  const records = domain.table('sessions');
  const locks = new Map();
  const running = new Set();
  const authorizations = new Map();
  const disposers = [];
  let closed = false;
  let corePromise;
  const core = () => corePromise ??= options.core ? Promise.resolve(options.core) : import('./editor-core.js');
  const limits = () => clone(ctx.attachments.imageLimits);
  const live = agent => {
    if (!agent || typeof agent.id !== 'string' || ctx.agents.get(agent.id) !== agent) fail('SESSION_UNAVAILABLE', 'The exact receiving session is no longer active.');
  };
  const serial = async (sessionId, operation) => {
    const previous = locks.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    locks.set(sessionId, next);
    try { return await next; } finally { if (locks.get(sessionId) === next) locks.delete(sessionId); }
  };
  const track = operation => {
    if (closed) return Promise.reject(new FeedbackError('UNLOADED', 'Image feedback is not active.'));
    const promise = Promise.resolve().then(operation);
    running.add(promise);
    promise.then(() => running.delete(promise), () => running.delete(promise));
    return promise;
  };
  const readRecord = sessionId => {
    const found = records.get(keyOf(sessionId));
    if (found && found.sessionId !== sessionId) fail('SESSION_MISMATCH', 'Stored session identity does not match.');
    return found ? clone(found) : fresh(sessionId);
  };
  const history = agent => ctx.sessionProjections.stateOf(agent.session, HISTORY_KEY) ?? [];
  const findAsset = (record, assetId) => {
    const asset = record.assets.find(item => item.assetId === assetId && item.sessionId === record.sessionId);
    if (!asset) fail('ASSET_NOT_OWNED', 'This image is not registered to the receiving session. Import it from this session history first.');
    return asset;
  };
  async function putAsset(record, ref, source = 'import', event) {
    const trusted = REF.parse(ref);
    const assetId = assetIdOf(record.sessionId, trusted.attachmentId);
    const old = record.assets.find(item => item.assetId === assetId);
    if (old) return old;
    if (record.assets.length >= MAX_ASSETS) fail('ASSET_LIMIT', `This session already retains ${MAX_ASSETS} image-feedback images.`);
    const asset = { assetId, sessionId: record.sessionId, ref: trusted, source, createdAt: Date.now(), ...(event === undefined ? {} : { sourceEventSeq: event.seq }) };
    record.assets.push(asset);
    await records.put(keyOf(record.sessionId), record);
    return asset;
  }
  async function validateDraft(agent, value, record) {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded ?? '') > MAX_DRAFT_BYTES) fail('DRAFT_LIMIT', 'The feedback draft exceeds 512 KiB.');
    const editor = await core();
    const draft = editor.deserializeDraft(encoded);
    if (draft.sessionId !== agent.id) fail('SESSION_MISMATCH', 'The feedback draft belongs to a different session.');
    const asset = findAsset(record, draft.asset.assetId);
    if (draft.asset.width !== asset.ref.width || draft.asset.height !== asset.ref.height || (draft.asset.attachmentId && draft.asset.attachmentId !== asset.ref.attachmentId)) {
      fail('ASSET_MISMATCH', 'Draft dimensions or attachment identity differ from the normalized stored image. Reopen the saved image.');
    }
    return { draft, asset, editor };
  }
  async function importAsset(agent, input, admitted, record, signal) {
    if (admitted.length) {
      if (input.source || admitted.length !== 1 || admitted[0].type !== 'image') fail('INVALID_IMPORT', 'Import exactly one image, either as source or as a submitted image attachment.');
      cancelled(signal); live(agent);
      return putAsset(record, admitted[0].attachment);
    }
    if (!input.source) fail('INVALID_IMPORT', 'Provide one submitted image attachment or an import source.');
    const source = input.source;
    if (source.kind === 'history') {
      // Official authorization, not a client-supplied reference or a guessed storage path.
      const verified = await ctx.sessionController.attachment({ sessionId: agent.id, attachmentId: source.attachmentId });
      cancelled(signal); live(agent);
      const event = history(agent).find(item => item.ref.attachmentId === verified.attachment.attachmentId);
      return putAsset(record, verified.attachment, 'history', event);
    }
    const maxBytes = ctx.attachments.imageLimits.maxImageBytes;
    let candidate;
    if (source.kind === 'base64') candidate = decodeBase64(source, maxBytes);
    else {
      let bytes;
      let name = source.name;
      if (source.kind === 'bytes') {
        if (source.data.length > maxBytes) fail('IMAGE_TOO_LARGE', 'Image exceeds the Host image byte limit.');
        bytes = Uint8Array.from(source.data);
      } else {
        if (source.path.includes('\0') || /^https?:|^file:|^data:/iu.test(source.path) || /(?:^|[\\/])fakepath[\\/]/iu.test(source.path)) fail('INVALID_PATH', 'Provide a real path in the Host filesystem, not a browser fake path or URL.');
        // Resolve through the receiving Agent's composed capability, never a raw node:fs fallback.
        // The current dsh-fs-sandbox deliberately does not confine reads; provider denials propagate.
        const fs = agent.ctx?.get('fs');
        if (!fs) fail('FILESYSTEM_UNAVAILABLE', 'This session has no composed file-read capability.');
        const target = await fs.resolve(source.path, { cwd: ctx.workingDirectory.get(agent.session), signal });
        bytes = await fs.readBytes(target, signal, maxBytes);
        name ??= target.displayPath;
      }
      const mediaType = detectMime(bytes);
      if (source.mediaType && source.mediaType !== mediaType) fail('INVALID_IMAGE', 'Declared media type does not match the image bytes.');
      candidate = { data: bytes, mediaType, ...(safeName(name) ? { name: safeName(name) } : {}) };
    }
    cancelled(signal);
    const ref = await ctx.attachments.saveImage(candidate);
    cancelled(signal); live(agent);
    return putAsset(record, ref);
  }
  async function dispatch(agent, raw, signal, admitted = []) {
    live(agent); cancelled(signal);
    const input = REQUEST.parse(raw);
    if (input.sessionId !== undefined && input.sessionId !== agent.id) fail('SESSION_MISMATCH', 'The request does not match the session bound to this panel.');
    if (admitted.length && input.action !== 'import') fail('INVALID_IMPORT', 'Submitted attachments are only accepted by import.');
    return serial(agent.id, async () => {
      live(agent); cancelled(signal);
      const record = readRecord(agent.id);
      switch (input.action) {
        case 'import': {
          const asset = await importAsset(agent, input, admitted, record, signal);
          return { ok: true, asset: publicAsset(asset), limits: limits() };
        }
        case 'list': {
          const combined = new Map(record.assets.map(asset => [asset.ref.attachmentId, asset]));
          for (const item of history(agent)) if (!combined.has(item.ref.attachmentId)) {
            combined.set(item.ref.attachmentId, {
              assetId: assetIdOf(agent.id, item.ref.attachmentId), sessionId: agent.id, ref: item.ref,
              source: 'history', sourceEventSeq: item.seq, createdAt: item.time,
            });
          }
          const sorted = [...combined.values()].sort((a, b) => b.createdAt - a.createdAt || a.assetId.localeCompare(b.assetId));
          const offset = input.offset ?? 0;
          const page = sorted.slice(offset, offset + (input.limit ?? 30));
          // Only the requested page is registered; never return a preview URL we cannot serve.
          const newlyRegistered = page.filter(asset => !record.assets.some(saved => saved.assetId === asset.assetId));
          if (record.assets.length + newlyRegistered.length > MAX_ASSETS) fail('ASSET_LIMIT', `This session can retain at most ${MAX_ASSETS} image-feedback images.`);
          record.assets.push(...newlyRegistered);
          await records.put(keyOf(agent.id), record);
          return { ok: true, items: page.map(publicAsset), nextOffset: offset + page.length < sorted.length ? offset + page.length : null, total: sorted.length, limits: limits() };
        }
        case 'read': return { ok: true, asset: publicAsset(findAsset(record, input.assetId)) };
        case 'loadDraft': {
          if (input.assetId) findAsset(record, input.assetId);
          const draft = input.assetId ? record.drafts.find(item => item.assetId === input.assetId)?.draft ?? null : record.feedback.draft;
          return { ok: true, draft: clone(draft), version: record.feedback.version };
        }
        case 'saveDraft': {
          if (input.expectedVersion !== record.feedback.version) fail('DRAFT_CONFLICT', 'A newer feedback draft was saved. Reload before overwriting it.', { version: record.feedback.version });
          const draft = input.draft === null ? null : (await validateDraft(agent, input.draft, record)).draft;
          cancelled(signal); live(agent);
          const assetId = draft?.asset.assetId ?? record.feedback.draft?.asset?.assetId;
          record.drafts = record.drafts.filter(item => item.assetId !== assetId);
          if (draft) record.drafts.push({ assetId, draft });
          if (record.drafts.length > 128 || Buffer.byteLength(JSON.stringify(record.drafts)) > 8 * 1024 * 1024) fail('DRAFT_LIMIT', 'This session can retain 128 feedback drafts and at most 8 MiB of draft text.');
          record.feedback = { version: record.feedback.version + 1, draft };
          await records.put(keyOf(agent.id), record);
          return { ok: true, version: record.feedback.version };
        }
        case 'submit': {
          const { draft, asset, editor } = await validateDraft(agent, input.draft, record);
          const reference = input.referenceAssetId ? findAsset(record, input.referenceAssetId) : undefined;
          if (reference && (reference.ref.width !== asset.ref.width || reference.ref.height !== asset.ref.height)) fail('REFERENCE_DIMENSIONS', 'The numbered reference must use the same normalized pixel dimensions as the original.');
          const identity = digest(stableJSON({ draft, referenceAssetId: input.referenceAssetId ?? null, clientTimeZone: input.clientTimeZone ?? null }));
          let request = record.submissions.find(item => item.requestId === input.requestId);
          if (request && request.digest !== identity) fail('IDEMPOTENCY_CONFLICT', 'This requestId was already used for different feedback. Use a new id for a changed draft.');
          if (request?.state === 'accepted') return { ok: true, accepted: true, requestId: input.requestId, duplicate: true, durable: true };
          if (!request) {
            if (record.submissions.length >= MAX_REQUESTS) fail('SUBMISSION_LIMIT', `This session has retained ${MAX_REQUESTS} submit receipts. Existing ids may still be retried safely.`);
            request = { requestId: input.requestId, promptRequestId: `image-feedback-${digest(`${agent.id}\0${input.requestId}`)}`, digest: identity, state: 'prepared', createdAt: Date.now() };
            record.submissions.push(request);
            await records.put(keyOf(agent.id), record);
          }
          const feedback = editor.buildFeedback(draft);
          const prefix = reference ? 'Image 1 is the clean original. Image 2 is a numbered layout/location reference, not a replacement original. All coordinates below use the clean original dimensions; source is original space, destination and free annotations are layout space.\n\n' : 'The attached image is the clean original. All coordinates below use its normalized pixel dimensions. Block source rectangles are original space; destination and free annotations are layout space.\n\n';
          const content = [];
          for (const selected of reference ? [asset, reference] : [asset]) {
            const stored = await ctx.attachments.readImage(selected.ref, signal);
            content.push({ type: 'image', mediaType: stored.ref.mediaType, data: Buffer.from(stored.data).toString('base64'), ...(stored.ref.name ? { name: stored.ref.name } : {}) });
          }
          content.push({ type: 'text', text: prefix + feedback.text });
          cancelled(signal); live(agent);
          // Official Session admission owns model modality checks, queueing and durable rpcId dedup.
          const receipt = await ctx.sessionController.prompt({
            requestId: request.promptRequestId, sessionId: agent.id, mode: 'queue', content,
            ...(input.clientTimeZone ? { clientTimeZone: input.clientTimeZone } : {}),
          }, signal);
          if (receipt?.accepted !== true) fail('PROMPT_NOT_ACCEPTED', 'The Host did not acknowledge this feedback prompt.');
          // Acceptance is not completion. A flush failure never pretends the already accepted prompt failed.
          let durable = false;
          try { durable = await ctx.sessions.flush(agent.session); } catch { /* Safe retry keeps the same official request id. */ }
          let receiptSaved = false;
          if (durable) {
            request.state = 'accepted';
            try { await records.put(keyOf(agent.id), record); receiptSaved = true; } catch { /* The official rpcId remains the retry authority. */ }
          }
          return { ok: true, accepted: true, requestId: input.requestId, duplicate: false, durable,
            ...(durable && receiptSaved ? {} : { warning: 'The Host accepted the feedback, but a Session checkpoint or plugin receipt was not confirmed. Retry only with the same requestId.' }) };
        }
      }
    });
  }
  const execute = (agent, raw, signal, admitted = []) => track(() => {
    live(agent); // withInitiator supplies attribution, not authority: validate exact liveness first.
    return ctx.agents.withInitiator(agent, () => dispatch(agent, raw, signal, admitted));
  }).catch(errorValue);
  async function authorize(request) {
    const headers = { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' };
    const admission = ctx.connection.admit({ headers: request.headers });
    if ('rejection' in admission || admission.peer.principal.kind !== 'owner') return new Response(JSON.stringify({ error: 'Owner authentication required.' }), { status: 'rejection' in admission ? admission.rejection : 403, headers });
    const parsedId = ID.safeParse(new URL(request.url).searchParams.get('sessionId'));
    if (!parsedId.success) return new Response(JSON.stringify({ error: 'A session identity is required.' }), { status: 400, headers });
    const sessionId = parsedId.data;
    let agent = ctx.agents.get(sessionId);
    if (!agent) {
      // Cold draft restore must not require sending a chat message. This official lookup resumes only an existing session.
      const resolved = await ctx.sessionController.resolveAgent(sessionId);
      if ('error' in resolved) return new Response(JSON.stringify({ error: resolved.error.message }), { status: 409, headers });
      agent = resolved.agent;
    }
    const now = Date.now();
    for (const [token, value] of authorizations) if (value.expiresAt <= now || ctx.agents.get(value.agent.id) !== value.agent) authorizations.delete(token);
    if (authorizations.size >= 128) authorizations.delete(authorizations.keys().next().value);
    const authorization = randomBytes(32).toString('hex');
    const expiresAt = now + AUTH_TTL_MS;
    authorizations.set(authorization, { agent, expiresAt });
    return new Response(JSON.stringify({ authorization, expiresAt }), { headers });
  }
  function authorizeCommand(agent, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_REQUEST', 'Provide a JSON image-feedback operation.');
    const grant = typeof input.authorization === 'string' ? authorizations.get(input.authorization) : undefined;
    if (!grant || grant.agent !== agent || grant.expiresAt <= Date.now()) fail('OWNER_AUTH_REQUIRED', 'Open the image-feedback panel in the authenticated owner GUI to authorize this session.');
    const { authorization: _authorization, ...operation } = input;
    return operation;
  }
  async function serveImage(request) {
    const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'" };
    const reject = (status, message) => new Response(request.method === 'HEAD' ? null : message, { status, headers });
    // The shared /api channel authenticates first. Re-admit to establish an explicit principal.
    const admission = ctx.connection.admit({ headers: request.headers });
    if ('rejection' in admission) return reject(admission.rejection, 'Authentication required.');
    if (admission.peer.principal.kind !== 'owner') return reject(403, 'Image feedback binary previews are owner-only.');
    try {
      const url = new URL(request.url);
      const sessionId = ID.parse(url.searchParams.get('sessionId'));
      const assetId = ID.parse(url.searchParams.get('assetId'));
      const asset = findAsset(readRecord(sessionId), assetId);
      const stored = await ctx.attachments.readImage(asset.ref, request.signal);
      return new Response(request.method === 'HEAD' ? null : stored.data.slice(), {
        headers: { ...headers, 'Content-Type': stored.ref.mediaType, 'Content-Length': String(stored.data.byteLength) },
      });
    } catch (error) {
      return reject(error instanceof z.ZodError ? 400 : error?.code === 'ASSET_NOT_OWNED' ? 404 : 500, 'Image is unavailable for this session.');
    }
  }
  try {
    disposers.push(ctx.sessionProjections.register({
      key: HISTORY_KEY, stateVersion: 1,
      stateSchema: z.array(z.object({ ref: REF, seq: z.number().int().nonnegative(), time: z.number() })),
      init: () => [], apply: historicalImages,
    }));
    disposers.push(ctx.commands.register({
      name: COMMAND_NAME, definitionId: '@yyyzl/dsh-image-feedback/operations',
      description: 'Import session images, retain image feedback drafts, or independently submit image feedback.',
      input: { hint: 'JSON image-feedback operation', attachments: true }, recordInput: false,
      handler: async ({ agent, rawInput, attachments, signal }) => {
        let result;
        try {
          // Large image bytes belong in submittedAttachments. Base64 is also accepted for tools and data-URL imports.
          if (Buffer.byteLength(rawInput) > Math.ceil(ctx.attachments.imageLimits.maxImageBytes / 3) * 4 + MAX_DRAFT_BYTES) fail('REQUEST_LIMIT', 'Image-feedback request exceeds the Host byte limit.');
          const input = authorizeCommand(agent, JSON.parse(rawInput));
          result = await execute(agent, input, signal, attachments);
        } catch (error) { result = errorValue(error); }
        return { kind: result.ok ? 'success' : 'error', text: JSON.stringify(result) };
      },
    }));
    disposers.push(ctx.tools.register({
      name: TOOL_NAME,
      description: 'Manage images and image-feedback drafts in your own session. Import, list, read, save/load drafts, or submit the clean image and feedback as an independent queued prompt. Submit only when the user asks; it leaves the composer untouched.',
      parameters: {
        type: 'object', properties: {
          action: { type: 'string', enum: ['import', 'list', 'read', 'loadDraft', 'saveDraft', 'submit'] },
          sessionId: { type: 'string', description: 'Omit for your session. A different session is rejected.' },
          source: { type: 'object', description: 'For import: {kind:"path",path}, {kind:"history",attachmentId}, {kind:"base64",data,mediaType?,name?}, or {kind:"bytes",data:[0..255],mediaType?,name?}.' },
          assetId: { type: 'string', description: 'For read or an optional per-image loadDraft, an assetId returned by import or list.' },
          offset: { type: 'integer', description: 'For list, zero-based offset; default 0.' },
          limit: { type: 'integer', description: 'For list, 1–100; default 30.' },
          draft: { type: ['object', 'null'], description: 'For saveDraft/submit, a harness-image-feedback-1 draft using the returned normalized asset dimensions. Null clears a saved draft.' },
          expectedVersion: { type: 'integer', description: 'For saveDraft, the version returned by loadDraft or the last save.' },
          requestId: { type: 'string', description: 'For submit, a unique id retained unchanged for retries of this exact draft.' },
          referenceAssetId: { type: 'string', description: 'Optional submit image: numbered layout reference already imported into this session at original dimensions.' },
          clientTimeZone: { type: 'string', description: 'Optional submit IANA time zone.' },
        }, required: ['action'], additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => {
          if (args?.action === 'read' && value.ok && value.asset) {
            const { attachmentId, mediaType, bytes, width, height, name, originalDimensions } = value.asset;
            return [{ type: 'text', text: JSON.stringify(value) }, { type: 'image', attachment: { attachmentId, mediaType, bytes, width, height, ...(name ? { name } : {}), ...(originalDimensions ? { originalDimensions } : {}) } }];
          }
          return [{ type: 'text', text: JSON.stringify(value) }];
        },
      },
      execute: (args, exec) => execute(exec.agent, args, exec.signal),
      isConcurrencySafe: () => false,
    }));
    disposers.push(ctx.connection.fetch.register({ path: IMAGE_ROUTE, methods: ['GET', 'HEAD'], requestBody: 'buffered', fetch: request => track(() => serveImage(request)) }));
    disposers.push(ctx.connection.fetch.register({ path: AUTH_ROUTE, methods: ['GET'], requestBody: 'buffered', fetch: request => track(() => authorize(request)) }));
  } catch (error) {
    closed = true;
    for (const dispose of disposers.reverse()) await dispose();
    await domain.close();
    throw error;
  }
  const dispose = async () => {
    if (closed) return;
    closed = true;
    for (const close of disposers.reverse()) await close();
    await Promise.allSettled([...running]);
    authorizations.clear();
    await domain.close();
  };
  ctx.effect(() => dispose);
  return Object.freeze({ execute, dispose });
}
export const apply = installHost;
