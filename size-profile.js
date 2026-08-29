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

// Builds the stack for a chunk of Bash output: the producing command, then the
// filters that trimmed it, so `| head -30` shows up as the reason the output is
// the size it is.
function bashFrames(chunk) {
  const producers = chunk.segments.filter(s => s.producer && !s.producer.isSetup);
  if (producers.length === 0) {
    // Setup-only, or an echo: name it after whatever is there.
    const only = chunk.segments[0];
    if (!only) return ['(unattributed)'];
    return [only.isEcho ? 'echo (separator)' : only.producer ? only.producer.name : '(unattributed)'];
  }

  // Several commands share one chunk when no anchor separates them. A loop is
  // one repeated unit, so it becomes a frame with its body underneath; the
  // rest are named together, since which of them printed what is not knowable.
  if (producers.length > 1) {
    const loop = producers.find(s => LOOPS.has(s.producer.name));
    const body = producers.filter(s => !LOOPS.has(s.producer.name));
    const names = [...new Set(body.map(s => s.producer.name))];

    if (loop) {
      // A single-command loop body is the interesting case: `for … do pq …`.
      if (names.length === 1) {
        const only = body.find(s => s.producer.name === names[0]);
        return [`${loop.producer.name} loop`, ...stageFrames(only)];
      }
      return [
        `${loop.producer.name} loop`,
        names.length > 0 ? summarizeNames(names) : '(loop body)'
      ];
    }

    // The same command run several times is that command, not a composite.
    if (names.length === 1) {
      const only = body.find(s => s.producer.name === names[0]);
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
// `profiler-cli marker info` aggregates into one place in the tree. Flags are
// left out of a producer's name — they fragment it without saying much — but
// kept for a filter, where `head -30` is exactly the interesting part.
function describeFrame(stage) {
  const parts = [stage.name, ...(stage.subcommands || [])];
  if (stage.isFilter) {
    if (stage.flags.length > 0) parts.push(stage.flags.join(' '));
    if (stage.detail && stage.detail.length <= 24) parts.push(stage.detail);
  }
  return parts.join(' ');
}

// Everything the profile needs to know about one contribution of bytes.
class SizeProfileBuilder {
  // `shared` holds the string table, which the profile format keeps at
  // profile.shared.stringArray for every thread at once. Each track still has
  // its own frame and stack tables, since those are per-thread.
  constructor(shared) {
    this.shared = shared || { strings: [], stringMap: new Map() };
    this.strings = this.shared.strings;
    this.stringMap = this.shared.stringMap;
    this.funcMap = new Map();
    this.frameMap = new Map();
    this.stackMap = new Map();
    this.frameTable = { func: [], category: [] };
    this.stackTable = { frame: [], prefix: [] };
    // stack index -> bytes
    this.weights = new Map();
  }

  intern(text) {
    if (!this.stringMap.has(text)) {
      this.stringMap.set(text, this.strings.length);
      this.strings.push(text);
    }
    return this.stringMap.get(text);
  }

  frame(name, category) {
    const nameIndex = this.intern(name);
    const key = `${nameIndex}:${category}`;
    if (!this.frameMap.has(key)) {
      this.frameMap.set(key, this.frameTable.func.length);
      this.frameTable.func.push(nameIndex);
      this.frameTable.category.push(category);
    }
    return this.frameMap.get(key);
  }

  stack(frames, category) {
    let prefix = null;
    for (const name of frames) {
      const frameIndex = this.frame(name, category);
      const key = `${frameIndex}:${prefix === null ? 'r' : prefix}`;
      if (!this.stackMap.has(key)) {
        this.stackMap.set(key, this.stackTable.frame.length);
        this.stackTable.frame.push(frameIndex);
        this.stackTable.prefix.push(prefix);
      }
      prefix = this.stackMap.get(key);
    }
    return prefix;
  }

  // Adds bytes at a stack. Contributions to the same stack are summed, so the
  // sample count stays proportional to the number of distinct stacks rather
  // than to the number of messages.
  add(frames, category, bytes) {
    if (bytes <= 0 || frames.length === 0) return;
    const stackIndex = this.stack(frames, category);
    if (stackIndex === null) return;
    this.weights.set(stackIndex, (this.weights.get(stackIndex) || 0) + bytes);
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

    const frameCount = this.frameTable.func.length;
    // One func per interned string: funcTable.name indexes the shared string
    // array, so every thread's table covers the whole array.
    const funcCount = this.strings.length;

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
      stackTable: {
        length: this.stackTable.frame.length,
        prefix: this.stackTable.prefix,
        frame: this.stackTable.frame
      },
      frameTable: {
        length: frameCount,
        address: new Array(frameCount).fill(-1),
        category: this.frameTable.category,
        subcategory: new Array(frameCount).fill(0),
        func: this.frameTable.func,
        nativeSymbol: new Array(frameCount).fill(null),
        innerWindowID: new Array(frameCount).fill(0),
        line: new Array(frameCount).fill(null),
        column: new Array(frameCount).fill(null),
        inlineDepth: new Array(frameCount).fill(0)
      },
      funcTable: {
        length: funcCount,
        name: Array.from({ length: funcCount }, (_, i) => i),
        isJS: new Array(funcCount).fill(false),
        relevantForJS: new Array(funcCount).fill(false),
        resource: new Array(funcCount).fill(-1),
        fileName: new Array(funcCount).fill(null),
        lineNumber: new Array(funcCount).fill(null),
        columnNumber: new Array(funcCount).fill(null)
      },
      resourceTable: { length: 0, lib: [], name: [], host: [], type: [] },
      nativeSymbols: { length: 0, address: [], functionSize: [], libIndex: [], name: [] },
      totalBytes: position
    };
  }
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
  describeFrame
};
