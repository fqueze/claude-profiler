const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  findSessionFiles, listSessions, summarizeSession, sessionTitles
} = require('./codex-backend.js');

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-backend-test-'));
const sessionDir = path.join(root, 'sessions', '2026', '01', '02');
fs.mkdirSync(sessionDir, { recursive: true });

function write(id, entries, name = `rollout-${id}.jsonl`) {
  const file = path.join(sessionDir, name);
  fs.writeFileSync(file, entries.map(JSON.stringify).join('\n') + '\n');
  return file;
}

const rootFile = write('root', [
  { timestamp: '2026-01-02T10:00:00.000Z', type: 'session_meta', payload: {
    id: 'root', timestamp: '2026-01-02T10:00:00.000Z', cwd: '/work/project',
    cli_version: '1.2.3', source: 'cli', thread_source: 'user',
    git: { branch: 'main' }
  } },
  { timestamp: '2026-01-02T10:00:01.000Z', type: 'event_msg', payload: {
    type: 'user_message', message: 'Fallback title\nwith more text'
  } },
  { timestamp: '2026-01-02T10:00:02.000Z', type: 'event_msg', payload: {
    type: 'item_completed', item: { type: 'UserMessage', content: [
      { type: 'text', text: 'Completed-item title' }
    ] }
  } },
  { timestamp: '2026-01-02T10:00:20.000Z', type: 'turn_context', payload: {
    cwd: '/work/project', model: 'gpt-test'
  } },
  { timestamp: '2026-01-02T10:00:30.000Z', type: 'event_msg', payload: {
    type: 'token_count', info: { total_token_usage: {
      input_tokens: 90, cached_input_tokens: 40, output_tokens: 10,
      reasoning_output_tokens: 3, total_tokens: 100
    } }
  } }
]);

write('child', [
  { timestamp: '2026-01-02T10:00:10.000Z', type: 'session_meta', payload: {
    id: 'child', timestamp: '2026-01-02T10:00:10.000Z', cwd: '/work/project',
    thread_source: 'subagent', source: { subagent: { thread_spawn: {
      parent_thread_id: 'root'
    } } }
  } },
  { timestamp: '2026-01-02T10:00:15.000Z', type: 'token_usage_record', payload: {
    thread_token_usage: {
      input_tokens: 18, cached_input_tokens: 8, output_tokens: 2,
      reasoning_output_tokens: 1, total_tokens: 20
    }
  } }
]);

fs.writeFileSync(path.join(root, 'session_index.jsonl'), [
  JSON.stringify({ id: 'root', thread_name: 'Indexed title' }),
  '{being-written'
].join('\n'));

check('finds nested Codex rollouts', findSessionFiles(root).length, 2);
check('reads titles despite an incomplete final index line',
  sessionTitles(root).get('root'), 'Indexed title');

// A listing can race the process appending to its live rollout.
fs.appendFileSync(rootFile, '{"timestamp":"still being written"');
const summary = summarizeSession(rootFile, new Map());
check('keeps complete records before an incomplete final rollout line',
  summary.tokens, 100);
check('uses the first user message when no indexed title exists',
  summary.title, 'Completed-item title');
check('reads the final cumulative usage snapshot', summary.usage, {
  input_tokens: 90, cached_input_tokens: 40, cache_write_input_tokens: 0,
  output_tokens: 10, reasoning_output_tokens: 3, total_tokens: 100
});
check('reports the Codex provider and no dollar estimate',
  [summary.provider, summary.cost], ['codex', null]);
check('reports the model needed to apply a rate', summary.model, 'gpt-test');

const sessions = listSessions({ root });
check('subagent threads are folded into their parent', sessions.length, 1);
check('subagent tokens and bytes are included',
  [sessions[0].tokens, sessions[0].subagents, sessions[0].bytes > summary.bytes],
  [120, 1, true]);
check('the session index title wins', sessions[0].title, 'Indexed title');

fs.rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
