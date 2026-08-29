// Checks that a Bash call's output is attributed to the commands that produced
// it, and that a context window is reconstructed from the parentUuid chain.
const assert = require('assert');
const { splitOutputByEchoes, bashFrames, byteLength } = require('./size-profile.js');
const { parseCommand } = require('./shell-parse.js');
const { contextChain, calibrate } = require('./context-size.js');

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

// Attributes each chunk of output to a stack, as the profile does.
function attribute(command, output) {
  const result = [];
  for (const chunk of splitOutputByEchoes(output, parseCommand(command))) {
    const bytes = byteLength(chunk.text);
    if (bytes === 0) continue;
    result.push({ frames: bashFrames(chunk).join('/'), bytes });
  }
  return result;
}

// The echo markers the agent writes are what let output be split: text between
// two of them came from the commands in between.
check('output split on echo anchors',
  attribute(
    'echo "=== first ==="; pq marker info m-1; echo "=== second ==="; fx-tests try abc',
    '=== first ===\nAAAA\n=== second ===\nBBBBBBBB\n'
  ),
  [
    { frames: 'echo', bytes: 13 },
    { frames: 'pq marker info', bytes: 6 },
    { frames: 'echo', bytes: 14 },
    { frames: 'fx-tests try abc', bytes: 10 }
  ]);

// A pipeline's filter is why the output has the size it has, so it gets a frame
// under the command that produced the bytes.
check('filter appears under its producer',
  attribute('profiler-cli thread markers 2>&1 | head -3', 'a\nb\nc\n')[0].frames,
  'profiler-cli thread markers/head -3');

// With no anchor, one producer still resolves on its own.
check('single producer without anchor',
  attribute('cd /x; profiler-cli marker info m-1', 'output\n')[0].frames,
  'profiler-cli marker info');

// The same command repeated is that command, not a composite of itself.
check('repeated command collapses',
  attribute('pq marker info m-1; pq marker info m-2', 'a\nb\n')[0].frames,
  'pq marker info');

// A loop body is the repeated unit; the loop itself produced nothing.
check('loop body attributed under the loop',
  attribute('for t in A B; do head -5 "$t.log"; done', 'x\ny\n')[0].frames,
  'for loop/head -5');

// An echo with a variable still anchors on its literal prefix, once per
// iteration of the loop it sits in.
check('repeated partial anchor in a loop',
  attribute(
    'for t in A B; do echo "=== $t"; head -2 "$t.log"; done',
    '=== A\nfirst\n=== B\nsecond\n'
  ).map(chunk => chunk.frames),
  ['for loop/echo', 'for loop/head -2',
   'for loop/echo', 'for loop/head -2']);

// A filter's operand differs at every call site — a line range, a pattern — so
// it is dropped, and calls that did the same thing land on one frame. The flags
// stay, since they are what the filter did.
const { describeFrame } = require('./size-profile.js');
const filterName = (command) => describeFrame(parseCommand(command)[0].producer);

check('sed line ranges aggregate', [
  filterName('sed -n 20430,20500p f'),
  filterName('sed -n 100,180p f'),
  filterName('sed -n 16,30p;60,130p f')
], ['sed -n', 'sed -n', 'sed -n']);

check('grep patterns aggregate by flags', [
  filterName('grep -viE "^  PID" f'),
  filterName('grep -viE other f'),
  filterName('grep -n foo f')
], ['grep -viE', 'grep -viE', 'grep -n']);

// A count is the flag, so how much was kept stays visible.
check('head keeps its count', [filterName('head -20 f'), filterName('head -60 f')],
  ['head -20', 'head -60']);

// A producer keeps its subcommand but not its arguments.
check('producer keeps subcommand, drops arguments', [
  filterName('profiler-cli marker info m-284'),
  filterName('profiler-cli marker info m-999'),
  filterName('fx-tests try 53afe8eb49ab --all-jobs')
], ['profiler-cli marker info', 'profiler-cli marker info', 'fx-tests try']);

// Bytes must be conserved: every byte of output lands somewhere.
const conservation = [
  ['echo "=== a ==="; ls; echo "=== b ==="; wc -l f', '=== a ===\nfile\n=== b ===\n  12 f\n'],
  ['cd /x && grep -rn foo . | head -20', 'match one\nmatch two\n'],
  ['for i in 1 2; do echo "=== $i"; cat f; done', '=== 1\nbody\n=== 2\nbody\n'],
  ['pq load x; pq zoom y', 'loaded\nzoomed\n']
];
for (const [command, output] of conservation) {
  const attributed = attribute(command, output).reduce((sum, chunk) => sum + chunk.bytes, 0);
  check(`bytes conserved: ${command.slice(0, 32)}…`, attributed, byteLength(output));
}

