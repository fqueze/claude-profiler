// Turns a session into a size profile of its context window.
//
// The window is not the whole log: content leaves it when the conversation is
// compacted, and each sub-agent has a window of its own. What is resident at a
// given API call is the chain of messages leading to it, which the log records
// through parentUuid — so the window is reconstructed by walking that chain
// back from a call, stopping at the most recent compaction boundary.
//
// Byte counts are exact. Token counts are derived by calibrating bytes against
// the token counts the API itself reported for each call, which is both
// dependency-free and self-correcting: there is no offline tokenizer for these
// models, and the ratio varies with the kind of content in the window.

const {
  CATEGORY,
  SizeProfileBuilder,
  splitOutputByEchoes,
  bashFrames,
  toolSubject,
  byteLength,
  resultText,
  describeFrame,
  summarizeNames,
  createSharedTables,
  buildSharedData
} = require('./size-profile.js');
const { parseCommand } = require('./shell-parse.js');
const { renderTranscript } = require('./transcript.js');

function contextTokens(usage) {
  return (usage.input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0);
}

// The API calls in a set of entries, one per requestId, in order.
function apiCalls(entries) {
  const seen = new Set();
  const calls = [];
  for (const entry of entries) {
    const usage = entry.message?.usage;
    if (!usage || !entry.requestId || seen.has(entry.requestId)) continue;
    seen.add(entry.requestId);
    calls.push(entry);
  }
  return calls;
}

// Walks parentUuid back from an entry, newest first, stopping after a
// compaction boundary: everything before it left the window.
function contextChain(entry, byUuid, boundaries) {
  const chain = [entry];
  let current = entry.parentUuid ? byUuid.get(entry.parentUuid) : null;
  const guard = new Set([entry.uuid]);

  while (current && !guard.has(current.uuid)) {
    guard.add(current.uuid);
    chain.push(current);
    if (boundaries.has(current.uuid)) break;
    current = current.parentUuid ? byUuid.get(current.parentUuid) : null;
  }

  return chain;
}

// Fits `tokens ≈ overhead + bytes / bytesPerToken` over a session's API calls.
// The intercept is the part of the window that is never in the log — the system
// prompt, the tool schemas and CLAUDE.md — and the slope is how densely this
// session's content tokenizes.
function calibrate(points) {
  const usable = points.filter(point => point.tokens > 0 && point.bytes > 0);
  if (usable.length < 3) {
    // Not enough to fit; fall back to a ratio seen across sessions.
    return { bytesPerToken: 2.34, overhead: 0, samples: usable.length, fitted: false };
  }

  const n = usable.length;
  const sx = usable.reduce((sum, p) => sum + p.bytes, 0);
  const sy = usable.reduce((sum, p) => sum + p.tokens, 0);
  const sxx = usable.reduce((sum, p) => sum + p.bytes * p.bytes, 0);
  const sxy = usable.reduce((sum, p) => sum + p.bytes * p.tokens, 0);
  const denominator = n * sxx - sx * sx;

  if (denominator === 0) {
    return { bytesPerToken: 2.34, overhead: 0, samples: n, fitted: false };
  }

  const slope = (n * sxy - sx * sy) / denominator;
  const intercept = (sy - slope * sx) / n;

  if (!(slope > 0)) {
    return { bytesPerToken: 2.34, overhead: Math.max(0, intercept), samples: n, fitted: false };
  }

  const errors = usable
    .map(p => Math.abs(intercept + slope * p.bytes - p.tokens) / p.tokens)
    .sort((a, b) => a - b);

  return {
    bytesPerToken: 1 / slope,
    overhead: Math.max(0, Math.round(intercept)),
    samples: n,
    fitted: true,
    medianError: errors[Math.floor(errors.length / 2)],
    maxError: errors[errors.length - 1]
  };
}

