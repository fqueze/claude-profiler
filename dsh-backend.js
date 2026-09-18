// The DSH backend for the session picker. DSH keeps one append-only session log
// per session under ~/.dsh/sessions/<project>/<session>/session.vN.jsonl.zstd,
// a concatenated-Zstandard container whose records carry timestamps, model
// usage and the OpenRouter generation id of every model call.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

// A gap longer than this is the session waiting for its user rather than
// working, the same distinction the Claude and Codex backends draw.
const ACTIVE_GAP = 60 * 1000;

// The canonical generation log names: session.jsonl for format zero, then
// session.vN.jsonl, each optionally Zstandard-compressed. Temporary and
// legacy-named files are deliberately not matched.
const LOG_NAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/;

function dshDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function statSafe(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

// The current generation of one session directory. A directory can hold more
// than one physical format generation after a migration; the highest version is
// the live one, and the compressed form wins a tie because that is what the
// current writer emits.
function currentLog(dir) {
  let best = null;
  for (const name of fs.readdirSync(dir)) {
    const match = LOG_NAME.exec(name);
    if (!match) continue;

    const version = match[1] ? Number(match[1]) : 0;
    const compressed = name.endsWith('.zstd');
    if (!best || version > best.version ||
        (version === best.version && compressed && !best.compressed)) {
      best = { version, compressed, file: path.join(dir, name) };
    }
  }
  return best?.file || null;
}

// Every session log below ~/.dsh/sessions, sub-agent sessions included: they
// are ordinary sessions with a parent recorded in their header.
function findSessionFiles(root = dshDir()) {
  const sessionsRoot = path.join(root, 'sessions');
  if (!statSafe(sessionsRoot)?.isDirectory()) return [];

  const files = [];
  for (const project of fs.readdirSync(sessionsRoot)) {
    const projectDir = path.join(sessionsRoot, project);
    if (!statSafe(projectDir)?.isDirectory()) continue;

    for (const session of fs.readdirSync(projectDir)) {
      const dir = path.join(projectDir, session);
      if (!statSafe(dir)?.isDirectory()) continue;

      const file = currentLog(dir);
      if (file) files.push(file);
    }
  }
  return files;
}

const ZSTD_MAGIC = 0xFD2FB528;

// Locate the structurally complete Zstandard frames in a concatenated stream
// without decompressing them. A live writer appends whole frames, so EOF can
// interrupt only the last one; returning its start rather than throwing is what
// keeps a session being written to readable.
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid Zstandard frame magic at byte ${offset}`);
    }
    offset += 4;

    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`reserved Zstandard frame-header bit at byte ${offset - 1}`);
    }

    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) {
        throw new Error(`reserved Zstandard block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }

  return { frames };
}

// Whatever the interrupted final frame already contains. `ZSTD_e_flush` asks
// the decoder to stop at the end of the available input instead of demanding a
// finished frame, and a frame too damaged even for that yields nothing.
function decompressTorn(buffer) {
  try {
    return zlib.zstdDecompressSync(buffer, {
      finishFlush: zlib.constants.ZSTD_e_flush
    });
  } catch {
    return Buffer.alloc(0);
  }
}

function decompressZstd(buffer) {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error('this Node.js cannot read Zstandard session logs');
  }

  const { frames, tornStart } = scanZstdFrames(buffer);
  const parts = frames.map(({ start, end }) =>
    zlib.zstdDecompressSync(buffer.subarray(start, end)));
  if (tornStart !== undefined) parts.push(decompressTorn(buffer.subarray(tornStart)));
  return Buffer.concat(parts).toString('utf8');
}

function readJsonlText(text) {
  const lines = text.split('\n').filter(Boolean);
  return lines.map((line, i) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      // The last write of a live session can be observed halfway through. Its
      // complete records are still a valid summary; corruption in the middle
      // of a file is not.
      if (i === lines.length - 1) return null;
      throw error;
    }
  }).filter(Boolean);
}

// One session's records, oldest first. Reads the whole log: DSH's own
// projections do the same, and a session that has to be summarized has to be
// read anyway.
function readSessionFile(file) {
  const buffer = fs.readFileSync(file);
  const text = file.endsWith('.zstd')
    ? decompressZstd(buffer)
    : buffer.toString('utf8');
  return readJsonlText(text);
}

