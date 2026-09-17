// The Codex backend for the session picker. Codex stores one JSONL rollout per
// thread under ~/.codex/sessions/YYYY/MM/DD and keeps human titles separately
// in session_index.jsonl.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ACTIVE_GAP = 60 * 1000;
const THREAD_USAGE_ENDPOINT =
  'https://chatgpt.com/backend-api/wham/usage/thread_usage/query';
const THREAD_USAGE_BATCH_SIZE = 100;
const THREAD_USAGE_TIMEOUT_MS = 10000;

function codexDir() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function statSafe(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function jsonlFilesBelow(root) {
  if (!statSafe(root)?.isDirectory()) return [];

  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      const stat = statSafe(file);
      if (stat?.isDirectory()) pending.push(file);
      if (stat?.isFile() && name.endsWith('.jsonl')) files.push(file);
    }
  }
  return files;
}

function findSessionFiles(root = codexDir()) {
  return [
    ...jsonlFilesBelow(path.join(root, 'sessions')),
    ...jsonlFilesBelow(path.join(root, 'archived_sessions'))
  ];
}

function readJsonlFile(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
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

function sessionTitles(root = codexDir()) {
  const titles = new Map();
  const file = path.join(root, 'session_index.jsonl');
  if (!statSafe(file)?.isFile()) return titles;

  // A live Codex can be halfway through appending its last line. Earlier title
  // records are still useful, so a malformed line is ignored on its own.
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.id && entry.thread_name) titles.set(entry.id, entry.thread_name);
    } catch {
      // Keep the titles parsed before this line.
    }
  }
  return titles;
}

function firstUserMessage(entries) {
  const completed = entries.find(entry =>
    entry.type === 'event_msg' && entry.payload?.type === 'item_completed' &&
    entry.payload.item?.type === 'UserMessage'
  );
  const completedText = completed?.payload.item.content?.find(
    block => block.type === 'text'
  )?.text;
  if (completedText) return titleLine(completedText);

  const event = entries.find(entry =>
    entry.type === 'event_msg' && entry.payload?.type === 'user_message' &&
    typeof entry.payload.message === 'string'
  );
  if (!event) return 'Codex session';

  return titleLine(event.payload.message);
}

function titleLine(message) {
  const firstLine = message.trim().split('\n')[0];
  if (!firstLine) return 'Codex session';
  return firstLine.length > 100 ? `${firstLine.slice(0, 99)}…` : firstLine;
}

function emptyUsage() {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0
  };
}

function copyUsage(usage) {
  const result = emptyUsage();
  for (const key of Object.keys(result)) result[key] = usage?.[key] || 0;
  return result;
}

function addUsage(into, usage) {
  for (const key of Object.keys(into)) into[key] += usage?.[key] || 0;
}

function summarizeSession(file, titles = new Map()) {
  const stat = statSafe(file);
  const entries = readJsonlFile(file);
  const meta = entries.find(entry => entry.type === 'session_meta')?.payload || {};
  const basename = path.basename(file, '.jsonl');
  const id = meta.id || meta.session_id ||
    basename.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i)?.[0] || basename;

  let started = meta.timestamp || null;
  let ended = null;
  let cwd = meta.cwd || '';
  let model = '';
  let active = 0;
  let previous = null;
  let completedMessages = 0;
  let legacyMessages = 0;
  let usage = null;

  for (const entry of entries) {
    if (entry.timestamp) {
      started = started || entry.timestamp;
      ended = entry.timestamp;
      const at = new Date(entry.timestamp).getTime();
      if (previous !== null && at > previous && at - previous <= ACTIVE_GAP) {
        active += at - previous;
      }
      previous = at;
    }

    if (entry.type === 'turn_context') {
      cwd = entry.payload?.cwd || cwd;
      model = entry.payload?.model || model;
    }
    if (entry.type === 'event_msg' && entry.payload?.type === 'item_completed' &&
        ['UserMessage', 'AgentMessage'].includes(entry.payload.item?.type)) {
      completedMessages++;
    }
    if (entry.type === 'event_msg' &&
        ['user_message', 'agent_message'].includes(entry.payload?.type)) {
      legacyMessages++;
    }

    // Both generations are present in current logs. token_usage_record is the
    // durable record; older sessions only have event_msg/token_count. In both,
    // the thread total is cumulative, so the last snapshot is the session sum.
    if (entry.type === 'token_usage_record' && entry.payload?.thread_token_usage) {
      usage = copyUsage(entry.payload.thread_token_usage);
    } else if (entry.type === 'event_msg' && entry.payload?.type === 'token_count' &&
               entry.payload.info?.total_token_usage) {
      usage = copyUsage(entry.payload.info.total_token_usage);
    }
  }

  usage ||= emptyUsage();
  const source = meta.source;
  const parentId = source && typeof source === 'object'
    ? source.subagent?.thread_spawn?.parent_thread_id || null
    : null;

  return {
    provider: 'codex',
    id,
    file,
    title: titles.get(id) || firstUserMessage(entries),
    cwd: cwd || 'Unknown working directory',
    gitBranch: meta.git?.branch || '',
    model,
    version: meta.cli_version || '',
    started: started || stat?.mtime.toISOString() || null,
    ended: ended || started || stat?.mtime.toISOString() || null,
    active,
    messages: completedMessages || legacyMessages,
    entries: entries.length,
    bytes: stat?.size || 0,
    subagents: 0,
    tokens: usage.total_tokens,
    usage,
    credits: null,
    cost: null,
    profileAvailable: false,
    parentId,
    internal: meta.thread_source === 'guardian_review',
    billingThreadIds: [id]
  };
}

