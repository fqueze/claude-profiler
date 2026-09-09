// Checks profiling a machine over ssh: that the commands sent there are
// quoted so a hostile session id cannot become shell, that the --json protocol
// the far end speaks round-trips, and that the page says which machine it is
// showing.
//
// The ssh calls are exercised against this machine's own shell rather than a
// real host: what is worth testing is the command that gets built and the JSON
// that comes back, and both are the same whichever end runs them.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PROTOCOL, shellQuote } = require('./remote.js');
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

// --- Quoting ---------------------------------------------------------------

// A session id reaches the remote inside a shell command, so anything that
// escapes its quoting runs there. These are the shapes that would.
const NODE = process.execPath;

function runInShell(command) {
  return execFileSync('/bin/sh', ['-c', command], { encoding: 'utf-8' });
}

for (const [name, value] of [
  ['a plain id', '128cf702-307b-4782-a478-51fb11273d0d'],
  ['an id with a quote', `it's`],
  ['an id with a semicolon', 'x; echo pwned'],
  ['an id with a subshell', 'x$(echo pwned)'],
  ['an id with backticks', 'x`echo pwned`'],
  ['an id with a space', 'two words']
]) {
  // echo prints the argument back exactly when the quoting held, and prints
  // something else — or runs something else — when it did not.
  check(`${name} survives shellQuote intact`,
    runInShell(`echo ${shellQuote(value)}`).trimEnd(), value);
}

// --- The --json protocol ---------------------------------------------------

// The far end of the ssh. Run for real, since the point is that stdout is
// clean enough to parse: a stray console.log anywhere in the profile build
// would corrupt it, and only running it catches that.
function json(args) {
  return execFileSync(NODE, [path.join(__dirname, 'index.js'), ...args], {
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024,
    // stderr is where progress goes, and it is not part of what is parsed.
    stdio: ['ignore', 'pipe', 'ignore']
  });
}

const probe = JSON.parse(json(['--json', 'probe']));
check('probe answers with the protocol version', probe.protocol, PROTOCOL);
check('probe answers with a version string', typeof probe.version, 'string');

const listed = JSON.parse(json(['--json', 'list']));
check('list answers with an array of sessions', Array.isArray(listed.sessions), true);

// The local path on another machine is meaningless here and would be shown as
// though it were a path on this one, so it is dropped before sending.
check('a listed session carries no local file path',
  listed.sessions.every(session => !('file' in session)), true);

check('a listed session carries what the table needs',
  listed.sessions.length === 0 ||
    ['id', 'title', 'cwd', 'cost', 'bytes', 'ended', 'messages']
      .every(key => key in listed.sessions[0]),
  true);

// The cache key is built from this, so it has to move when the session does —
// otherwise re-profiling the session being worked in serves the profile from
// before it was worked in.
if (listed.sessions.length > 0) {
  const id = listed.sessions[0].id;
  const first = JSON.parse(json(['--json', 'stamp', id]));
  check('stamp answers with a number', typeof first.stamp, 'number');
  check('stamp is the same for an unchanged session',
    JSON.parse(json(['--json', 'stamp', id])).stamp, first.stamp);
}

check('stamp answers null for a session that is not there',
  JSON.parse(json(['--json', 'stamp', 'no-such-session'])).stamp, null);

// --- The page --------------------------------------------------------------

const sessions = [{
  id: 'abc', file: '/tmp/abc.jsonl', project: '-tmp', title: 'A session',
  cwd: '/tmp', gitBranch: 'main', version: '1.0.0',
  started: '2026-01-01T00:00:00.000Z', ended: '2026-01-01T01:00:00.000Z',
  active: 60000, messages: 4, entries: 8, bytes: 1024, subagents: 0, cost: 1
}];

const local = renderPage(sessions, {});
const remote = renderPage(sessions, { host: 'm4' });

check('the local page does not name a host',
  /<h1>Claude sessions<\/h1>/.test(local), true);

check('the remote page names the host in the heading',
  /<h1>Claude sessions on <span class="host">m4<\/span><\/h1>/.test(remote), true);

check('the remote page names the host in the title',
  /<title>Claude sessions on m4<\/title>/.test(remote), true);

// A host is a name from the command line, and it is interpolated into HTML.
const injected = renderPage(sessions, { host: '<script>alert(1)</script>' });
check('a host name is escaped into the page',
  injected.includes('<script>alert(1)</script>'), false);
