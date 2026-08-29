// Checks that a Bash command is split into the segments and pipeline stages a
// size profile attributes bytes to. The tricky cases are quoting and heredocs:
// a `;` or an `echo` inside either is text, not syntax.
const assert = require('assert');
const { parseCommand } = require('./shell-parse.js');

function summary(command) {
  return parseCommand(command).map(segment => ({
    producer: segment.producer && segment.producer.name,
    pipeline: segment.pipeline.map(stage => stage.name),
    filters: segment.filters.map(stage => stage.name),
    isEcho: segment.isEcho,
    echoText: segment.echoText
  }));
}

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

// A plain command is one segment with one stage.
check('single command',
  summary('ls -la').map(s => s.pipeline),
  [['ls']]);

// The filter stages are what explain the output's size.
check('pipeline stages',
  summary('profiler-cli thread markers --limit 400 2>&1 | head -30').map(s => s.pipeline),
  [['profiler-cli', 'head']]);

check('pipeline producer is the non-filter',
  summary('profiler-cli thread markers 2>&1 | head -30')[0].producer,
  'profiler-cli');

check('pipeline filters listed',
  summary('cat log | grep foo | head -5')[0].filters,
  ['grep', 'head']);

// `cd`/`export` set things up and produce nothing; the real producer follows.
check('setup commands skipped as producer',
  summary('export PATH=/x:$PATH; export HOME=/y; cd /z; profiler-cli marker info m-1 2>&1')
    .map(s => s.producer),
  ['export', 'export', 'cd', 'profiler-cli']);

// Wrappers hide the interesting name.
check('wrapper prefix unwrapped',
  summary('time fx-tests try abc')[0].producer,
  'fx-tests');

// Echo segments are the anchors used to split output.
check('echo separators found',
  summary('cd /x; echo "=== a ==="; pq marker info m-284; echo; echo "=== b ==="; fx-tests try 53af')
    .map(s => (s.isEcho ? `ECHO:${s.echoText}` : s.producer)),
  ['cd', 'ECHO:=== a ===', 'pq', 'ECHO:', 'ECHO:=== b ===', 'fx-tests']);

// A heredoc body is data. Neither the `;` nor the `echo` inside it is syntax,
// and `ls -la` in the body must not become a command.
const heredocCase = [
  'cd /x; cat > f.md <<\'EOF\'',
  '# title',
  'echo "not a command"; ls -la',
  'EOF',
  'echo "=== after ==="; wc -l f.md'
].join('\n');
check('heredoc body is not parsed',
  summary(heredocCase).map(s => (s.isEcho ? `ECHO:${s.echoText}` : s.producer)),
  ['cd', 'cat', 'ECHO:=== after ===', 'wc']);

// Two heredocs in one call, the python one containing shell-looking text.
const pythonCase = [
  'cd /x; python3 - <<\'PY\'',
  'print("hi; echo no")',
  'PY',
  'cat >> s.md <<\'EOF\'',
  'text',
  'EOF'
].join('\n');
check('two heredocs',
  summary(pythonCase).map(s => s.producer),
  ['cd', 'python3', 'cat']);

// `<<-EOF` strips leading tabs from the terminator.
const dashHeredoc = ['cat <<-EOF', '\tbody', '\tEOF', 'echo done'].join('\n');
check('dash heredoc terminator',
  summary(dashHeredoc).map(s => (s.isEcho ? `ECHO:${s.echoText}` : s.producer)),
  ['cat', 'ECHO:done']);

// A quoted semicolon is not a separator.
check('quoted semicolon',
  summary('grep "a;b" file').map(s => s.pipeline),
  [['grep']]);

// A `|` inside quotes is not a pipe.
check('quoted pipe',
  summary('grep "a|b" file')[0].pipeline,
  ['grep']);

// Command substitution stays with the command that used it.
check('command substitution kept inline',
  summary('echo "$(ls | wc -l) files"').map(s => s.pipeline),
  [['echo']]);

// && and || also separate commands.
check('and-or separators',
  summary('mkdir -p d && cd d || echo failed').map(s => (s.isEcho ? 'ECHO' : s.producer)),
  ['mkdir', 'cd', 'ECHO']);

// Newline-separated commands.
check('newline separators',
  summary('ls\nwc -l\n').map(s => s.pipeline),
  [['ls'], ['wc']]);

// A loop's body is where the bytes come from, so the commands inside it are
// what show up; the bare `done` that closes it produces nothing.
check('for loop',
  summary('cd /x; for t in AAA BBB; do grep -n foo $t; done').map(s => s.producer),
  ['cd', 'for', 'grep']);

// Line continuations do not split a command.
check('line continuation',
  summary('grep foo \\\n  bar.txt').map(s => s.pipeline),
  [['grep']]);

// An unterminated quote must not hang or throw.
check('unterminated quote survives',
  summary('echo "unterminated').length > 0,
  true);

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