// Attributes the bytes of one message to stacks. `add(frames, category, bytes)`
// is called once per contribution.
function attributeEntry(entry, toolUses, add, lineFor) {
  const content = entry.message?.content;
  const role = entry.message?.role || entry.type;
  // Where this content sits in the transcript document, so the source view can
  // scroll to it. Absent when no transcript was rendered.
  const lineOf = key => (lineFor ? lineFor.get(key) : undefined);

  if (typeof content === 'string') {
    const category = role === 'user' ? CATEGORY['User text'] : CATEGORY['Assistant text'];
    add([role === 'user' ? 'User prompt' : 'Assistant text'], category,
      byteLength(content), lineOf(entry.uuid));
    return;
  }

  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (block.type === 'text') {
      const category = role === 'user' ? CATEGORY['User text'] : CATEGORY['Assistant text'];
      add([role === 'user' ? 'User prompt' : 'Assistant text'], category,
        byteLength(block.text), lineOf(entry.uuid));
      continue;
    }

    if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      // Only the signature survives in the log; the reasoning text does not.
      add(['Thinking (signature only)'], CATEGORY.Other, byteLength(JSON.stringify(block)));
      continue;
    }

    if (block.type === 'tool_use') {
      const bytes = byteLength(JSON.stringify(block.input || {}));
      const frames = [`${block.name} (call)`];
      const subject = toolSubject(block.name, block.input);

      if (block.name === 'Bash') {
        // The command text is context too, and a heredoc writing a file makes
        // it the biggest part of the call.
        const command = block.input?.command || '';
        const segments = parseCommand(command);
        // Named the same way as the output frames, subcommand included, so a
        // call and its output sit under matching names in the tree.
        const producers = [...new Set(
          segments.filter(s => s.producer && !s.producer.isSetup && !s.isEcho)
            .map(s => describeFrame(s.producer))
        )];
        if (producers.length > 0) frames.push(summarizeNames(producers));
      } else if (subject) {
        frames.push(subject);
      }

      add(frames, CATEGORY['Tool call'], bytes, lineOf(`${block.id}:call`));
      continue;
    }

    if (block.type === 'tool_result') {
      const use = toolUses.get(block.tool_use_id);
      const name = use ? use.name : 'unknown tool';
      const text = resultText(block);

      const outputLine = lineOf(`${block.tool_use_id}:output`);

      if (use && use.name === 'Bash') {
        attributeBashOutput(use, text, add, outputLine);
        continue;
      }

      const frames = [`${name} (output)`];
      const subject = use ? toolSubject(name, use.input) : null;
      if (subject) frames.push(subject);
      add(frames, CATEGORY['Tool output'], byteLength(text), outputLine);
      continue;
    }

    if (block.type === 'image') {
      add(['Image'], CATEGORY.Other, byteLength(JSON.stringify(block)));
    }
  }
}

// A Bash call's output, split among the commands that produced it.
function attributeBashOutput(use, output, add, outputLine) {
  const command = use.input?.command || '';
  const segments = parseCommand(command);

  if (segments.length === 0) {
    add(['Bash (output)'], CATEGORY['Tool output'], byteLength(output), outputLine);
    return;
  }

  // Each chunk points at its own place within the output, so double-clicking a
  // command in the tree lands on what that command printed rather than at the
  // top of a long combined output.
  let consumed = 0;
  for (const chunk of splitOutputByEchoes(output, segments)) {
    const bytes = byteLength(chunk.text);
    const newlines = countNewlines(chunk.text);
    if (bytes === 0) {
      consumed += newlines;
      continue;
    }
    const isSeparator = chunk.segments.length === 1 && chunk.segments[0].isEcho;
    add(
      ['Bash (output)', ...bashFrames(chunk)],
      isSeparator ? CATEGORY.Other : CATEGORY['Tool output'],
      bytes,
      outputLine === undefined ? undefined : outputLine + consumed
    );
    consumed += newlines;
  }
}

function countNewlines(text) {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') count++;
  }
  return count;
}

// Builds one track: the context window of one agent at the point given.
function buildTrack({
  entries, byUuid, boundaries, name, processName, pid, atCall, shared, options = {}
}) {
  const calls = apiCalls(entries);
  if (calls.length === 0) return null;

  const points = [];
  let peak = null;
  for (const call of calls) {
    const chain = contextChain(call, byUuid, boundaries);
    let bytes = 0;
    for (const link of chain) {
      const content = link.message?.content;
      bytes += typeof content === 'string'
        ? byteLength(content)
        : Array.isArray(content) ? byteLength(JSON.stringify(content)) : 0;
    }
    const tokens = contextTokens(call.message.usage);
    points.push({ bytes, tokens, call, chain });
    if (!peak || tokens > peak.tokens) peak = points[points.length - 1];
  }

  const calibration = calibrate(points);

  // Which call's window to profile: the peak by default, or the last one.
  const chosen = atCall === 'last' ? points[points.length - 1] : peak;
  const toolUses = new Map();
  for (const entry of entries) {
    const content = entry.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use') toolUses.set(block.id, block);
      }
    }
  }

  // The transcript of exactly what is in this window, so the source view shows
  // the context and nothing else. Oldest first, in conversation order.
  const resident = [...chosen.chain].reverse();
  const transcript = renderTranscript(resident, toolUses, {
    title: name,
    subtitle: `${processName} — context window at ${chosen.call.timestamp}`
  });

  const builder = new SizeProfileBuilder(shared);
  builder.useSource(options.sourceFile, transcript.text, processName);
  const add = (frames, category, bytes, line) =>
    builder.add(frames, category, bytes, line);

  for (const entry of resident) {
    attributeEntry(entry, toolUses, add, transcript.lineFor);
  }

  // The part of the window that is not in the log at all. Shown so the tree
  // adds up to what the API reported rather than silently missing a third.
  if (calibration.overhead > 0) {
    const overheadBytes = Math.round(calibration.overhead * calibration.bytesPerToken);
    add(
      ['System prompt + tool schemas (not logged)'],
      CATEGORY.Unlogged,
      overheadBytes
    );
  }

  const thread = builder.buildThread({ name, pid, tid: pid, processName });

  return {
    thread,
    transcript,
    calibration,
    reportedTokens: chosen.tokens,
    timestamp: chosen.call.timestamp,
    callIndex: points.indexOf(chosen),
    callCount: points.length
  };
}

