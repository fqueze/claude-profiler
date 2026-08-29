// Builds a Firefox Profiler size profile of a session's context window: which
// tools, commands and files the bytes in the window came from.
//
// This is the same shape as an allocation profile. Bytes go on the time axis
// and in the sample weights, so the call tree and the flame graph answer "what
// is taking up the window", and a range selection sums the bytes in it. The
// stack is what produced the bytes rather than a code path:
//
//   Bash / profiler-cli / head -30 / output
//   Bash / mach / command
//   Read / browser/…/sidebar-main.mjs / output
//
// A Bash call is split further, since one call often runs several commands and
// the sizes only mean something per command. See shell-parse.js.

const { parseCommand } = require('./shell-parse.js');

// Where a byte in the window came from. Colours follow the profiler's palette.
const CATEGORIES = [
  { name: 'Other', color: 'grey' },
  { name: 'Tool output', color: 'green' },
  { name: 'Tool call', color: 'lightblue' },
  { name: 'Assistant text', color: 'purple' },
  { name: 'User text', color: 'blue' },
  { name: 'Injected context', color: 'orange' },
  { name: 'Unlogged', color: 'grey' },
  { name: 'Filtered', color: 'yellow' }
];

const CATEGORY = {};
CATEGORIES.forEach((category, index) => {
  CATEGORY[category.name] = index;
});

// Loop constructs: the loop runs its body repeatedly, so the bytes belong to
// the body rather than to the `for` itself.
const LOOPS = new Set(['for', 'while', 'until']);

function byteLength(text) {
  return typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : 0;
}

// tool_result content is either a string or an array of text blocks.
function resultText(block) {
  const content = block.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(part => part.text || '').join('');
  }
  return content == null ? '' : JSON.stringify(content);
}

