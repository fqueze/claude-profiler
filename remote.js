// Profiling a machine you can ssh into. `claude-profiler <host>` lists that
// host's sessions in the local browser and builds their profiles there, so the
// only thing that crosses the network is JSON.
//
// The work happens on the remote deliberately. Summarizing a session means
// reading it, and reading them all locally would mean copying every transcript
// — 128MB on the machine this was written against — to draw a table of
// numbers. The remote already has the files, so it does the reading and sends
// back the summaries, which are a few hundred bytes each.

const { spawn } = require('child_process');

// The remote's `claude-profiler --json ...` speaks this, so a version mismatch
// is caught as a bad protocol rather than as a confusing parse failure further
// down. Bump it when the shape of what `--json` emits changes.
const PROTOCOL = 1;

// Where the remote copy comes from when it is missing and installing it is
// accepted. The published remote rather than the local checkout: what is
// installed on another machine should be a released state, not whatever is
// uncommitted here.
const PACKAGE = 'git+https://github.com/fqueze/claude-profiler.git';

// A non-interactive `ssh host command` gets a PATH from neither .zshrc nor
// .zprofile on macOS, which is how a machine with Homebrew's node in
// /opt/homebrew/bin still answers `command -v node` with nothing. Running the
// command through a login shell is what puts node — and so the globally
// installed claude-profiler — back on the PATH.
//
// The command is passed as a single argument to `zsh -lc`, so it must already
// be a valid shell command; callers build it from quoted pieces.
function sshArgs(host, command) {
  return [host, `zsh -lc ${shellQuote(command)}`];
}

// Single-quote for the remote shell. Everything is literal inside single
// quotes except the quote itself, which ends the string and has to be spliced
// back in escaped.
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Runs a command on the remote and collects it. Resolves with the streams and
// the exit code rather than rejecting on a non-zero one: every caller here has
// something specific to say about a failure, and a rejection would throw that
// away in favour of a generic message.
//
// stdout is collected as a Buffer because a profile is megabytes of JSON and
// concatenating it as a string builds it twice.
function ssh(host, command, { stdin } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', sshArgs(host, command), {
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
    });

    const out = [];
    let err = '';
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => { err += chunk; });

    // A missing ssh binary is an 'error' event rather than an exit code, and
    // with no listener it would take the process down.
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout: Buffer.concat(out), stderr: err.trim() });
    });

    if (stdin !== undefined) {
      child.stdin.end(stdin);
    }
  });
}

// A host is reachable and has a usable claude-profiler, or it does not. The
// three outcomes are distinguished because each one needs a different thing
// said about it: an unreachable host is the person's problem to fix, a missing
// tool is one this can offer to fix, and a too-old tool needs updating.
async function probe(host) {
  // Both questions in one round trip: whether the command is there at all, and
  // what it says to `--json probe`. A version too old to know the flag treats
  // it as a filename and exits non-zero, which is indistinguishable from the
  // command being absent — so "is it installed" has to be asked separately
  // rather than inferred from the failure.
  const { stdout, stderr } = await ssh(host,
    'command -v claude-profiler >/dev/null && echo INSTALLED || echo ABSENT; ' +
    'claude-profiler --json probe 2>/dev/null'
  );

  const output = stdout.toString('utf8');
  const [first, ...rest] = output.split('\n');
  const installed = first.trim() === 'INSTALLED';
  const reply = rest.join('\n').trim();

  if (installed && reply) {
    let parsed;
    try {
      parsed = JSON.parse(reply);
    } catch {
      // Installed, answered something, but not this protocol: an older version
      // printing a message of its own.
      return { status: 'outdated' };
    }
    return parsed.protocol === PROTOCOL
      ? { status: 'ok', version: parsed.version }
      : { status: 'outdated', version: parsed.version };
  }

  if (installed) {
    // There, but with nothing to say about `--json`: too old to be driven.
    return { status: 'outdated' };
  }

  // Neither answer came back, which is also what an ssh that could not connect
  // looks like. `echo ok` is the cheapest way to tell those apart.
  const reachable = await ssh(host, 'echo ok');
  if (reachable.code !== 0) {
    return {
      status: 'unreachable',
      message: reachable.stderr || stderr || `ssh ${host} exited ${reachable.code}`
    };
  }

  return { status: 'missing' };
}

// Installs the published package on the remote, which is the offer made when
// the probe comes back missing. npm's output goes to this terminal as it runs:
// a global install over a slow link takes long enough that silence reads as a
// hang.
function install(host) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ssh', sshArgs(host, `npm install -g ${shellQuote(PACKAGE)}`),
      { stdio: 'inherit' }
    );
    child.on('error', reject);
    child.on('close', (code) => resolve(code === 0));
  });
}

// The remote's session list, in the same shape listSessions builds locally —
// renderPage cannot tell the difference, which is the point.
async function listSessions(host) {
  const { code, stdout, stderr } = await ssh(host, 'claude-profiler --json list');
  if (code !== 0) {
    throw new Error(stderr || `Listing sessions on ${host} failed`);
  }

  return JSON.parse(stdout.toString('utf8')).sessions;
}

// How fresh the remote thinks a session is, as the mtime of its file. This is
// what the profile cache is keyed on, so that clicking a session again after
// working in it some more rebuilds rather than serving the profile from
// before. One stat over ssh, which is fast enough to do on every click.
async function stamp(host, id) {
  const { code, stdout } = await ssh(
    host, `claude-profiler --json stamp ${shellQuote(id)}`
  );

  // A session that has gone, or a remote that could not answer: either way
  // there is nothing to profile, and the caller turns this into a 404.
  if (code !== 0) {
    return null;
  }

  try {
    return JSON.parse(stdout.toString('utf8')).stamp;
  } catch {
    return null;
  }
}

// One built profile, as the bytes the front end will fetch. Built on the
// remote and sent whole: the alternative is copying the session's transcripts
// here and building locally, which moves more bytes to reach the same JSON.
//
// Nothing decodes it on this side — it is served straight through — so it
// stays a Buffer the whole way.
async function buildProfile(host, id, { size = false, at = 'peak' } = {}) {
  const flags = [
    '--json', 'profile', shellQuote(id),
    ...(size ? ['--size', '--at', shellQuote(at)] : [])
  ].join(' ');

  const { code, stdout, stderr } = await ssh(host, `claude-profiler ${flags}`);
  if (code !== 0) {
    throw new Error(stderr || `Building the profile on ${host} failed`);
  }

  return stdout;
}

module.exports = {
  PROTOCOL, PACKAGE, probe, install, listSessions, stamp, buildProfile,
  shellQuote
};