// The context window is the chain of messages leading to a call, cut at the
// most recent compaction: anything before it has left the window.
const entries = [
  { uuid: 'a', parentUuid: null },
  { uuid: 'b', parentUuid: 'a' },
  { uuid: 'c', parentUuid: 'b' },
  { uuid: 'd', parentUuid: 'c' }
];
const byUuid = new Map(entries.map(entry => [entry.uuid, entry]));

check('chain walks back to the root',
  contextChain(byUuid.get('d'), byUuid, new Set()).map(entry => entry.uuid),
  ['d', 'c', 'b', 'a']);

check('chain stops at a compaction boundary',
  contextChain(byUuid.get('d'), byUuid, new Set(['b'])).map(entry => entry.uuid),
  ['d', 'c', 'b']);

// A parentUuid pointing at nothing ends the walk rather than throwing.
check('dangling parent ends the walk',
  contextChain({ uuid: 'x', parentUuid: 'missing' }, byUuid, new Set()).map(e => e.uuid),
  ['x']);

// A cycle must not loop forever.
const cyclic = new Map([
  ['p', { uuid: 'p', parentUuid: 'q' }],
  ['q', { uuid: 'q', parentUuid: 'p' }]
]);
check('cycle terminates',
  contextChain(cyclic.get('p'), cyclic, new Set()).map(e => e.uuid),
  ['p', 'q']);

// Calibration recovers a known relationship: tokens = 1000 + bytes / 2.
const synthetic = [];
for (let i = 1; i <= 20; i++) {
  const bytes = i * 5000;
  synthetic.push({ bytes, tokens: 1000 + bytes / 2 });
}
const fit = calibrate(synthetic);
check('calibration recovers bytes per token', Math.round(fit.bytesPerToken * 100) / 100, 2);
check('calibration recovers the fixed overhead', fit.overhead, 1000);
check('calibration reports it fitted', fit.fitted, true);

// Too few points to fit: falls back rather than dividing by zero.
check('calibration falls back on tiny input', calibrate([{ bytes: 10, tokens: 5 }]).fitted, false);

// The transcript is what the source view shows, and a frame's line has to point
// at the content that frame is about, or double-clicking lands in the wrong place.
const { renderTranscript } = require('./transcript.js');

const toolUse = {
  id: 'tu1',
  type: 'tool_use',
  name: 'Bash',
  input: { command: 'echo "=== hello ==="; ls' }
};
const sessionEntries = [
  {
    uuid: 'u1',
    type: 'user',
    timestamp: '2026-08-28T21:08:21.312Z',
    message: { role: 'user', content: 'please list the files' }
  },
  {
    uuid: 'u2',
    type: 'assistant',
    timestamp: '2026-08-28T21:08:25.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Listing them.' }, toolUse] }
  },
  {
    uuid: 'u3',
    type: 'user',
    timestamp: '2026-08-28T21:08:26.000Z',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '=== hello ===\nfile-a\nfile-b\n' }]
    }
  }
];

const rendered = renderTranscript(sessionEntries, new Map([['tu1', toolUse]]), {
  title: 'test session'
});
const documentLines = rendered.text.split('\n');
const at = (line) => documentLines[line - 1];

// The document is the context window and nothing else, so every keyed line is
// the content itself rather than a header describing it.
check('a prompt starts at its own text', at(rendered.lineFor.get('u1')),
  'please list the files');
check('assistant text starts at its own text', at(rendered.lineFor.get('u2')),
  'Listing them.');
check('a tool call starts at the command', at(rendered.lineFor.get('tu1:call')),
  'echo "=== hello ==="; ls');
check('a tool result starts at its first line', at(rendered.lineFor.get('tu1:output')),
  '=== hello ===');

