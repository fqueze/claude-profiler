const assert = require('assert');
const { createDshProfile } = require('./dsh-profile.js');

const base = 1767350000000;
const session = (id, parentId, offset, title, usage) => ({
  id, parentId, title, cwd: '/work/project', model: 'deepseek/test',
  started: new Date(base + offset).toISOString(),
  ended: new Date(base + offset + 5000).toISOString(),
  usage
});
const entry = (offset, type, data) => ({ type, seq: offset, time: base + offset, data });

const rootUsage = { inputTokens: 80, cacheReadTokens: 50, cacheWriteTokens: 0,
  outputTokens: 20, totalTokens: 150 };
const childUsage = { inputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0,
  outputTokens: 4, totalTokens: 19 };

const tree = [{
  session: session('session-root', null, 0, 'Root session', rootUsage),
  entries: [
    entry(200, 'turn/start', { turn: 1 }),
    entry(250, 'request/header', { header: {
      config: { provider: 'openrouter', model: 'deepseek/test', reasoningEffort: 'high' }
    }, reason: 'initial' }),
    entry(300, 'user/message', { role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: 'Hello there' }] }),
    entry(1000, 'assistant/message', { turn: 1, step: 1, message: {
      role: 'assistant', content: [
        { type: 'text', text: 'Working on it' },
        { type: 'reasoning', text: 'Thinking hard' },
        { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"git status"}' }
      ],
      source: { kind: 'model', provider: 'openrouter', model: 'deepseek/test',
        replayState: { response: { kind: 'pi-ai', responseId: 'gen-root' } } }
    }, usage: { ...rootUsage, reasoningTokens: 8 } }),
    entry(1100, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash',
      arguments: '{"command":"git status"}' }),
    entry(1300, 'tool/result', { turn: 1, step: 1, message: {
      role: 'tool', source: { kind: 'tool', callId: 'c1' },
      content: [{ type: 'tool-result', toolCallId: 'c1',
        content: [{ type: 'text', text: 'clean' }] }] } }),
    entry(1500, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    entry(1600, 'assistant/attempt', { turn: 1, step: 2, stream: [{ type: 'chunk',
      chunk: { type: 'finish', reason: { kind: 'error',
        failure: { message: 'provider exploded' } } } }] }),
    entry(1700, 'session/title', { title: 'Root session' })
  ]
}, {
  session: session('session-child', 'session-root', 500, 'Search agent', childUsage),
  entries: [
    entry(700, 'assistant/message', { turn: 1, step: 1, message: {
      role: 'assistant', content: [{ type: 'reasoning', text: 'Looking around' }],
      source: { kind: 'model', provider: 'openrouter', model: 'deepseek/child',
        replayState: { response: { kind: 'pi-ai', responseId: 'gen-child' } } }
    }, usage: { ...childUsage, reasoningTokens: 2 } })
  ]
}];

const billing = new Map([['gen-root', { cost: 1 }], ['gen-child', { cost: 0.25 }]]);
const profile = createDshProfile(tree, billing);
assert.strictEqual(profile.meta.product, 'DSH');
assert.strictEqual(profile.meta.version, 64);
assert.deepStrictEqual(profile.threads.map(thread => thread.name),
  ['Root session', 'Search agent']);

const names = thread => thread.markers.name.map(index => profile.shared.stringArray[index]);
assert(names(profile.threads[0]).includes('Turn'));
assert(names(profile.threads[0]).includes('bash'));
assert(names(profile.threads[0]).includes('Subagent'));
assert(names(profile.threads[1]).includes('Reasoning'));
assert(names(profile.threads[0]).includes('Context Size'));
assert(names(profile.threads[0]).includes('Output Tokens'));
assert(names(profile.threads[0]).includes('deepseek/test'));
assert(names(profile.threads[0]).includes('Activity'));
assert(names(profile.threads[0]).includes('Error'));

const usage = profile.threads[0].markers.data.find(marker => marker.type === 'Usage');
assert.deepStrictEqual(
  [usage.totalTokens, usage.inputTokens, usage.cachedTokens, usage.outputTokens, usage.cost],
  [150, 80, 50, 20, 1]);
const threadCosts = profile.threads[0].markers.data
  .filter(marker => marker.type === 'ThreadCost');
const totalCosts = profile.threads[0].markers.data
  .filter(marker => marker.type === 'TotalCost');
const responseCosts = profile.threads[0].markers.data
  .filter(marker => marker.type === 'ResponseCost');
assert.strictEqual(threadCosts.at(-1).cost, 1);
assert.strictEqual(totalCosts.at(-1).cost, 1.25);
assert.strictEqual(responseCosts.reduce((sum, marker) => sum + marker.cost, 0), 1);
assert.strictEqual(responseCosts[0].inputTokens, 80);

const tool = profile.threads[0].markers.data.find(marker => marker.type === 'ToolCall');
assert.deepStrictEqual([tool.status, tool.detail], ['complete', 'git status']);
assert(tool.outputBytes >= 5);
const turn = profile.threads[0].markers.data.find(marker => marker.type === 'Turn');
assert.deepStrictEqual([turn.status, turn.model, turn.effort],
  ['completed', 'deepseek/test', 'high']);
const intervention = profile.threads[0].markers.data
  .find(marker => marker.type === 'Intervention');
assert.strictEqual(intervention.text, 'provider exploded');

assert(profile.meta.markerSchema.find(schema => schema.name === 'ThreadCost').graphs);
assert(profile.meta.markerSchema.find(schema => schema.name === 'ContextSize').graphs);
assert(profile.threads[0].samples.length > 0);
assert.strictEqual(profile.threads[0].samples.weightType, 'bytes');
assert.strictEqual(profile.shared.sources.length, 2);
assert(profile.shared.sources.content[0].includes('Hello there'));
assert(profile.shared.sources.content[0].includes('clean'));
assert(profile.threads[0].markers.startTime.every(Number.isFinite));
assert(profile.threads[0].markers.endTime.every(Number.isFinite));

// A generation the billing API did not return must not be reported as free.
const unknown = createDshProfile(tree, new Map([['gen-root', { cost: 1 }]]));
const unknownUsage = unknown.threads[0].markers.data.find(marker => marker.type === 'Usage');
assert.strictEqual(unknownUsage.cost, 1);
// The sub-agent was not billed, so no session-wide total is claimed and the
// child thread draws no cost graph at all.
assert.strictEqual(unknown.threads[0].markers.data
  .filter(marker => marker.type === 'TotalCost').length, 0);
assert.strictEqual(unknown.threads[1].markers.data
  .filter(marker => marker.type === 'ThreadCost').length, 0);
assert.strictEqual(unknown.threads[1].markers.data
  .find(marker => marker.type === 'Usage').cost, null);

console.log('ok   builds DSH turns, tools, usage, cost graphs, and subagent tracks');
console.log('\nall passed');
