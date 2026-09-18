const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const {
  findSessionFiles, listSessions, listSessionsWithUsage, summarizeSession,
  sessionTree, sessionStamp, projectLabel
} = require('./dsh-backend.js');
const { renderPage } = require('./session-index.js');

let failures = 0;
function check(name, actual, expected) {
  try {
    assert.deepStrictEqual(actual, expected);
    console.log(`ok   ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${name}`);
    console.log(`  actual:   ${JSON.stringify(actual)}`);
    console.log(`  expected: ${JSON.stringify(expected)}`);
  }
}

function frame(records) {
  return zlib.zstdCompressSync(
    Buffer.from(records.map(JSON.stringify).join('\n') + '\n'));
}

function writeSession(root, project, id, records, name = 'session.v3.jsonl.zstd') {
  const dir = path.join(root, 'sessions', project, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, frame(records));
  return file;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-backend-test-'));

const ROOT_ID = 'session-11111111-1111-4111-8111-111111111111';
const CHILD_ID = 'session-22222222-2222-4222-8222-222222222222';
const CREATED = 1700000000000;

const rootFile = writeSession(root, '--work-project--', ROOT_ID, [
  { type: 'session', version: 3, id: ROOT_ID, createdAt: CREATED,
    cwd: '/work/project', isSeeded: false, delegationDepth: 0 },
  { type: 'user/message', seq: 1, time: CREATED + 1000,
    data: { role: 'user', id: 'u1', source: { kind: 'user' },
      content: [{ type: 'text', text: 'Fix the thing\nwith more detail' }] } },
  { type: 'request/context', seq: 2, time: CREATED + 2000,
    data: { provider: 'openrouter', model: 'deepseek/test', contextWindow: 1000 } },
  { type: 'assistant/message', seq: 3, time: CREATED + 5000, data: {
    turn: 1, step: 1,
    message: { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'done' }],
      source: { kind: 'model', provider: 'openrouter', model: 'deepseek/test',
        replayState: { response: { kind: 'pi-ai', responseId: 'gen-abc' } } } },
    usage: { inputTokens: 100, cacheReadTokens: 400, outputTokens: 50, totalTokens: 550 }
  } },
  { type: 'session/title', seq: 4, time: CREATED + 6000,
    data: { title: 'A generated title', messageSeqs: [1], source: { kind: 'provider' } } }
]);
// A session is append-only; the trailing frame is torn on a live writer.
fs.appendFileSync(rootFile, frame([
  { type: 'system/message', seq: 5, time: CREATED + 7000,
    data: { turn: 1, step: 1, message: 'ignored' } }
]).subarray(0, 20));

writeSession(root, '--work-project--', CHILD_ID, [
  { type: 'session', version: 3, id: CHILD_ID, createdAt: CREATED + 10000,
    cwd: '/work/project', parentSession: ROOT_ID, origin: 'subagent',
    delegationDepth: 1 },
  { type: 'assistant/message', seq: 1, time: CREATED + 11000, data: {
    turn: 1, step: 1,
    message: { role: 'assistant', id: 'a2', content: [],
      source: { kind: 'model', provider: 'openrouter', model: 'deepseek/child',
        replayState: { response: { kind: 'pi-ai', responseId: 'gen-child' } } } },
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
  } }
]);

// A migrated directory holds more than one format generation; the highest wins.
const migrated = path.join(root, 'sessions', '--work-other--',
  'session-33333333-3333-4333-8333-333333333333');
fs.mkdirSync(migrated, { recursive: true });
fs.writeFileSync(path.join(migrated, 'session.jsonl'), JSON.stringify(
  { type: 'session', version: 1, id: 'session-old', createdAt: CREATED }));
fs.writeFileSync(path.join(migrated, 'session.v3.jsonl.zstd'), frame([
  { type: 'session', version: 3, id: 'session-33333333-3333-4333-8333-333333333333',
    createdAt: CREATED + 100, cwd: '/work/other', isSeeded: false, delegationDepth: 0 },
  { type: 'user/message', seq: 1, time: CREATED + 200,
    data: { role: 'user', id: 'u', source: { kind: 'user' },
      content: [{ type: 'text', text: 'Second project' }] } }
]));

// A session directory with no recognizable log is not a session.
fs.mkdirSync(path.join(root, 'sessions', '--empty--', 'nothing'), { recursive: true });

check('finds the current generation of every session', findSessionFiles(root).length, 3);

const summary = summarizeSession(rootFile);
check('reads the session id and working directory from the header',
  [summary.provider, summary.id, summary.cwd],
  ['dsh', ROOT_ID, '/work/project']);
check('uses the provider title over the first message',
  summary.title, 'A generated title');
check('reports the requested model and start time',
  [summary.model, summary.started], ['deepseek/test', new Date(CREATED).toISOString()]);
