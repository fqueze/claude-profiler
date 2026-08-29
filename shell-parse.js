// Splitting a Bash tool call into the pieces that produced its output.
//
// A single Bash call often runs several commands in sequence, and the agent
// habitually puts an `echo "=== something ==="` between them so the output can
// be told apart. That echo is also the only marker that survives into the
// output, so it is what lets the bytes be attributed: everything printed
// between two echo markers came from the commands in between.
//
// Parsing is deliberately shallow — enough shell syntax to find command
// boundaries and pipeline stages without pretending to be a shell. It has to
// know about quotes and heredocs, because a `;` or an `echo` inside either is
// text rather than syntax.

// Commands that transform a pipeline's bytes rather than producing them. Worth
// their own frame: `... | head -30` is why the output is 30 lines long, and
// that is what a size profile is being read for.
const FILTERS = new Set([
  'grep', 'egrep', 'fgrep', 'rg', 'head', 'tail', 'sed', 'awk', 'cut', 'sort',
  'uniq', 'wc', 'tr', 'jq', 'xargs', 'tee', 'column', 'fold', 'nl', 'rev'
]);

// Wrappers that run another command; the interesting name is the inner one.
const PREFIXES = new Set([
  'time', 'env', 'nohup', 'command', 'sudo', 'nice', 'timeout', 'stdbuf', 'xargs'
]);

// Shell builtins and assignments that set things up without producing output.
const SETUP = new Set(['cd', 'export', 'set', 'unset', 'source', '.', 'eval', 'ulimit', 'umask']);

// Shell keywords that frame a compound command rather than naming a program.
// `do`/`done`/`then`/`fi` end up as their own segments because the `;` before
// them is a real separator; they produce nothing and are dropped.
// A loop names a variable rather than a subcommand, so `for t in …` and
// `for i in …` must not become two different frames.
const LOOP_KEYWORDS = new Set(['for', 'while', 'until', 'if', 'case', 'select']);

const KEYWORDS = new Set(['do', 'done', 'then', 'fi', 'else', 'elif', 'esac', 'in', '{', '}']);

// Constructs that test or annotate rather than produce output.
const NON_PRODUCERS = new Set(['[', '[[', 'test', 'true', 'false', ':', 'break', 'continue', 'return', 'exit']);

const OPERATORS = [';;', '&&', '||', '|&', ';', '|', '&', '\n'];

