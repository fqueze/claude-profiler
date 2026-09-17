// The Claude backend for the session picker. It discovers Claude Code's
// on-disk sessions and normalizes each one into the row shape consumed by the
// shared page renderer.

const fs = require('fs');
const os = require('os');
const path = require('path');

// A gap longer than this is the session waiting for its user rather than
// working. Sixty seconds is well past a slow tool call but well short of the
// pauses that make a wall-clock duration meaningless.
const ACTIVE_GAP = 60 * 1000;

function projectsDir() {
  return path.join(
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    'projects'
  );
}

// Every session file under ~/.claude/projects/<project>/<session-id>.jsonl.
// The per-session <session-id>/ directories next to them hold the sub-agent
// transcripts, and are walked by readSubagents rather than listed here.
function findSessionFiles(root = projectsDir()) {
  if (!fs.existsSync(root)) {
    return [];
  }

  const files = [];
  for (const project of fs.readdirSync(root)) {
    const dir = path.join(root, project);
    if (!statSafe(dir)?.isDirectory()) {
      continue;
    }

    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) {
        continue;
      }
      const file = path.join(dir, name);
      if (statSafe(file)?.isFile()) {
        files.push({ project, file });
      }
    }
  }

  return files;
}

// A session being written to can lose a file between readdir and stat, and a
// broken symlink throws the same way; neither is a reason to fail the listing.
function statSafe(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

// The project directory name is the working directory with its separators
// replaced by dashes, which is ambiguous — a real dash and a separator look the
// same. The entries record the actual `cwd`, so this is only the fallback for a
// session that has none.
function projectLabel(project) {
  return project.replace(/^-/, '/').replace(/-/g, '/');
}

// Sub-agent transcripts are the bulk of a session's bytes, so a session's size
// is only meaningful with them included. Summing the file sizes avoids reading
// 158MB of transcripts when all that is wanted is a number.
function subagentBytes(sessionFile) {
  const dir = path.join(
    path.dirname(sessionFile),
    path.basename(sessionFile, '.jsonl'),
    'subagents'
  );

  if (!fs.existsSync(dir)) {
    return { bytes: 0, count: 0 };
  }

  let bytes = 0;
  let count = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) {
      continue;
    }
    bytes += statSafe(path.join(dir, name))?.size || 0;
    count++;
  }

  return { bytes, count };
}

// One row of the table. Everything here comes from a single pass over the
// session's own entries plus a stat of each sub-agent file: parsing the
// sub-agent transcripts as well would triple the work for numbers the row
// already has, since their cost is rolled into `cost` below only when asked.
function summarizeSession({ project, file }, deps) {
  const { readJsonlFile, sessionTitle, conversationEntries, totalCost } = deps;

  const stat = statSafe(file);
  const entries = readJsonlFile(file);
  const agents = subagentBytes(file);

  let firstTimestamp = null;
  let lastTimestamp = null;
  let cwd = null;
  let gitBranch = null;
  let version = null;
  // Wall clock is a poor measure of a session: one left open overnight reads as
  // 142 hours of which six minutes were work. Summing only the gaps short
  // enough to be the session working — the same distinction the timeline draws
  // as its Idle category — is what makes the column comparable between rows.
  let active = 0;
  let previous = null;
  for (const entry of entries) {
    if (entry.timestamp) {
      firstTimestamp = firstTimestamp || entry.timestamp;
      lastTimestamp = entry.timestamp;

      const at = new Date(entry.timestamp).getTime();
      if (previous !== null && at > previous && at - previous <= ACTIVE_GAP) {
        active += at - previous;
      }
      previous = at;
    }
    // The last one wins: a session can change branch, and its final state is
    // the one worth showing.
    cwd = entry.cwd || cwd;
    gitBranch = entry.gitBranch || gitBranch;
    version = entry.version || version;
  }

  const messages = conversationEntries(entries);

  return {
    id: path.basename(file, '.jsonl'),
    file,
    project,
    title: sessionTitle(entries),
    cwd: cwd || projectLabel(project),
    gitBranch: gitBranch || '',
    version: version || '',
    // The file's own mtime is the fallback for a session whose entries carry no
    // timestamp at all, so that sorting by date never has a hole in it.
    started: firstTimestamp || stat?.mtime.toISOString() || null,
    ended: lastTimestamp || stat?.mtime.toISOString() || null,
    active,
    messages: messages.length,
    entries: entries.length,
    bytes: (stat?.size || 0) + agents.bytes,
    subagents: agents.count,
    cost: totalCost(messages)
  };
}

// The sub-agents' own API calls, which is most of a session's cost when it
// spawned any. Kept separate from summarizeSession because it means reading
// every sub-agent transcript.
function subagentCost(sessionFile, deps) {
  const { readSubagents, conversationEntries, totalCost } = deps;

  try {
    return readSubagents(sessionFile).reduce(
      (sum, agent) => sum + totalCost(conversationEntries(agent.entries)),
      0
    );
  } catch {
    return 0;
  }
}

// Every session, newest first. A file that fails to parse is skipped rather
// than taking the whole listing down with it: a session being written to can be
// caught mid-line.
function listSessions(deps, { root, withSubagentCost = true } = {}) {
  const sessions = [];

  for (const entry of findSessionFiles(root)) {
    let session;
    try {
      session = summarizeSession(entry, deps);
    } catch {
      continue;
    }

    // A session with no messages is one Claude Code opened and nothing came of
    // — there is nothing to profile in it.
    if (session.messages === 0) {
      continue;
    }

    if (withSubagentCost && session.subagents > 0) {
      session.cost += subagentCost(session.file, deps);
    }

    sessions.push(session);
  }

  // Most recently active first: the session someone wants to profile is
  // usually the one they were just in, which is not the one that was opened
  // most recently — a session started last week can be the live one.
  return sessions.sort((a, b) => (b.ended || '').localeCompare(a.ended || ''));
}

module.exports = {
  findSessionFiles,
  listSessions,
  summarizeSession,
  projectLabel
};