check('counts user and assistant messages', summary.messages, 2);
check('sums DSH input, cache-read and output tokens',
  summary.usage, { inputTokens: 100, cacheReadTokens: 400,
    cacheWriteTokens: 0, outputTokens: 50, totalTokens: 550 });
check('records the OpenRouter generation of each model call',
  summary.billingCalls, [{ responseId: 'gen-abc', model: 'deepseek/test' }]);
check('keeps complete records before a torn final frame',
  summary.entries, 5);
check('has no dollar cost until billing is consulted', summary.cost, null);

const sessions = listSessions({ root });
check('folds a sub-agent into its root', sessions.length, 2);
const folded = sessions.find(session => session.id === ROOT_ID);
check('sub-agent tokens, bytes and count join the root',
  [folded.subagents, folded.tokens, folded.bytes > summary.bytes],
  [1, 565, true]);
check('sub-agent generations are billed with the root',
  folded.billingCalls.map(call => call.responseId).sort(), ['gen-abc', 'gen-child']);
check('lists newest session first',
  sessions.every((session, i) =>
    i === 0 || (sessions[i - 1].ended || '') >= (session.ended || '')), true);

const tree = sessionTree(ROOT_ID, { root });
check('a session tree holds the root and its sub-agent',
  tree.map(track => track.session.id).sort(), [ROOT_ID, CHILD_ID].sort());
check('tree members carry their own records', tree.every(track => track.entries.length > 0), true);
check('an unknown session has no tree', sessionTree('session-nope', { root }), null);
check('a stamp is the newest mtime in the tree',
  sessionStamp(ROOT_ID, { root }) >= fs.statSync(rootFile).mtimeMs, true);

check('decodes a project key back to a path',
  projectLabel('--Users-me-code--'), '/Users/me/code');

const page = renderPage(sessions);
check('renders a DSH provider badge', /class="provider dsh">DSH</.test(page), true);
check('renders a DSH usage row under the provider totals',
  />DSH<[\s\S]*?usage-provider dsh/.test(page) ||
    /usage-provider dsh[\s\S]*?>DSH</.test(page), true);
check('labels the page for all three providers',
  page.includes('Claude, Codex and DSH sessions'), true);

const billingCheck = (async () => {
  // The key DSH would use, written where the backend looks for it.
  fs.writeFileSync(path.join(root, '.credentials.yaml'),
    'version: 1\nrefs:\n  OPENROUTER_API_KEY: test-key\n');
  delete process.env.OPENROUTER_API_KEY;

  const requested = [];
  const fetchImpl = async (url, options) => {
    requested.push({ url, authorization: options.headers.Authorization });
    const id = new URL(url).searchParams.get('id');
    return { ok: true, json: async () => ({ data: {
      id, model: id === 'gen-abc' ? 'deepseek/test' : 'deepseek/child',
      total_cost: id === 'gen-abc' ? 0.001 : 0.002
    } }) };
  };

  const billed = await listSessionsWithUsage({ root, fetchImpl, useCache: false });
  const rootSession = billed.find(session => session.id === ROOT_ID);
  check('queries the OpenRouter generation of every model call',
    requested.map(request => new URL(request.url).searchParams.get('id')).sort(),
    ['gen-abc', 'gen-child']);
  check('authenticates with the DSH OpenRouter key',
    requested.every(request => request.authorization === 'Bearer test-key'), true);
  check('sums the exact cost of a root and its sub-agent',
    rootSession.cost, 0.003);
  check('attributes the cost of each generation to its model',
    [rootSession.models['deepseek/test'].cost,
      rootSession.models['deepseek/child'].cost], [0.001, 0.002]);

  // A generation the API does not know about is unavailable, not free.
  const partial = await listSessionsWithUsage({ root, useCache: false,
    fetchImpl: async (url) => {
      const id = new URL(url).searchParams.get('id');
      return id === 'gen-child'
        ? { ok: false, json: async () => ({}) }
        : { ok: true, json: async () => ({ data: { total_cost: 0.001 } }) };
    } });
  check('a session with an unbilled generation reports no cost',
    partial.every(session => session.cost === null), true);

  const free = await listSessionsWithUsage({ root, useCache: false,
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: { total_cost: 0 } }) }) });
  check('a genuinely free generation is a cost of zero',
    free.find(session => session.id === ROOT_ID).cost, 0);

  process.env.CLAUDE_PROFILER_OFFLINE = '1';
  const offline = await listSessionsWithUsage({ root, useCache: false,
    fetchImpl: async () => { throw new Error('offline must not fetch'); } });
  delete process.env.CLAUDE_PROFILER_OFFLINE;
  check('offline leaves DSH tokens without a cost',
    offline.every(session => session.cost === null), true);

  // A session without any model call has nothing to bill.
  check('a session with no model call stays unpriced',
    free.find(session => session.id === 'session-33333333-3333-4333-8333-333333333333').cost,
    null);

  fs.rmSync(root, { recursive: true, force: true });
  console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
})();

billingCheck.catch(error => {
  console.error(error);
  process.exit(1);
});