// Walks the command string once, emitting operators and words while skipping
// over anything quoted. Heredoc bodies are consumed whole, so their contents
// never look like syntax.
function tokenize(command) {
  const tokens = [];
  let word = '';
  let i = 0;
  const pendingHeredocs = [];

  function flushWord() {
    if (word.length > 0) {
      tokens.push({ type: 'word', value: word });
      word = '';
    }
  }

  while (i < command.length) {
    const ch = command[i];

    // A newline both ends a command and is where any pending heredoc body
    // starts. Consume the body up to its terminator before carrying on.
    if (ch === '\n' && pendingHeredocs.length > 0) {
      flushWord();
      tokens.push({ type: 'op', value: '\n' });
      i++;
      while (pendingHeredocs.length > 0) {
        const { tag, stripTabs } = pendingHeredocs.shift();
        while (i < command.length) {
          const lineEnd = command.indexOf('\n', i);
          const line = command.slice(i, lineEnd === -1 ? command.length : lineEnd);
          i = lineEnd === -1 ? command.length : lineEnd + 1;
          if ((stripTabs ? line.replace(/^\t+/, '') : line).trim() === tag) {
            break;
          }
        }
      }
      continue;
    }

    if (ch === '\\' && i + 1 < command.length) {
      // A backslash-newline is a line continuation, not a command boundary.
      if (command[i + 1] === '\n') {
        i += 2;
        continue;
      }
      word += command.slice(i, i + 2);
      i += 2;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const end = findClosingQuote(command, i);
      word += command.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    // $( ) and ` ` run a nested command. Kept as part of the word: the bytes
    // are attributed to the command that used the substitution.
    if (ch === '$' && command[i + 1] === '(') {
      const end = findClosingParen(command, i + 1);
      word += command.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    if (ch === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      const heredoc = readHeredocTag(command, i);
      if (heredoc) {
        flushWord();
        pendingHeredocs.push(heredoc);
        tokens.push({ type: 'heredoc', value: heredoc.tag });
        i = heredoc.end;
        continue;
      }
    }

    if (ch === ' ' || ch === '\t') {
      flushWord();
      i++;
      continue;
    }

    // A redirection is one token, so that the `&` of `2>&1` is not mistaken for
    // a backgrounding operator and its `1` for an argument.
    const redirection = /^(\d*)(>>|>&|>|<)(&\d+-?|&)?/.exec(command.slice(i));
    if (redirection && (ch === '>' || ch === '<' || /^\d+[<>]/.test(command.slice(i)))) {
      flushWord();
      tokens.push({ type: 'redirect', value: redirection[0] });
      i += redirection[0].length;
      continue;
    }

    const op = OPERATORS.find(candidate => command.startsWith(candidate, i));
    if (op) {
      flushWord();
      tokens.push({ type: 'op', value: op === '\n' ? '\n' : op });
      i += op.length;
      continue;
    }

    word += ch;
    i++;
  }

  flushWord();
  return tokens;
}

function findClosingQuote(command, start) {
  const quote = command[start];
  for (let i = start + 1; i < command.length; i++) {
    if (command[i] === '\\' && quote === '"') {
      i++;
      continue;
    }
    if (command[i] === quote) {
      return i;
    }
  }
  return command.length - 1;
}

function findClosingParen(command, start) {
  let depth = 0;
  for (let i = start; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'" || ch === '"') {
      i = findClosingQuote(command, i);
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return command.length - 1;
}

// `<<EOF`, `<<-EOF`, `<<'EOF'` and `<<"EOF"` all introduce a heredoc.
function readHeredocTag(command, start) {
  let i = start + 2;
  const stripTabs = command[i] === '-';
  if (stripTabs) i++;
  while (command[i] === ' ' || command[i] === '\t') i++;

  let tag = '';
  if (command[i] === "'" || command[i] === '"') {
    const end = findClosingQuote(command, i);
    tag = command.slice(i + 1, end);
    i = end + 1;
  } else {
    while (i < command.length && /[A-Za-z0-9_]/.test(command[i])) {
      tag += command[i];
      i++;
    }
  }

  return tag ? { tag, stripTabs, end: i } : null;
}

// What an `echo` actually prints: its arguments, unquoted and space-joined.
// This is matched against the output to locate the boundary it marks.
function echoText(words) {
  if (!words) return null;
  const bare = words.map(unquote);
  const at = bare.findIndex(word => word.split('/').pop() === 'echo');
  const args = (at === -1 ? bare : bare.slice(at + 1))
    .filter(word => !/^-[neE]+$/.test(word));
  return args.join(' ');
}

function unquote(word) {
  let out = '';
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    if (ch === "'" || ch === '"') {
      const end = findClosingQuote(word, i);
      out += word.slice(i + 1, end);
      i = end;
      continue;
    }
    if (ch === '\\' && i + 1 < word.length) {
      out += word[i + 1];
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

// Drops `2>&1`, `>file`, `>>file`, `<file` and the filename that follows a bare
// redirection operator. Without this, the `1` of `2>&1` looks like an argument
// and a `> out.txt` makes `out.txt` look like the command.
function stripRedirections(words) {
  const kept = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (/^\d*(>>?|<)&?\d*-?$/.test(word)) {
      // A bare operator takes the next word as its target.
      if (!/&\d*-?$/.test(word)) i++;
      continue;
    }
    // Attached forms: `>file`, `2>file`, `>>file`.
    if (/^\d*(>>?|<)/.test(word)) continue;
    kept.push(word);
  }
  return kept;
}

// The name to show for a command: the binary, without its path, skipping over
// wrappers and variable assignments. `for`/`while`/`if` are reported as such,
// since the loop is what generated the bytes.
function commandName(words) {
  for (const word of words) {
    const bare = unquote(word);
    // A comment runs to end of line; nothing after it is a command.
    if (bare.startsWith('#')) return null;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(bare)) continue;
    if (bare.startsWith('-')) continue;
    // A bare number is a leftover of a multi-line -c argument, not a command.
    if (/^\d+$/.test(bare)) continue;
    const name = bare.split('/').pop();
    if (PREFIXES.has(name)) continue;
    return name;
  }
  return null;
}

// One stage of a pipeline: the command and the arguments worth showing next to
// it, so `head -30` and `sed -n '20430,20500p'` stay distinguishable.
function describeStage(words) {
  // `do`/`then` introduce the command that follows them on the same segment.
  while (words.length > 0 && KEYWORDS.has(unquote(words[0]))) {
    words = words.slice(1);
  }
  const name = commandName(words);
  if (!name) return null;

  const bare = words.map(unquote);

  // Everything after the command name, in order, so a subcommand keeps its
  // position: `profiler-cli marker info` is one tool with two subcommand words.
  const nameAt = bare.findIndex(word => word.split('/').pop() === name);
  const rest = nameAt === -1 ? [] : bare.slice(nameAt + 1);

  // Leading bare words are subcommands; they identify what the tool did and are
  // worth keeping in the frame name.
  const subcommands = [];
  if (!LOOP_KEYWORDS.has(name)) {
    for (const word of rest) {
      if (word.startsWith('-') || word.startsWith('<<')) break;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) break;
      if (!/^[a-z][a-z0-9-]*$/.test(word)) break;
      // A commit hash or an id is an operand, not a subcommand: it is different
      // at every call site and would make one frame per invocation. Real
      // subcommands are words, so anything long with digits in it is rejected.
      if (word.length >= 7 && /\d/.test(word)) break;
      subcommands.push(word);
      if (subcommands.length === 2) break;
    }
  }

  const flags = rest
    .filter(word => word.startsWith('-') && word !== '-' && word.length <= 12)
    .slice(0, 2);

  // The first argument that is not a flag or a subcommand, shortened.
  const args = rest.filter(word =>
    !word.startsWith('-') &&
    !word.startsWith('<<') &&
    !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) &&
    !subcommands.includes(word)
  );
  let detail = args[0] || '';
  if (detail.length > 40) detail = `${detail.slice(0, 40)}…`;

  return {
    name,
    subcommands,
    flags,
    detail,
    isFilter: FILTERS.has(name),
    isSetup: SETUP.has(name) || NON_PRODUCERS.has(name)
  };
}

// Splits a command string into sequential segments (things run one after
// another), each with its pipeline stages. `echo` segments are flagged, since
// their text is the anchor used to split the output.
function parseCommand(command) {
  const tokens = tokenize(command);
  const segments = [];
  let stages = [[]];

  function endSegment(separator) {
    const stagesWords = stages;
    const pipeline = stages
      .map(describeStage)
      .filter(Boolean);
    stages = [[]];
    if (pipeline.length === 0) return;

    const producer = pipeline.find(stage => !stage.isFilter && !stage.isSetup) ||
      pipeline.find(stage => !stage.isSetup) ||
      pipeline[0];

    segments.push({
      pipeline,
      producer,
      filters: pipeline.filter(stage => stage.isFilter && stage !== producer),
      isEcho: pipeline.length === 1 && pipeline[0].name === 'echo',
      echoText: pipeline[0].name === 'echo' ? echoText(stagesWords[0]) : null,
      inLoop: loopDepth > 0,
      separator
    });
  }

  let skipNextWord = false;
  // `do` opens a loop body and `done` closes it, so segments in between are
  // repeated; an echo among them prints once per iteration.
  let loopDepth = 0;
  for (const token of tokens) {
    if (token.type === 'word') {
      const bare = unquote(token.value);
      if (bare === 'do') loopDepth++;
      else if (bare === 'done') loopDepth = Math.max(0, loopDepth - 1);
    }
    if (token.type === 'redirect') {
      // `>file` takes the following word as its target; `>&1` has it built in.
      skipNextWord = !/&/.test(token.value);
      continue;
    }
    if (token.type === 'word') {
      if (skipNextWord) {
        skipNextWord = false;
        continue;
      }
      stages[stages.length - 1].push(token.value);
    } else if (token.type === 'heredoc') {
      stages[stages.length - 1].push(`<<${token.value}`);
    } else if (token.value === '|' || token.value === '|&') {
      stages.push([]);
    } else {
      endSegment(token.value);
    }
  }
  endSegment(null);

  return segments;
}

// The echo text as it appears in the output. Only the literal part is usable as
// an anchor, so a `$var` in the middle cuts the anchor short.
function echoAnchor(words) {
  return words;
}

module.exports = { parseCommand, tokenize, commandName, describeStage, unquote, FILTERS };