// The text of an `echo` as it will appear in the output. Only usable as an
// anchor if it has no expansions, since `$var` is not known statically.
function echoOutput(segment) {
  const text = segment.echoText || '';
  if (!text) return null;

  // An expansion's value is not known statically, so only the literal text
  // before it can be matched. `echo "=== $t"` still anchors on "=== ".
  const expansion = text.search(/[$`]/);
  const literal = expansion === -1 ? text : text.slice(0, expansion);

  // Too short to be a reliable anchor: "=" or "-" would match anywhere.
  return literal.length >= 4 ? literal : null;
}

// Splits a Bash call's output among its segments, using the agent's own
// `echo "=== … ==="` markers as anchors: text between two anchors was printed
// by the commands between them. Segments before the first anchor and after the
// last are attributed to the commands in those positions.
function splitOutputByEchoes(output, segments) {
  const anchored = [];
  let searchFrom = 0;

  segments.forEach((segment, index) => {
    if (!segment.isEcho) return;
    const text = echoOutput(segment);
    if (!text) return;

    const at = output.indexOf(text, searchFrom);
    if (at === -1) return;
    anchored.push({ index, at, end: at + text.length });
    searchFrom = at + text.length;

    // Inside a loop the same echo is printed once per iteration. Each repeat is
    // another boundary, and what follows it is the loop body again rather than
    // whatever segments happen to sit after the echo in the source.
    if (!segment.inLoop) return;
    for (;;) {
      const repeat = output.indexOf(text, searchFrom);
      if (repeat === -1) break;
      anchored.push({ index, at: repeat, end: repeat + text.length, isRepeat: true });
      searchFrom = repeat + text.length;
    }
  });

  anchored.sort((a, b) => a.at - b.at);

  // Nothing to go on: the whole output belongs to the producers as a group.
  if (anchored.length === 0) {
    return [{ segments: segments.filter(s => !s.isEcho), text: output }];
  }

  const chunks = [];

  // Output printed before the first echo came from whatever ran before it.
  if (anchored[0].at > 0) {
    chunks.push({
      segments: segments.slice(0, anchored[0].index).filter(s => !s.isEcho),
      text: output.slice(0, anchored[0].at)
    });
  }

  anchored.forEach((anchor, i) => {
    const next = anchored[i + 1];
    const until = next ? next.at : output.length;
    // The echo's own bytes are attributed to the echo.
    chunks.push({
      segments: [segments[anchor.index]],
      text: output.slice(anchor.at, anchor.end)
    });

    if (until <= anchor.end) return;

    // Everything up to the next anchor came from the commands in between. Two
    // anchors at the same segment are successive iterations of one loop, so the
    // commands in between are the rest of the loop body.
    const from = anchor.index + 1;
    const to = next && next.index > anchor.index ? next.index : segments.length;
    const between = segments.slice(from, to).filter(s => !s.isEcho && s.inLoop === segments[anchor.index].inLoop);

    chunks.push({
      segments: between.length > 0
        ? between
        : segments.slice(from).filter(s => !s.isEcho),
      text: output.slice(anchor.end, until)
    });
  });

  return chunks;
}

// The label for the leaf frame of a chunk of Bash output: the full invocation
// of the command that produced it, so the leaf says what was read rather than
// just where it landed in the transcript. Null when the chunk cannot be pinned
// on one command, since then there is no single invocation to name.
function bashLeafLabel(chunk) {
  const producers = (chunk.segments || []).filter(s => s.producer && !s.producer.isSetup);
  if (producers.length === 0) {
    const only = (chunk.segments || [])[0];
    return only && only.isEcho ? describeInvocation(only.pipeline[0]) : null;
  }

  const body = producers.filter(s => !LOOPS.has(s.producer.name));
  const candidates = body.length > 0 ? body : producers;
  const names = [...new Set(candidates.map(s => describeInvocation(s.producer)))];
  if (names.length === 1) {
    return names[0];
  }

  // Several commands shared the chunk with no marker between them, so which of
  // them printed what is not knowable. Naming them all is still better than a
  // bare line number, as long as it does not read as one command: the leading
  // `+` marks it as a group.
  const listed = names.slice(0, 3).join(' + ');
  const rest = names.length > 3 ? ` + ${names.length - 3} more` : '';
  const label = `+ ${listed}${rest}`;
  return label.length > 140 ? `${label.slice(0, 140)}…` : label;
}

// Builds the stack for a chunk of Bash output: the producing command, then the
// filters that trimmed it, so `| head -30` shows up as the reason the output is
// the size it is.
function bashFrames(chunk) {
  const producers = chunk.segments.filter(s => s.producer && !s.producer.isSetup);
  if (producers.length === 0) {
    // Setup-only, or an echo: name it after whatever is there.
    const only = chunk.segments[0];
    if (!only) return ['(unattributed)'];
    if (only.isEcho) return ['echo (separator)'];
    return only.producer ? [describeFrame(only.producer)] : ['(unattributed)'];
  }

  // Several commands share one chunk when no anchor separates them. A loop is
  // one repeated unit, so it becomes a frame with its body underneath; the
  // rest are named together, since which of them printed what is not knowable.
  if (producers.length > 1) {
    const loop = producers.find(s => LOOPS.has(s.producer.name));
    const body = producers.filter(s => !LOOPS.has(s.producer.name));
    // Keyed on the full name, so `mach build` and `mach test` are two commands
    // rather than both collapsing into `mach`.
    const names = [...new Set(body.map(s => describeFrame(s.producer)))];

    if (loop) {
      // A single-command loop body is the interesting case: `for … do pq …`.
      if (names.length === 1) {
        const only = body.find(s => describeFrame(s.producer) === names[0]);
        return [`${loop.producer.name} loop`, ...stageFrames(only)];
      }
      return [
        `${loop.producer.name} loop`,
        names.length > 0 ? summarizeNames(names) : '(loop body)'
      ];
    }

    // The same command run several times is that command, not a composite.
    if (names.length === 1) {
      const only = body.find(s => describeFrame(s.producer) === names[0]);
      return stageFrames(only);
    }
    return [summarizeNames(names)];
  }

  // A single command that ran inside a loop still belongs under the loop, so
  // that repeated output aggregates in one place in the tree.
  const only = producers[0];
  return only.inLoop ? ['for loop', ...stageFrames(only)] : stageFrames(only);
}

// The frames for one command: the command, then the filters that trimmed its
// output, so `| head -30` shows as the reason the output has the size it has.
function stageFrames(segment) {
  if (!segment) return ['(unattributed)'];
  const frames = [describeFrame(segment.producer)];
  segment.filters.forEach((filter) => {
    frames.push(describeFrame(filter));
  });
  return frames;
}

function summarizeNames(names) {
  return names.length > 3
    ? `${names.slice(0, 3).join(' + ')} + ${names.length - 3} more`
    : names.join(' + ');
}

// A frame is named after the command and its subcommand, so that every
// `profiler-cli marker info` aggregates into one place in the tree.
//
// A filter keeps its flags, since `head -20` and `sed -n` describe what the
// filter did, but not its operand: the line range of a `sed -n 20430,20500p` or
// the pattern of a `grep -viE …` is different at every call site, and including
// it turns one filter into dozens of frames that never aggregate. A producer
// keeps neither, its flags fragment the name without saying much.
function describeFrame(stage) {
  const parts = [stage.name, ...(stage.subcommands || [])];
  if (stage.isFilter && stage.flags.length > 0) {
    parts.push(stage.flags.join(' '));
  }
  return parts.join(' ');
}

// The name for a frame that stands for one invocation rather than for every call
// of a command: the whole thing, operands included, so it says what was actually
// read. Aggregating frames deliberately leave these out — an operand differs at
// every call site and would stop them merging — but a leaf is that one call.
function describeInvocation(stage) {
  const parts = [
    stage.name,
    ...(stage.subcommands || []),
    ...stage.flags,
    ...(stage.args || []).map(quoteIfNeeded)
  ];
  const text = parts.join(' ');
  return text.length > 110 ? `${text.slice(0, 110)}…` : text;
}

// Arguments are shown as they would be typed, so a line range or a pattern with
// spaces reads as one argument rather than running into the next.
function quoteIfNeeded(arg) {
  return /[\s'"|&;<>()$`\\*?\[\]]/.test(arg) ? `'${arg.replace(/'/g, "'\\''")}'` : arg;
}

// Everything the profile needs to know about one contribution of bytes.
// The tables a whole profile shares: from v60 on the stack, frame, func and
// resource tables live on profile.shared rather than per thread, so every track
// interns into one set and only owns its samples.
function createSharedTables() {
  return {
    strings: [],
    stringMap: new Map(),
    funcMap: new Map(),
    frameMap: new Map(),
    stackMap: new Map(),
    frameTable: { func: [], category: [], line: [], source: [] },
    stackTable: { frame: [], prefix: [] },
    funcTable: { name: [], fileName: [], resource: [] },
    resourceTable: { lib: [], name: [], host: [], type: [] },
    // filename -> { index, content }
    sources: new Map()
  };
}

class SizeProfileBuilder {
  constructor(shared) {
    this.shared = shared || createSharedTables();
    this.strings = this.shared.strings;
    this.stringMap = this.shared.stringMap;
    // stack index -> bytes, for this track only
    this.weights = new Map();
  }

  intern(text) {
    if (!this.stringMap.has(text)) {
      this.stringMap.set(text, this.strings.length);
      this.strings.push(text);
    }
    return this.stringMap.get(text);
  }

  // `line` is where this frame's content sits in the transcript document, so
  // that double-clicking the call node scrolls the source view to it. Frames
  // sharing a name but coming from different places in the transcript are
  // separate frames, since the line is per frame; they still share a func, so
  // the call tree aggregates them under one name.
  // A func is one name in one source file. Frames sharing a name but sitting at
  // different lines of the transcript are separate frames, since the line is per
  // frame, but they share a func so the call tree aggregates them by name.
  func(name, sourceIndex, line) {
    const nameIndex = this.intern(name);
    const key = `${nameIndex}:${sourceIndex === undefined ? 'x' : sourceIndex}:${line === undefined ? 'x' : line}`;
    const { funcMap, funcTable } = this.shared;
    if (!funcMap.has(key)) {
      funcMap.set(key, funcTable.name.length);
      funcTable.name.push(nameIndex);
      funcTable.fileName.push(sourceIndex === undefined ? null : sourceIndex);
      funcTable.resource.push(this.resourceIndex === undefined ? -1 : this.resourceIndex);
    }
    return funcMap.get(key);
  }

  frame(name, category, line) {
    // Only a leaf carries a line, so a leaf gets a func of its own per location
    // while the aggregating frames above share one func per name.
    const funcIndex = this.func(name, this.sourceIndex, line);
    const key = `${funcIndex}:${category}:${line === undefined ? 'x' : line}`;
    const { frameMap, frameTable } = this.shared;
    if (!frameMap.has(key)) {
      frameMap.set(key, frameTable.func.length);
      frameTable.func.push(funcIndex);
      frameTable.category.push(category);
      frameTable.line.push(line === undefined ? null : line);
    }
    return frameMap.get(key);
  }

  // A call node merges every frame that shares a func, and the source view
  // scrolls to the heaviest line within a node — so a name that occurs in many
  // places would scroll somewhere unrelated to the box that was clicked. The
  // location therefore gets a leaf frame of its own, below the frames that
  // aggregate by name: the parents stay merged, the leaf scrolls exactly.
  stack(frames, category, line, leafLabel) {
    const path = line === undefined
      ? frames
      : [...frames, leafLabel || `line ${line}`];

    let prefix = null;
    path.forEach((name, index) => {
      const isLeaf = index === path.length - 1;
      const frameIndex = this.frame(name, category, isLeaf ? line : undefined);
      const key = `${frameIndex}:${prefix === null ? 'r' : prefix}`;
      const { stackMap, stackTable } = this.shared;
      if (!stackMap.has(key)) {
        stackMap.set(key, stackTable.frame.length);
        stackTable.frame.push(frameIndex);
        stackTable.prefix.push(prefix);
      }
      prefix = stackMap.get(key);
    });
    return prefix;
  }

  // Adds bytes at a stack. Contributions to the same stack are summed, so the
  // sample count stays proportional to the number of distinct stacks rather
  // than to the number of messages.
  add(frames, category, bytes, line, leafLabel) {
    if (bytes <= 0 || frames.length === 0) return;
    const stackIndex = this.stack(frames, category, line, leafLabel);
    if (stackIndex === null) return;
    this.weights.set(stackIndex, (this.weights.get(stackIndex) || 0) + bytes);
  }

  // Two samples per stack, as the JSON size profiler does: one at the start
  // with no weight and one at the end carrying it, so that selecting a range
  // in the timeline sums the bytes it covers.
  // Registers this track's transcript as a source file with its content
  // embedded, and a resource so funcs resolve to it. Called before attribution,
  // so funcs created afterwards pick both up.
  useSource(fileName, content, processName) {
    const { sources, resourceTable } = this.shared;
    if (!sources.has(fileName)) {
      sources.set(fileName, { index: sources.size, content });
    }
    this.sourceIndex = sources.get(fileName).index;

    this.resourceIndex = resourceTable.name.length;
    resourceTable.lib.push(null);
    resourceTable.name.push(this.intern(processName));
    resourceTable.host.push(null);
    // ResourceType.Url, since the "file" is a document rather than a library.
    resourceTable.type.push(5);
  }

  // Two samples per stack, as the JSON size profiler does: one at the start
  // with no weight and one at the end carrying it, so that selecting a range
  // in the timeline sums the bytes it covers.
  buildThread({ name, pid, tid, processName }) {
    const stack = [];
    const timeDeltas = [];
    const weight = [];
    let previous = 0;
    let position = 0;

    for (const [stackIndex, bytes] of this.weights) {
      stack.push(stackIndex);
      timeDeltas.push(position - previous);
      weight.push(0);
      previous = position;

      position += bytes;
      stack.push(stackIndex);
      timeDeltas.push(position - previous);
      weight.push(bytes);
      previous = position;
    }

    return {
      processType: 'default',
      processName,
      processStartupTime: 0,
      processShutdownTime: null,
      registerTime: 0,
      unregisterTime: null,
      pausedRanges: [],
      name,
      isMainThread: true,
      pid: String(pid),
      tid: String(tid),
      showMarkersInTimeline: false,
      samples: {
        length: stack.length,
        stack,
        timeDeltas,
        weight,
        weightType: 'bytes'
      },
      markers: {
        length: 0, category: [], data: [], endTime: [], name: [], phase: [], startTime: []
      },
      totalBytes: position
    };
  }
}

// The shared half of the profile: the tables every thread indexes into, plus
// the sources table carrying each transcript inline. Embedding the text is what
// makes the source view work without a symbol server, and keeps a saved or
// shared profile readable on its own.
function buildSharedData(shared) {
  const frameCount = shared.frameTable.func.length;
  const funcCount = shared.funcTable.name.length;
  const resourceCount = shared.resourceTable.name.length;

  const sources = {
    length: shared.sources.size,
    id: new Array(shared.sources.size).fill(null),
    filename: [],
    startLine: new Array(shared.sources.size).fill(1),
    startColumn: new Array(shared.sources.size).fill(1),
    sourceMapURL: new Array(shared.sources.size).fill(null),
    content: []
  };
  const internShared = (text) => {
    if (!shared.stringMap.has(text)) {
      shared.stringMap.set(text, shared.strings.length);
      shared.strings.push(text);
    }
    return shared.stringMap.get(text);
  };

  for (const [fileName, source] of shared.sources) {
    sources.filename[source.index] = internShared(fileName);
    sources.content[source.index] = source.content;
  }

  return {
    stringArray: shared.strings,
    stackTable: {
      length: shared.stackTable.frame.length,
      prefix: shared.stackTable.prefix,
      frame: shared.stackTable.frame
    },
    frameTable: {
      length: frameCount,
      address: new Array(frameCount).fill(-1),
      inlineDepth: new Array(frameCount).fill(0),
      category: shared.frameTable.category,
      subcategory: new Array(frameCount).fill(0),
      func: shared.frameTable.func,
      nativeSymbol: new Array(frameCount).fill(null),
      innerWindowID: new Array(frameCount).fill(null),
      line: shared.frameTable.line,
      column: new Array(frameCount).fill(null),
      originalLocation: new Array(frameCount).fill(null)
    },
    funcTable: {
      length: funcCount,
      name: shared.funcTable.name,
      isJS: new Array(funcCount).fill(false),
      relevantForJS: new Array(funcCount).fill(false),
      resource: shared.funcTable.resource,
      // From v58 on a func points at the sources table rather than a filename.
      source: shared.funcTable.fileName,
      lineNumber: new Array(funcCount).fill(null),
      columnNumber: new Array(funcCount).fill(null),
      originalLocation: new Array(funcCount).fill(null)
    },
    resourceTable: {
      length: resourceCount,
      lib: shared.resourceTable.lib,
      name: shared.resourceTable.name,
      host: shared.resourceTable.host,
      type: shared.resourceTable.type
    },
    nativeSymbols: { length: 0, address: [], functionSize: [], libIndex: [], name: [] },
    sources,
    sourceLocationTable: { source: [], line: [], column: [], length: 0 }
  };
}

// The path or subject a tool call acted on, used as the second frame so that
// files that were read repeatedly aggregate under one name.
function toolSubject(name, input) {
  if (!input) return null;
  const shorten = (value) => {
    if (typeof value !== 'string') return null;
    const trimmed = value.replace(/\s+/g, ' ').trim();
    return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
  };

  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return shorten(input.file_path || input.notebook_path);
    case 'Glob':
    case 'Grep':
      return shorten(input.pattern);
    case 'WebFetch':
    case 'WebSearch':
      return shorten(input.url || input.query);
    case 'Agent':
    case 'Task':
      return shorten(input.subagent_type || input.description);
    case 'Skill':
      return shorten(input.skill);
    case 'SendMessage':
      return shorten(input.to);
    default:
      return null;
  }
}

module.exports = {
  CATEGORIES,
  CATEGORY,
  SizeProfileBuilder,
  splitOutputByEchoes,
  bashFrames,
  toolSubject,
  byteLength,
  resultText,
  echoOutput,
  describeFrame,
  describeInvocation,
  bashLeafLabel,
  summarizeNames,
  createSharedTables,
  buildSharedData
};
