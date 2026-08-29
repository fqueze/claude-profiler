// Renders a context window as text, and records which line each block starts on.
//
// This is what the profiler's source view shows: a frame gets a source file and
// a line number, so double-clicking a call node opens the window scrolled to the
// content that frame is about. Line hits are the sample weights, so the view
// shades each line by how many bytes it put in the window — output that is one
// long useless block looks like exactly that.
//
// The document is the window and nothing else. Every line is text the model was
// actually sent, so a line's weight in the gutter belongs to that line, and the
// line numbers a frame points at mean what they say. Anything invented for
// readability — a timestamp, a size, a separator, a shell prompt — would be a
// line that is not in the context, sitting between lines that are, and would
// shift everything below it away from what the profile measured.
//
// The only concession is a blank line between blocks, which the API's own
// message boundaries amount to anyway.

// A tool_use block's input is JSON in the request. A Bash command is written as
// the command text alone rather than as its JSON, since that is the part that
// occupies the window and the part worth reading; other tools keep their JSON,
// where the field names carry the meaning.
function toolUseText(block) {
  const input = block.input || {};
  if (block.name === 'Bash' && typeof input.command === 'string') {
    return input.command;
  }
  return JSON.stringify(input, null, 2);
}

function toolResultText(block) {
  const content = block.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(part => part.text || '').join('');
  }
  return content == null ? '' : JSON.stringify(content);
}

// Renders the entries of one window in order, recording the line each block
// starts on. Keys match how the size attribution identifies a block:
// `${toolUseId}:output`, `${toolUseId}:call`, or a message uuid for text.
function renderTranscript(entries, toolUses, options = {}) {
  const lines = [];
  const lineFor = new Map();

  // 1-based, matching the source view's numbering.
  const nextLine = () => lines.length + 1;

  const record = (key, line) => {
    if (key && !lineFor.has(key)) {
      lineFor.set(key, line);
    }
  };

  // Appends a block's text and returns the line it starts on. Trailing blank
  // lines are dropped so the gap between blocks is exactly one line, whether or
  // not the content ended with a newline.
  const append = (text) => {
    const at = nextLine();
    const body = String(text).replace(/\r\n/g, '\n').split('\n');
    while (body.length > 1 && body[body.length - 1].trim() === '') {
      body.pop();
    }
    for (const line of body) {
      lines.push(line);
    }
    lines.push('');
    return at;
  };

  for (const entry of entries) {
    const content = entry.message?.content;

    if (typeof content === 'string') {
      if (content.trim().length === 0) continue;
      record(entry.uuid, append(content));
      continue;
    }

    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type === 'text') {
        if (!block.text || block.text.trim().length === 0) continue;
        record(entry.uuid, append(block.text));
        continue;
      }

      if (block.type === 'tool_use') {
        record(`${block.id}:call`, append(toolUseText(block)));
        continue;
      }

      if (block.type === 'tool_result') {
        const text = toolResultText(block);
        // An empty result still occupies a block in the request, and a frame
        // may point at it, so it gets a line rather than being skipped.
        record(`${block.tool_use_id}:output`, append(text));
        continue;
      }

      if (block.type === 'image') {
        record(entry.uuid, append(`[image: ${block.source?.media_type || 'unknown'}]`));
      }

      // A thinking block's text is not written to the log, only its signature,
      // so there is nothing of it to show.
    }
  }

  return { text: `${lines.join('\n')}\n`, lineFor, lineCount: lines.length };
}

module.exports = { renderTranscript, toolUseText, toolResultText };