check('a host name is still shown, escaped',
  injected.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), true);

// --- Remote invocation -----------------------------------------------------

// macOS hands a non-interactive `ssh host command` a PATH from no profile at
// all, so a Homebrew node is not on it and neither is the claude-profiler
// installed beside it. Running through a login shell is what fixes that, and
// dropping it would break every remote host silently.
const source = fs.readFileSync(path.join(__dirname, 'remote.js'), 'utf-8');
check('remote commands run through a login shell', /zsh -lc/.test(source), true);

// The profile route serves whatever the remote sent without decoding it, so it
// must stay a Buffer: round-tripping 21MB of JSON through a string to serve it
// unchanged is pure waste.
check('a remote profile is collected as a buffer',
  /Buffer\.concat\(out\)/.test(source), true);

// --- The command line ------------------------------------------------------

// What the CLI does with an argument it cannot make sense of. The dangerous
// shape is the quiet one: `--host` with nothing after it used to fall through
// to listing this machine, on a page whose heading does not say which machine
// it is, so the figures being read belonged to the wrong computer.
function cli(args) {
  try {
    execFileSync(NODE, [path.join(__dirname, 'index.js'), ...args], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe']
    });
    return { code: 0, stderr: '' };
  } catch (error) {
    return { code: error.status, stderr: (error.stderr || '').trim() };
  }
}

for (const [name, args, expected] of [
  ['--host with no value', ['--host'], 'Error: --host needs a value'],
  ['--host set to nothing', ['--host='], 'Error: --host needs a value'],
  ['--at with no value', ['--at'], 'Error: --at needs a value'],
  ['a mistyped flag', ['--sized', 'x.jsonl'], 'Error: unknown option "--sized"'],
  ['two positionals', ['a', 'b'], 'Error: expected one file or machine, got 2']
]) {
  const { code, stderr } = cli(args);
  check(`${name} is refused`, code, 1);
  check(`${name} says why`, stderr.split('\n')[0], expected);
}

// ssh reads a leading dash as an option of its own, so a name shaped like one
// is refused before it gets there rather than producing a usage dump.
check('a host that looks like an option is refused',
  cli(['--host', '-oProxyCommand=touch /tmp/nope']).code, 1);

// --- Building the same profile twice at once -------------------------------

// Building is slow — a whole ssh round trip for a remote machine — so a second
// click on a row lands while the first is still building. What is cached is
// the build rather than its result, so the second waits for the first instead
// of starting its own.
const cacheCheck = (async () => {
  // The shape startIndexServer's /open/ route has, over a source that counts
  // how many builds it is asked for.
  const profiles = new Map();
  let builds = 0;

  const source = {
    profile: async () => {
      builds++;
      await new Promise(resolve => setTimeout(resolve, 50));
      return Buffer.from('profile');
    }
  };

  async function open(key) {
    if (!profiles.has(key)) {
      const building = (async () => source.profile())();
      building.catch(() => profiles.delete(key));
      profiles.set(key, building);
    }
    return profiles.get(key);
  }

  const bodies = await Promise.all([open('k'), open('k'), open('k')]);

  check('three clicks on one session build it once', builds, 1);
  check('every click gets the profile',
    bodies.map(body => body.toString()), ['profile', 'profile', 'profile']);

  // A build that throws must not be left behind as a rejected promise: the
  // retry would fail the same way without ever running.
  const failing = new Map();
  let attempts = 0;
  async function openFailing() {
    if (!failing.has('k')) {
      const building = (async () => {
        attempts++;
        throw new Error('ssh died');
      })();
      building.catch(() => failing.delete('k'));
      failing.set('k', building);
    }
    return failing.get('k');
  }

  await openFailing().catch(() => {});
  // The rejection handler runs as a microtask, so the retry sees a cleared map.
  await new Promise(resolve => setImmediate(resolve));
  check('a failed build is dropped from the cache', failing.has('k'), false);
  await openFailing().catch(() => {});
  check('a retry after a failed build tries again', attempts, 2);

  // And index.js has to be doing that, not just this test.
  const index = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf-8');
  check('index.js caches the build rather than the built profile',
    /building\.catch\(\(\) => profiles\.delete\(key\)\)/.test(index), true);

  console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
