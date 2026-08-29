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

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