function emptyUsage() {
  return {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    totalTokens: 0
  };
}

function addUsage(into, usage) {
  for (const key of Object.keys(into)) into[key] += usage?.[key] || 0;
}

function addModels(into, models) {
  for (const [model, usage] of Object.entries(models)) {
    addUsage(into[model] ||= emptyUsage(), usage);
  }
}

// DSH's inputTokens is the newly processed input and is disjoint from
// cacheReadTokens, unlike Codex's cached-input subset. totalTokens is recorded
// but recomputed when absent, because a provider may omit it.
function messageUsage(entry) {
  const usage = entry.data?.usage;
  if (!usage) return null;

  const inputTokens = usage.inputTokens || 0;
  const cacheReadTokens = usage.cacheReadTokens || 0;
  const outputTokens = usage.outputTokens || 0;
  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens || 0,
    outputTokens,
    totalTokens: usage.totalTokens ?? inputTokens + cacheReadTokens + outputTokens
  };
}

function textBlocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => block?.text || '').filter(Boolean).join('\n');
}

function titleLine(message) {
  const firstLine = String(message).trim().split('\n')[0];
  if (!firstLine) return null;
  return firstLine.length > 100 ? `${firstLine.slice(0, 99)}…` : firstLine;
}

function firstUserMessage(entries) {
  const message = entries.find(entry =>
    entry.type === 'user/message' && textBlocks(entry.data?.content)
  );
  if (message) return titleLine(textBlocks(message.data.content));

  // A seeded or resumed session can have its first prompt spliced into the
  // inbox rather than recorded as a user message of its own.
  for (const entry of entries) {
    if (entry.type !== 'agent/inbox/spliced') continue;
    const inserted = entry.data?.inserted || [];
    const sourced = inserted.find(item => item.source?.kind === 'user' &&
      textBlocks(item.content));
    if (sourced) return titleLine(textBlocks(sourced.content));
  }
  return null;
}

// The project directory key replaces separators with dashes and escapes other
// characters, so it is lossy; the header's cwd is the real answer and this is
// only the fallback for a session whose header has none.
function projectLabel(project) {
  const slug = project.replace(/^--/, '').replace(/--$/, '');
  return `/${slug.replace(/-/g, '/')}`;
}

// One row of the table, from a single pass over the session's own records.
// Sub-agent usage is folded in by listSessions.
function summarizeSession(file) {
  const stat = statSafe(file);
  const entries = readSessionFile(file);
  const header = entries.find(entry => entry.type === 'session') || {};
  const id = header.id || path.basename(path.dirname(file));
  const createdAt = Number.isFinite(header.createdAt) ? header.createdAt : null;

  let started = createdAt;
  let ended = null;
  let active = 0;
  let previous = null;
  let title = null;
  let model = '';
  let messages = 0;
  const models = {};
  const billingCalls = [];
  const usage = emptyUsage();

  for (const entry of entries) {
    const at = Number.isFinite(entry.time) ? entry.time : null;
    if (at !== null) {
      if (started === null) started = at;
      ended = at;
      if (previous !== null && at > previous && at - previous <= ACTIVE_GAP) {
        active += at - previous;
      }
      previous = at;
    }

    // The last title wins: session/title is rewritten as the provider's own
    // title replaces the fallback one.
    if (entry.type === 'session/title' && entry.data?.title) {
      title = entry.data.title;
    }
    if (entry.type === 'request/context' && entry.data?.model) {
      model = entry.data.model;
    }
    if (entry.type === 'user/message') {
      messages++;
    }

    if (entry.type === 'assistant/message') {
      messages++;
      const source = entry.data?.message?.source;
      const messageModel = source?.model || model || 'Unknown model';
      model = source?.model || model;
      const messageTokens = messageUsage(entry);
      if (messageTokens) {
        addUsage(usage, messageTokens);
        addUsage(models[messageModel] ||= emptyUsage(), messageTokens);
        billingCalls.push({
          responseId: source?.replayState?.response?.responseId || null,
          model: messageModel
        });
      }
    }
  }

  const project = path.basename(path.dirname(path.dirname(file)));
  const fallbackTime = stat?.mtime.toISOString() || null;
  return {
    provider: 'dsh',
    id,
    file,
    title: title || firstUserMessage(entries) || 'DSH session',
    cwd: header.cwd || projectLabel(project),
    gitBranch: '',
    model,
    version: '',
    started: started !== null ? new Date(started).toISOString() : fallbackTime,
    ended: ended !== null
      ? new Date(ended).toISOString()
      : started !== null ? new Date(started).toISOString() : fallbackTime,
    active,
    messages,
    entries: entries.length,
    bytes: stat?.size || 0,
    subagents: 0,
    tokens: usage.totalTokens,
    usage,
    models,
    credits: null,
    cost: null,
    profileAvailable: true,
    parentId: header.parentSession || null,
    billingCalls
  };
}

