const assert = require('assert');
const { createCodexProfile } = require('./codex-profile.js');

const base = 1767350000000;
const session = (id, parentId, offset, title) => ({
  id, parentId, title, cwd: '/work/project', model: 'gpt-test',
  started: new Date(base + offset).toISOString(),
  ended: new Date(base + offset + 5000).toISOString()
});
const entry = (offset, type, payload) => ({
  timestamp: new Date(base + offset).toISOString(), type, payload
});

const tree = [{
  session: session('root', null, 0, 'Root thread'),
  entries: [
    entry(0, 'session_meta', { id: 'root' }),
    entry(100, 'turn_context', { turn_id: 'turn', model: 'gpt-test', effort: 'high' }),
    entry(200, 'event_msg', { type: 'task_started', turn_id: 'turn' }),
    entry(300, 'event_msg', { type: 'item_completed', turn_id: 'turn',
      started_at_ms: base + 250, completed_at_ms: base + 300,
      item: { type: 'UserMessage', content: [{ type: 'text', text: 'Hello' }] } }),
    entry(1000, 'event_msg', { type: 'item_completed', turn_id: 'turn',
      started_at_ms: base + 400, completed_at_ms: base + 1000,
      item: { type: 'CommandExecution', command: ['git', 'status'], status: 'completed',
        stdout: 'clean' } }),
    entry(1500, 'event_msg', { type: 'task_complete', turn_id: 'turn' }),
    entry(1600, 'token_usage_record', { thread_token_usage: {
      total_tokens: 100, input_tokens: 80, cached_input_tokens: 50, output_tokens: 20
    } })
  ]
}, {
  session: session('child', 'root', 500, 'Search agent'),
  entries: [entry(500, 'session_meta', { id: 'child' }), entry(1200, 'event_msg', {
    type: 'item_completed', started_at_ms: base + 800, completed_at_ms: base + 1200,
    item: { type: 'Reasoning', summary_text: 'Looking' }
  })]
}];

const profile = createCodexProfile(tree, { credits: 12.5, cost: 1.25 });
assert.strictEqual(profile.meta.product, 'Codex');
assert.strictEqual(profile.meta.version, 64);
assert.deepStrictEqual(profile.threads.map(thread => thread.name), ['Root thread', 'Search agent']);

const names = thread => thread.markers.name.map(index => profile.shared.stringArray[index]);
assert(names(profile.threads[0]).includes('Turn'));
assert(names(profile.threads[0]).includes('CommandExecution'));
assert(names(profile.threads[0]).includes('Subagent'));
assert(names(profile.threads[1]).includes('Reasoning'));

const usage = profile.threads[0].markers.data.find(marker => marker.type === 'Usage');
assert.deepStrictEqual([usage.totalTokens, usage.credits, usage.cost], [100, 12.5, 1.25]);
assert(profile.threads[0].markers.startTime.every(Number.isFinite));
assert(profile.threads[0].markers.endTime.every(Number.isFinite));

console.log('ok   builds Codex turns, tools, usage, and subagent tracks');
console.log('\nall passed');
