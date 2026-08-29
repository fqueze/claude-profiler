// Renders a session as one plain-text document, and records which line each
// piece of content starts on.
//
// This is what makes the profiler's source view usable on a conversation: a
// frame gets a source file and a line number, so double-clicking a call node in
// the call tree or the flame graph opens the transcript scrolled to the output
// that frame is about. Line hits are the sample weights, so the view shades
// each line by how many bytes it put in the context window — a command whose
// output is one long useless block shows up as exactly that.
//
// The document is meant to be read, to judge whether a command's output was
// worth its bytes. Since the view scrolls to the right line on its own, there
// are no separators to find a place by: a tool call is its command line
// followed by what the command printed, which is how it would look in a
// terminal.

// A Bash call's command and its output are one event, so they are written as one
// block: the command on a `$ ` line, then its output beneath. Everything else
// gets a one-line header naming what it is, since there is no equivalent of a
// prompt line for a message or a file edit.
const PROMPT = '$ ';

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return null;
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60000);
  return `${minutes}m ${Math.round((ms % 60000) / 1000)}s`;
}

// `2026-08-28T21:16:53.180Z` -> `21:16:53`, since the date is in the header.
function timeOfDay(timestamp) {
  return timestamp ? String(timestamp).slice(11, 19) : '';
}

class Document {
  constructor() {
    this.lines = [];
  }

  // 1-based, matching the source view's numbering.
  get nextLine() {
    return this.lines.length + 1;
  }

  push(text) {
    this.lines.push(text);
  }

  // Adds a block of possibly multi-line text, returning the line its first line
  // landed on. Trailing blank lines are dropped: a tool result almost always
  // ends with a newline, and keeping it would put a gap before the next entry.
  pushBlock(text) {
    const at = this.nextLine;
    const body = String(text).replace(/\r\n/g, '\n').split('\n');
    while (body.length > 1 && body[body.length - 1].trim() === '') {
      body.pop();
    }
    for (const line of body) {
      this.lines.push(line);
    }
    return at;
  }

  blank() {
    this.lines.push('');
  }

  toString() {
    return `${this.lines.join('\n')}\n`;
  }
}

// When each tool call started and how long it took, paired the way the timeline
// profile does it: a call runs from the request to its result. The timestamps on
// the two entries are close together — both are written when the message is
// logged — so the duration comes from the pair rather than from either alone.
function timeToolCalls(entries) {
  const timing = new Map();

  for (const entry of entries) {
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    const time = entry.timestamp ? new Date(entry.timestamp).getTime() : null;

    for (const block of content) {
      if (block.type === 'tool_use') {
        timing.set(block.id, { start: time, startedAt: entry.timestamp, end: null });
      } else if (block.type === 'tool_result') {
        const call = timing.get(block.tool_use_id);
        if (call && time !== null) {
          call.end = time;
        }
      }
    }
  }

  return timing;
}

// Walks the entries of one agent and writes them out, recording the line every
// block a frame may point at starts on. Keys match how the size attribution
// identifies a block: `${toolUseId}:output`, `${toolUseId}:call`, or a message
// uuid for text.
function renderTranscript(entries, toolUses, options = {}) {
  const document = new Document();
  const lineFor = new Map();
  const record = (key, line) => {
    if (key && !lineFor.has(key)) {
      lineFor.set(key, line);
    }
  };

  const timing = timeToolCalls(entries);

  document.push(`# ${options.title || 'Claude session'}`);
  if (options.subtitle) {
    document.push(`# ${options.subtitle}`);
  }
  document.push('#');
  document.push('# Every line below is a line of this context window. The gutter');
  document.push('# shows how many bytes each one contributed to it.');
  document.blank();

  for (const entry of entries) {
    const content = entry.message?.content;
    const role = entry.message?.role || entry.type;
    const at = timeOfDay(entry.timestamp);

    if (typeof content === 'string') {
      if (content.trim().length === 0) continue;
      document.push(`${at} ${role}:`);
      record(entry.uuid, document.pushBlock(content));
      document.blank();
      continue;
    }

    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type === 'text') {
        if (!block.text || block.text.trim().length === 0) continue;
        document.push(`${at} ${role}:`);
        record(entry.uuid, document.pushBlock(block.text));
        document.blank();
        continue;
      }

      if (block.type === 'tool_use') {
        // The command line, written as a shell prompt so it reads as the thing
        // that produced the output following it. The output itself is appended
        // when the matching result comes along, with no header in between.
        const call = timing.get(block.id);
        const started = timeOfDay(call?.startedAt || entry.timestamp);

        if (block.name === 'Bash') {
          document.push(`${started} ${PROMPT}${(block.input?.command || '').replace(/\n/g, `\n${' '.repeat(PROMPT.length)}`)}`);
          record(`${block.id}:call`, document.nextLine - 1);
        } else {
          document.push(`${started} ${block.name}:`);
          record(`${block.id}:call`, document.pushBlock(
            JSON.stringify(block.input || {}, null, 2)
          ));
        }
        continue;
      }

      if (block.type === 'tool_result') {
        const use = toolUses.get(block.tool_use_id);
        const call = timing.get(block.tool_use_id);

        let text = block.content;
        if (Array.isArray(text)) {
          text = text.map(part => part.text || '').join('');
        }
        if (typeof text !== 'string') {
          text = text == null ? '' : JSON.stringify(text);
        }

        // A note on the size and how long it took, so a big slow call is
        // recognisable without counting lines. It sits after the command, where
        // a shell would have printed nothing.
        const duration = call && call.end !== null && call.start !== null
          ? formatDuration(call.end - call.start)
          : null;
        const bytes = Buffer.byteLength(text, 'utf8');
        const note = [formatBytes(bytes), duration].filter(Boolean).join(', ');

        if (text.trim().length === 0) {
          document.push(`  (no output — ${note})`);
          record(`${block.tool_use_id}:output`, document.nextLine - 1);
          document.blank();
          continue;
        }

        // Only worth saying for output big enough to wonder about.
        if (bytes >= 4096) {
          document.push(`  (${note})`);
        }

        record(`${block.tool_use_id}:output`, document.pushBlock(text));
        document.blank();
        continue;
      }

      if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        document.push(`${at} thinking: (not written to the log, only its signature)`);
        document.blank();
      }
    }
  }

  return { text: document.toString(), lineFor, lineCount: document.lines.length };
}

module.exports = { renderTranscript, formatBytes, formatDuration, timeToolCalls };