// `subagents` comes from readSubagents(); each gets its own track, as in the
// timeline profile.
function createSizeProfile(jsonlData, subagents, options = {}) {
  const atCall = options.at === 'last' ? 'last' : 'peak';

  const byUuid = new Map();
  const boundaries = new Set();
  const register = (entries) => {
    for (const entry of entries) {
      if (entry.uuid) byUuid.set(entry.uuid, entry);
      if (entry.subtype === 'compact_boundary' || entry.isCompactSummary) {
        boundaries.add(entry.uuid);
      }
    }
  };

  register(jsonlData);
  (subagents || []).forEach(agent => register(agent.entries));

  // One string table and one set of stack/frame/func tables for the whole
  // profile: from v60 on they live on profile.shared rather than per thread.
  const shared = createSharedTables();

  // Each track's transcript becomes a source file whose content is embedded in
  // the profile, so the source view reads it directly — no symbol server, and a
  // saved profile stays readable on its own.
  const usedNames = new Map();
  const trackSource = (label) => {
    const base = `${slug(label)}.context.txt`;
    const seen = usedNames.get(base) || 0;
    usedNames.set(base, seen + 1);
    // Two sub-agents can share a description, and a source file is keyed by name.
    return { sourceFile: seen === 0 ? base : `${slug(label)}-${seen + 1}.context.txt` };
  };

  const tracks = [];
  const main = buildTrack({
    entries: jsonlData,
    byUuid,
    boundaries,
    name: sessionName(jsonlData),
    processName: 'Main conversation',
    pid: 0,
    atCall,
    shared,
    options: trackSource(sessionName(jsonlData))
  });

  if (!main) {
    throw new Error('No API calls found in the jsonl file');
  }
  tracks.push(main);

  (subagents || []).forEach((agent, index) => {
    const track = buildTrack({
      entries: agent.entries,
      byUuid,
      boundaries,
      name: agent.meta.description || agent.id,
      processName: `${agent.meta.agentType || 'agent'} (depth ${agent.meta.spawnDepth || 1})`,
      pid: index + 1,
      atCall,
      shared,
      options: trackSource(agent.meta.description || agent.id)
    });
    if (track) tracks.push(track);
  });

  const totalBytes = tracks.reduce((sum, track) => sum + track.thread.totalBytes, 0);

  return {
    meta: {
      // v64 is the first version whose sources table has a `content` column,
      // which is where each transcript is embedded. Earlier versions get their
      // sources table rebuilt by the upgraders, which would drop the content.
      version: 64,
      preprocessedProfileVersion: 64,
      startTime: 0,
      processType: 0,
      product: `Claude context size — ${sessionName(jsonlData)}`,
      interval: 1,
      markerSchema: [],
      symbolicationNotSupported: true,
      usesOnlyOneStackType: true,
      categories: require('./size-profile.js').CATEGORIES.map(category => ({
        name: category.name,
        color: category.color,
        subcategories: ['Other']
      })),
      sampleUnits: { time: 'bytes', eventDelay: 'ms', threadCPUDelta: 'µs' }
    },
    libs: [],
    threads: tracks.map(track => {
      const { totalBytes: _ignored, ...thread } = track.thread;
      return thread;
    }),
    profilingLog: [],
    // Built last, once every track has interned into the shared tables.
    shared: buildSharedData(shared),
    // Reporting data for the CLI, not part of the profile format.
    tracks,
    totalBytes
  };
}

// A filename made from a track's name: it is shown in the source view's header
// and used as the key the source is looked up by.
function slug(label) {
  const cleaned = String(label || 'session')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return (cleaned || 'session').slice(0, 60);
}

function sessionName(jsonlData) {
  for (let i = jsonlData.length - 1; i >= 0; i--) {
    if (jsonlData[i].type === 'ai-title' && jsonlData[i].aiTitle) return jsonlData[i].aiTitle;
    if (jsonlData[i].type === 'summary' && jsonlData[i].summary) return jsonlData[i].summary;
  }
  return 'Claude session';
}

module.exports = {
  createSizeProfile,
  contextChain,
  calibrate,
  apiCalls,
  contextTokens,
  attributeEntry,
  buildTrack
};