// Nothing may be added that the model was not sent: an invented line would sit
// between real ones and shift every line below it away from what was measured.
const invented = documentLines.filter(line =>
  /^\d\d:\d\d:\d\d/.test(line) ||      // a timestamp
  /^\s*\(\d+(\.\d+)? [KMG]?B/.test(line) || // a size note
  /^\$ /.test(line) ||                    // a shell prompt
  /^────/.test(line) ||                    // a separator
  /^# /.test(line));                       // a header
check('the document invents no lines', invented, []);

// Every non-blank line of the document must be a line of something the model
// was sent. This is the property the line numbers depend on.
const sourceLines = new Set();
for (const entry of sessionEntries) {
  const content = entry.message.content;
  const texts = typeof content === 'string'
    ? [content]
    : content.map((block) =>
        block.type === 'text' ? block.text
        : block.type === 'tool_use' ? block.input.command
        : block.type === 'tool_result' ? block.content
        : '');
  for (const text of texts) {
    for (const line of String(text).split('\n')) sourceLines.add(line);
  }
}
const foreign = documentLines.filter(line => line !== '' && !sourceLines.has(line));
check('every line of the document came from the context', foreign, []);

// Lines are 1-based, as the source view expects.
check('lines are 1-based', Math.min(...rendered.lineFor.values()) >= 1, true);

// Every recorded line must exist in the document.
check('every keyed line is inside the document',
  [...rendered.lineFor.values()].every(line => line >= 1 && line <= rendered.lineCount),
  true);

// The source view scrolls to the heaviest line of a call node, and a call node
// merges every frame sharing a func — so a name that occurs in several places
// must not share a func at its leaf, or a double-click lands somewhere else.
const { createSizeProfile } = require('./context-size.js');

const twoPlaces = [
  { uuid: 'a1', parentUuid: null, type: 'user', timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: 'go' } },
  { uuid: 'a2', parentUuid: 'a1', type: 'assistant', requestId: 'r1',
    timestamp: '2026-01-01T00:00:01.000Z',
    message: { role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sed -n 1,5p a' } }] } },
  { uuid: 'a3', parentUuid: 'a2', type: 'user', timestamp: '2026-01-01T00:00:02.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'AAA\nBBB\n' }] } },
  { uuid: 'a4', parentUuid: 'a3', type: 'assistant', requestId: 'r2',
    timestamp: '2026-01-01T00:00:03.000Z',
    message: { role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 20, output_tokens: 5 },
      content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'sed -n 90,99p b' } }] } },
  { uuid: 'a5', parentUuid: 'a4', type: 'user', timestamp: '2026-01-01T00:00:04.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'CCC\nDDD\n' }] } }
];

const built = createSizeProfile(twoPlaces, [], { at: 'last' });
const builtShared = built.shared;

// Every func that carries a line must carry exactly one, or the scroll target is
// ambiguous for the boxes sharing it.
const linesPerFunc = new Map();
for (let frame = 0; frame < builtShared.frameTable.length; frame++) {
  const line = builtShared.frameTable.line[frame];
  if (line === null) continue;
  const func = builtShared.frameTable.func[frame];
  if (!linesPerFunc.has(func)) linesPerFunc.set(func, new Set());
  linesPerFunc.get(func).add(line);
}
check('no func carries more than one line',
  [...linesPerFunc.values()].filter(lines => lines.size > 1).length, 0);

// The two `sed -n` calls still aggregate under one frame name, one level above
// the leaves that hold their lines.
const frameName = (frame) =>
  builtShared.stringArray[builtShared.funcTable.name[builtShared.frameTable.func[frame]]];
const names = [];
for (let frame = 0; frame < builtShared.frameTable.length; frame++) {
  names.push(frameName(frame));
}
// Call nodes merge by func, so what matters is that the repeated command shares
// one func. It still gets a frame per category, since the command text and the
// output it produced are coloured differently.
const funcsNamed = (wanted) => {
  const found = new Set();
  for (let frame = 0; frame < builtShared.frameTable.length; frame++) {
    if (frameName(frame) === wanted) found.add(builtShared.frameTable.func[frame]);
  }
  return found.size;
};
check('the repeated command shares one func', funcsNamed('sed -n'), 1);
// A leaf names the one call it stands for, operands included, so it says what
// was read. `line 620` is only the fallback for a chunk that cannot be pinned on
// a single command.
check('each occurrence gets a leaf naming its invocation', [
  names.includes('sed -n 1,5p a'),
  names.includes('sed -n 90,99p b')
], [true, true]);

// Marker schemas must use `fields`: the rename from `data` happened in format
// v55, and these profiles declare v64, so no upgrader will fix it. A schema
// left with `data` makes the front end throw when a marker is hovered.
const { createFirefoxProfile } = require('./index.js');
const timeline = createFirefoxProfile(twoPlaces, []);
check('every marker schema uses fields',
  timeline.meta.markerSchema.every(schema => Array.isArray(schema.fields)), true);
check('no marker schema still uses data',
  timeline.meta.markerSchema.every(schema => schema.data === undefined), true);

// The activity graph gives each sample the span between its neighbours, so with
// only the moments something was logged a session that waited hours for its user
// draws as busy throughout. Idle samples fill the gaps where neither the model
// nor a tool was running.
const idleCase = [
  { uuid: 'i1', parentUuid: null, type: 'user', timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: 'start' } },
  { uuid: 'i2', parentUuid: 'i1', type: 'assistant', requestId: 'q1',
    timestamp: '2026-01-01T00:00:02.000Z',
    message: { role: 'assistant', model: 'claude-opus-5',
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: 'text', text: 'working' }] } },
  // An hour of nothing: the user walked away.
  { uuid: 'i3', parentUuid: 'i2', type: 'user', timestamp: '2026-01-01T01:00:00.000Z',
    message: { role: 'user', content: 'back' } },
  { uuid: 'i4', parentUuid: 'i3', type: 'assistant', requestId: 'q2',
    timestamp: '2026-01-01T01:00:02.000Z',
    message: { role: 'assistant', model: 'claude-opus-5',
      usage: { input_tokens: 20, output_tokens: 5 },
      content: [{ type: 'text', text: 'resuming' }] } }
];