function listSessions({ root = codexDir() } = {}) {
  const titles = sessionTitles(root);
  const sessions = [];
  for (const file of findSessionFiles(root)) {
    try {
      sessions.push(summarizeSession(file, titles));
    } catch {
      // A live or corrupt session should not take down the combined picker.
    }
  }

  const byId = new Map(sessions.map(session => [session.id, session]));
  const roots = sessions.filter(session =>
    !session.parentId && !session.internal && (session.messages > 0 || session.tokens > 0)
  );
  for (const session of sessions) {
    if (!session.parentId) continue;

    // Charge every descendant to the visible root even when subagents spawned
    // subagents of their own. Looking the chain up first makes this independent
    // of filesystem traversal order.
    let root = byId.get(session.parentId);
    const seen = new Set([session.id]);
    while (root?.parentId && !seen.has(root.id)) {
      seen.add(root.id);
      root = byId.get(root.parentId);
    }
    if (!root || root.internal) continue;

    root.subagents++;
    root.bytes += session.bytes;
    root.entries += session.entries;
    addUsage(root.usage, session.usage);
    root.tokens = root.usage.total_tokens;
    root.billingThreadIds.push(session.id);
  }

  return roots.sort((a, b) => (b.started || '').localeCompare(a.started || ''));
}

function billingAuth(root) {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(root, 'auth.json'), 'utf8'));
    const accessToken = auth.tokens?.access_token;
    const accountId = auth.tokens?.account_id;
    return accessToken && accountId ? { accessToken, accountId } : null;
  } catch {
    return null;
  }
}

// The same authoritative per-thread estimate that Codex exposes as
// `thread-credits` and `estimated-thread-cost` in its status line. This is
// deliberately best-effort: local history remains useful when offline, when
// auth is stored somewhere other than auth.json, or when an old thread is no
// longer available to the billing service.
async function addBillingEstimates(sessions, {
  root = codexDir(), fetchImpl = globalThis.fetch
} = {}) {
  if (process.env.CLAUDE_PROFILER_OFFLINE === '1') return sessions;
  const auth = billingAuth(root);
  if (!auth || typeof fetchImpl !== 'function') return sessions;

  const ids = [...new Set(sessions.flatMap(session => session.billingThreadIds))];
  const estimates = new Map();
  for (let offset = 0; offset < ids.length; offset += THREAD_USAGE_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + THREAD_USAGE_BATCH_SIZE);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), THREAD_USAGE_TIMEOUT_MS);
    try {
      const response = await fetchImpl(THREAD_USAGE_ENDPOINT, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          'ChatGPT-Account-Id': auth.accountId,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ thread_ids: batch })
      });
      if (!response.ok) continue;
      const body = await response.json();
      const requested = new Set(batch);
      const returned = new Set();
      if (!Array.isArray(body.threads) || body.threads.some(
        row => !requested.has(row.thread_id) || !returned.add(row.thread_id)
      )) {
        continue;
      }
      for (const row of body.threads) {
        if (Number.isSafeInteger(row.estimated_usage_credits_micros)) {
          estimates.set(row.thread_id, row);
        }
      }
    } catch {
      // Token counts from disk are the fallback.
    } finally {
      clearTimeout(timeout);
    }
  }

  for (const session of sessions) {
    const rows = session.billingThreadIds.map(id => estimates.get(id));
    // Omitted rows mean unavailable, not zero. Do not publish a partial total.
    if (rows.some(row => !row)) continue;

    const creditsMicros = rows.reduce(
      (sum, row) => sum + row.estimated_usage_credits_micros, 0);
    session.credits = creditsMicros / 1000000;
    if (rows.every(row => Number.isSafeInteger(row.estimated_usage_usd_micros))) {
      session.cost = rows.reduce(
        (sum, row) => sum + row.estimated_usage_usd_micros, 0) / 1000000;
    }
  }
  return sessions;
}

async function listSessionsWithUsage(options = {}) {
  const sessions = listSessions(options);
  return addBillingEstimates(sessions, options);
}

module.exports = {
  findSessionFiles,
  listSessions,
  listSessionsWithUsage,
  addBillingEstimates,
  summarizeSession,
  sessionTitles
};