// Every session, newest first, with each sub-agent charged to its root.
function listSessions({ root = dshDir() } = {}) {
  const sessions = [];
  for (const file of findSessionFiles(root)) {
    try {
      sessions.push(summarizeSession(file));
    } catch {
      // A live or corrupt session should not take down the combined picker.
    }
  }

  const byId = new Map(sessions.map(session => [session.id, session]));
  const roots = sessions.filter(session =>
    !session.parentId && (session.messages > 0 || session.tokens > 0));
  const rootIds = new Set(roots.map(session => session.id));

  for (const session of sessions) {
    if (!session.parentId) continue;

    // Charge every descendant to the visible root even when a sub-agent spawned
    // sub-agents of its own. Looking the chain up first makes this independent
    // of filesystem traversal order.
    let root = byId.get(session.parentId);
    const seen = new Set([session.id]);
    while (root?.parentId && !seen.has(root.id)) {
      seen.add(root.id);
      root = byId.get(root.parentId);
    }
    if (!root || !rootIds.has(root.id)) continue;

    root.subagents++;
    root.bytes += session.bytes;
    root.entries += session.entries;
    addUsage(root.usage, session.usage);
    addModels(root.models, session.models);
    root.tokens = root.usage.totalTokens;
    root.billingCalls.push(...session.billingCalls);
  }

  return roots.sort((a, b) => (b.ended || '').localeCompare(a.ended || ''));
}

// Read one root session and every sub-agent descended from it. Profiles need
// the individual logs rather than the aggregate used by the picker.
function sessionTree(id, { root = dshDir() } = {}) {
  const sessions = findSessionFiles(root).map(file => {
    try {
      return summarizeSession(file);
    } catch {
      return null;
    }
  }).filter(Boolean);
  const byId = new Map(sessions.map(session => [session.id, session]));
  const selected = byId.get(id);
  if (!selected) return null;

  let rootSession = selected;
  const seen = new Set();
  while (rootSession.parentId && !seen.has(rootSession.id)) {
    seen.add(rootSession.id);
    rootSession = byId.get(rootSession.parentId);
    if (!rootSession) return null;
  }

  const belongsToRoot = (session) => {
    let current = session;
    const chain = new Set();
    while (current?.parentId && !chain.has(current.id)) {
      chain.add(current.id);
      current = byId.get(current.parentId);
    }
    return current?.id === rootSession.id;
  };

  return sessions.filter(belongsToRoot).map(session => ({
    session,
    entries: readSessionFile(session.file)
  }));
}