const withIdle = createFirefoxProfile(idleCase, []);
const idleThread = withIdle.threads[0];
const idleShared = withIdle.shared;
const idleCategory = withIdle.meta.categories.findIndex(c => c.name === 'Idle');

// A category coloured `transparent` is what the front end draws as nothing, so
// idle stretches read as empty without inventing any CPU measurement.
check('the profile has an Idle category', idleCategory !== -1, true);
check('idle draws as nothing', withIdle.meta.categories[idleCategory].color, 'transparent');

// No CPU figures anywhere: there is no meaningful one here, and it would show up
// in every tooltip along the timeline.
check('no sampleUnits are declared', withIdle.meta.sampleUnits, undefined);
check('samples carry no CPU deltas', idleThread.samples.threadCPUDelta, undefined);

const categoryOf = (index) =>
  idleShared.frameTable.category[idleShared.stackTable.frame[idleThread.samples.stack[index]]];

let idleSamples = 0;
let idleWeight = 0;
for (let index = 0; index < idleThread.samples.length; index++) {
  if (categoryOf(index) === idleCategory) {
    idleSamples++;
    idleWeight += idleThread.samples.weight[index];
  }
}
check('the hour of nothing is sampled as idle', idleSamples > 1, true);
check('idle samples carry no weight', idleWeight, 0);

// The graph gives a sample the span from halfway back to the previous sample to
// halfway on to the next, filled with that sample's own category, so two samples
// bound a gap: everything between them is idle whatever its length.
const times = idleThread.samples.time;
const idleTimes = [];
for (let index = 0; index < idleThread.samples.length; index++) {
  if (categoryOf(index) === idleCategory) idleTimes.push(times[index]);
}
idleTimes.sort((a, b) => a - b);

let widest = 0;
let widestFrom = 0;
for (let index = 1; index < idleTimes.length; index++) {
  if (idleTimes[index] - idleTimes[index - 1] > widest) {
    widest = idleTimes[index] - idleTimes[index - 1];
    widestFrom = idleTimes[index - 1];
  }
}
check('the idle hour is bounded by two idle samples',
  Math.round(widest / 60000), 60);

// Nothing busy may sit between them, or the gap would be filled as work.
const busyInsideGap = [];
for (let index = 0; index < idleThread.samples.length; index++) {
  if (categoryOf(index) !== idleCategory &&
      times[index] > widestFrom && times[index] < widestFrom + widest) {
    busyInsideGap.push(times[index]);
  }
}
check('nothing busy sits inside the idle hour', busyInsideGap, []);

// Two samples per gap is the whole cost, so a long session stays cheap.
check('a gap costs two samples, not one per interval', idleTimes.length <= 6, true);

// Idle must not cover time when something was running, or the graph would show a
// gap where there was work. The opening exchange ran in the first two seconds.
let idleDuringWork = 0;
for (let index = 0; index < idleThread.samples.length; index++) {
  if (categoryOf(index) === idleCategory && times[index] > 0 && times[index] < 2000) {
    idleDuringWork++;
  }
}
check('no idle sample lands inside the opening exchange', idleDuringWork, 0);

// The size profile measures bytes, not wall clock, so it has no idle to show.
check('the size profile has no Idle category',
  built.meta.categories.some(c => c.name === 'Idle'), false);

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
