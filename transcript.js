// Renders a session as one plain-text document, and records which line each
// piece of content starts on.
//
// This is what makes the profiler's source view usable on a conversation: a
// frame gets a filename and a line number, so double-clicking a call node in
// the call tree or the flame graph opens the transcript scrolled to the output
// that frame is about. Line hits are the sample weights, so the view shades
// each line by how many bytes it put in the context window — a command whose
// output is one long useless block shows up as exactly that.
//
// The document is deliberately readable rather than machine-parseable: it is
// meant to be looked at, to judge whether a command's output was worth its
// bytes.

const MAX_HEADER = 100;

function truncate(text, limit) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

// Accumulates lines and hands back the line number a block starts at.
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

  // Adds a block of possibly multi-line text, and returns the line its first
  // line landed on.
  pushBlock(text) {
    const at = this.nextLine;
    const body = String(text).replace(/\r\n/g, '\n').split('\n');
    for (const line of body) {
      this.lines.push(line);
    }
    return at;
  }

  blank() {
    this.lines.push('');
  }

  rule(title) {
    this.lines.push(`${'─'.repeat(4)} ${title} ${'─'.repeat(Math.max(0, 72 - title.length))}`);
  }

  toString() {
    return `${this.lines.join('\n')}\n`;
  }
}

// Walks the entries of one agent and writes them out, calling
// `onBlock(key, line)` for every block that a frame may want to point at.
//
// `key` identifies the block the same way the size attribution does, so the two
// can be matched up: `${toolUseId}:output`, `${toolUseId}:call`, or a message
// uuid for text.
function renderTranscript(entries, toolUses, options = {}) {
  const document = new Document();
  const lineFor = new Map();
  const record = (key, line) => {
    if (key && !lineFor.has(key)) {
      lineFor.set(key, line);
    }
  };

  document.push(`# ${options.title || 'Claude session'}`);
  if (options.subtitle) {
    document.push(`# ${options.subtitle}`);
  }
  document.push('#');
  document.push('# Every line of this transcript is a line of the session\'s context window.');
  document.push('# The gutter shows how many bytes each line contributed to it.');
  document.blank();

  for (const entry of entries) {
    const content = entry.message?.content;
    const role = entry.message?.role || entry.type;
    const time = entry.timestamp ? entry.timestamp.replace('T', ' ').slice(0, 19) : '';

    if (typeof content === 'string') {
      if (content.trim().length === 0) continue;
      document.rule(`${role} ${time}`);
      record(entry.uuid, document.pushBlock(content));
      document.blank();
      continue;
    }

    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type === 'text') {
        if (!block.text || block.text.trim().length === 0) continue;
        document.rule(`${role} ${time}`);
        record(entry.uuid, document.pushBlock(block.text));
        document.blank();
        continue;
      }

      if (block.type === 'tool_use') {
        const detail = block.name === 'Bash'
          ? block.input?.command || ''
          : JSON.stringify(block.input || {}, null, 2);
        document.rule(`${block.name} call ${time}`);
        record(`${block.id}:call`, document.pushBlock(detail));
        document.blank();
        continue;
      }

      if (block.type === 'tool_result') {
        const use = toolUses.get(block.tool_use_id);
        const name = use ? use.name : 'tool';
        const header = use && use.name === 'Bash'
          ? truncate(use.input?.command || '', MAX_HEADER)
          : truncate(JSON.stringify(use?.input || {}), MAX_HEADER);

        let text = block.content;
        if (Array.isArray(text)) {
          text = text.map(part => part.text || '').join('');
        }
        if (typeof text !== 'string') {
          text = text == null ? '' : JSON.stringify(text);
        }

        const bytes = Buffer.byteLength(text, 'utf8');
        document.rule(`${name} output ${time} — ${formatBytes(bytes)}`);
        if (header) {
          document.push(`$ ${header}`);
        }
        record(`${block.tool_use_id}:output`, document.pushBlock(text));
        document.blank();
        continue;
      }

      if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        document.rule(`thinking ${time}`);
        document.push('(the reasoning text is not written to the log, only its signature)');
        document.blank();
      }
    }
  }

  return { text: document.toString(), lineFor, lineCount: document.lines.length };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

module.exports = { renderTranscript, formatBytes };