// How fresh a root session is, as the newest mtime among its own log and its
// sub-agents'. This is what the profile cache is keyed on, so that a session
// worked in since the page was drawn is rebuilt instead of served from before.
function sessionStamp(id, { root = dshDir() } = {}) {
  const tree = sessionTree(id, { root });
  if (!tree) return null;

  const times = tree.map(({ session }) => statSafe(session.file)?.mtimeMs)
    .filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

// OpenRouter remembers what every generation cost. DSH records the generation
// id of each model call, so this is exact billing rather than a reconstructed
// estimate. The generation metadata is immutable once written, which is what
// makes a process-lifetime cache safe.
const OPENROUTER_GENERATION_ENDPOINT = 'https://openrouter.ai/api/v1/generation';
const OPENROUTER_TIMEOUT_MS = 10000;
const OPENROUTER_CONCURRENCY = 8;
const generationCosts = new Map();

// The key DSH uses for OpenRouter: the environment first, then the reference
// the credentials service stores in ~/.dsh/.credentials.yaml.
function openRouterKey(root = dshDir()) {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;

  try {
    const yaml = fs.readFileSync(path.join(root, '.credentials.yaml'), 'utf8');
    return yaml.match(/^\s*OPENROUTER_API_KEY:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1] || null;
  } catch {
    return null;
  }
}

async function fetchGenerationCost(id, { key, fetchImpl }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
  try {
    const response = await fetchImpl(
      `${OPENROUTER_GENERATION_ENDPOINT}?id=${encodeURIComponent(id)}`,
      {
        redirect: 'error',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${key}` }
      });
    if (!response.ok) return null;

    const data = (await response.json())?.data;
    return Number.isFinite(data?.total_cost)
      ? { cost: data.total_cost, model: data.model || null }
      : null;
  } catch {
    // A generation can be too new to be indexed yet, or the network can be
    // down; either way this call stays unbilled rather than counted as free.
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Run `load` over every item with at most `limit` requests in flight, keeping
// the results in the order the items were given.
async function mapLimit(items, limit, load) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await load(items[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Cost per OpenRouter generation id, for the ids that resolve. This is
// deliberately best-effort: local token history remains useful offline, when
// signed out, and for a provider that is not OpenRouter at all.
async function fetchBilling(ids, {
  root = dshDir(), fetchImpl = globalThis.fetch, useCache = true
} = {}) {
  const billing = new Map();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return billing;
  if (process.env.CLAUDE_PROFILER_OFFLINE === '1') return billing;
  if (typeof fetchImpl !== 'function') return billing;

  const pending = [];
  for (const id of unique) {
    const cached = useCache && generationCosts.get(id);
    if (cached) billing.set(id, cached);
    else pending.push(id);
  }

  const key = pending.length > 0 ? openRouterKey(root) : null;
  if (!key) return billing;

  const rows = await mapLimit(pending, OPENROUTER_CONCURRENCY,
    id => fetchGenerationCost(id, { key, fetchImpl }));
  rows.forEach((row, index) => {
    if (!row) return;
    if (useCache) generationCosts.set(pending[index], row);
    billing.set(pending[index], row);
  });
  return billing;
}

// Charge each session the exact OpenRouter cost of every generation it made.
// A session only reports a cost when every one of its model calls resolved:
// publishing a partial total would understate the expensive sessions, which are
// exactly the ones worth looking at.
async function addBilling(sessions, options = {}) {
  const calls = sessions.flatMap(session => session.billingCalls || []);
  const billing = await fetchBilling(calls.map(call => call.responseId), options);

  for (const session of sessions) {
    const sessionCalls = session.billingCalls || [];
    if (sessionCalls.length === 0) continue;

    // One model call can be replayed into more than one record; bill the
    // generation once and attribute it to the model that made it.
    const modelByGeneration = new Map();
    const complete = sessionCalls.every(call => {
      if (!call.responseId) return false;
      if (!modelByGeneration.has(call.responseId)) {
        modelByGeneration.set(call.responseId, call.model);
      }
      return true;
    });
    if (!complete) continue;

    let total = 0;
    let billed = true;
    const costByModel = new Map();
    for (const [generation, model] of modelByGeneration) {
      const row = billing.get(generation);
      if (!row) {
        billed = false;
        break;
      }
      total += row.cost;
      costByModel.set(model, (costByModel.get(model) || 0) + row.cost);
    }
    if (!billed) continue;

    session.cost = total;
    for (const [model, cost] of costByModel) {
      if (session.models[model]) session.models[model].cost = cost;
    }
  }
  return sessions;
}

async function listSessionsWithUsage(options = {}) {
  return addBilling(listSessions(options), options);
}

module.exports = {
  findSessionFiles,
  listSessions,
  listSessionsWithUsage,
  addBilling,
  fetchBilling,
  summarizeSession,
  sessionTree,
  sessionStamp,
  projectLabel,
  openRouterKey,
  dshDir
};
