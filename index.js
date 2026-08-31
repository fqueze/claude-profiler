#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
// Attribution of a message's bytes, shared with the size profile so both tools
// build the same stacks.
const { attributeEntry } = require('./context-size.js');
const { renderTranscript } = require('./transcript.js');

// Prices per million tokens, from
// https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-08-09).
// Matched in order, so the models that don't follow their family's price come
// first. Cache prices are derived from the input price rather than listed
// separately: a 5 minute cache write costs 1.25x, a 1 hour write 2x, and a read
// 0.1x.
const PRICING = [
  // Claude Fable 5 and Claude Mythos 5
  { match: /fable|mythos/, input: 10.00, output: 50.00 },
  // Claude Opus 4.1 and older, before the Opus price cut
  { match: /opus-4-[01]|opus-4-2025|3-opus/, input: 15.00, output: 75.00 },
  // Claude Opus 5, 4.8, 4.7, 4.6 and 4.5
  { match: /opus/, input: 5.00, output: 25.00 },
  // Every Sonnet. Claude Sonnet 5 is $2/$10 until 2026-08-31 under introductory
  // pricing, which is not applied here.
  { match: /sonnet/, input: 3.00, output: 15.00 },
  { match: /haiku-4-5|haiku-4\.5/, input: 1.00, output: 5.00 },
  { match: /3-5-haiku|haiku.*3\.5/, input: 0.80, output: 4.00 },
  { match: /3-haiku|haiku/, input: 0.25, output: 1.25 }
];

// Sonnet, as the middle of the range, when the model is unknown.
const DEFAULT_PRICING = { input: 3.00, output: 15.00 };

const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;
const CACHE_READ_MULTIPLIER = 0.1;

function getPricingForModel(modelId) {
  if (!modelId) {
    return DEFAULT_PRICING;
  }

  const model = modelId.toLowerCase();
  return PRICING.find(pricing => pricing.match.test(model)) || DEFAULT_PRICING;
}

function calculateCost(usage, pricing) {
  // The two cache lifetimes are billed differently. Logs that predate the
  // split only have the total, which was a 5 minute write.
  const creation = usage.cache_creation;
  const cacheWrite1h = creation?.ephemeral_1h_input_tokens || 0;
  const cacheWrite5m = creation
    ? creation.ephemeral_5m_input_tokens || 0
    : usage.cache_creation_input_tokens || 0;

  const inputCost = (usage.input_tokens || 0) * pricing.input / 1000000;
  const outputCost = (usage.output_tokens || 0) * pricing.output / 1000000;
  const cacheWriteCost =
    (cacheWrite5m * CACHE_WRITE_5M_MULTIPLIER + cacheWrite1h * CACHE_WRITE_1H_MULTIPLIER) *
    pricing.input / 1000000;
  const cacheReadCost =
    (usage.cache_read_input_tokens || 0) * CACHE_READ_MULTIPLIER * pricing.input / 1000000;

  return {
    input: inputCost,
    output: outputCost,
    cacheWrite: cacheWriteCost,
    cacheRead: cacheReadCost,
    total: inputCost + outputCost + cacheWriteCost + cacheReadCost
  };
}

// One line of a cost breakdown: what that part of a call cost and how many
// tokens bought it. A string rather than two fields, so the tooltip reads as
// four lines instead of eight, and empty when nothing was billed — a call with
// no cache write should not claim a $0 one.
function costWithTokens(cost, tokens) {
  if (!cost && !tokens) {
    return undefined;
  }
  const amount = cost.toLocaleString(undefined, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4
  });
  return `${amount}$ (${(tokens || 0).toLocaleString()} tokens)`;
}

function readJsonlFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  return lines.filter(line => line.length > 0).map(line => JSON.parse(line));
}

// Sub-agent transcripts live next to the main session file, in
// <session-id>/subagents/agent-<id>.jsonl, each with an agent-<id>.meta.json
// describing the agent type, the task description and the spawn depth.
function readSubagents(sessionFilePath) {
  return readSubagentsDir(path.join(
    path.dirname(sessionFilePath),
    path.basename(sessionFilePath, '.jsonl'),
    'subagents'
  ));
}

// Same, for callers that only have the session id: sessions of every project
// live side by side under ~/.claude/projects/<project>/.
function readSubagentsForSession(sessionId) {
  const projects = path.join(
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    'projects'
  );

  if (!sessionId || !fs.existsSync(projects)) {
    return [];
  }

  for (const project of fs.readdirSync(projects)) {
    const dir = path.join(projects, project, sessionId, 'subagents');
    if (fs.existsSync(dir)) {
      return readSubagentsDir(dir);
    }
  }

  return [];
}

function readSubagentsDir(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const agents = [];
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.startsWith('agent-') || !file.endsWith('.jsonl')) {
      continue;
    }

    const id = file.slice('agent-'.length, -'.jsonl'.length);
    const metaPath = path.join(dir, `agent-${id}.meta.json`);
    const meta = fs.existsSync(metaPath)
      ? JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
      : {};

    agents.push({ id, meta, entries: readJsonlFile(path.join(dir, file)) });
  }

  return agents;
}

function conversationEntries(jsonlData) {
  return jsonlData.filter(entry =>
    entry.type === 'user' || entry.type === 'assistant'
  );
}

function entryText(entry) {
  const content = entry.message?.content || '';
  return typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(c => c.text || '').join(' ').trim()
      : '';
}

// Claude Code names the session itself, in an `ai-title` entry rewritten as the
// conversation goes on (older sessions have a `summary` entry instead). That
// title is what the session is called in the UI, so it makes a better track
// name than anything we could come up with; fall back to the opening prompt.
function sessionTitle(jsonlData) {
  for (let i = jsonlData.length - 1; i >= 0; i--) {
    const entry = jsonlData[i];
    if (entry.type === 'ai-title' && entry.aiTitle) {
      return entry.aiTitle;
    }
    if (entry.type === 'summary' && entry.summary) {
      return entry.summary;
    }
  }

  const firstPrompt = jsonlData.find(entry =>
    entry.type === 'user' && entry.message?.role === 'user' && entryText(entry)
  );

  if (firstPrompt) {
    const text = entryText(firstPrompt).replace(/\s+/g, ' ');
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  }

  return 'Main conversation';
}

// One requestId = one API call, but several entries can share it.
function uniqueApiCalls(messages) {
  const seenRequestIds = new Set();
  return messages.filter(msg => {
    if (!msg.message?.usage || !msg.requestId || seenRequestIds.has(msg.requestId)) {
      return false;
    }
    seenRequestIds.add(msg.requestId);
    return true;
  });
}

function totalCost(messages) {
  return uniqueApiCalls(messages).reduce((sum, msg) => {
    const pricing = getPricingForModel(msg.message.model);
    return sum + calculateCost(msg.message.usage, pricing).total;
  }, 0);
}

// Groups the assistant entries of one API response together. The response runs
// from the last thing the model was handed to the last chunk it produced, which
// covers queueing, inference and streaming — the time nothing else explains.
function findModelResponses(messages) {
  const responses = [];

  messages.forEach((msg, index) => {
    if (msg.type !== 'assistant' || !msg.requestId) {
      return;
    }

    const time = new Date(msg.timestamp).getTime();
    const current = responses[responses.length - 1];

    if (current && current.requestId === msg.requestId) {
      current.end = time;
    } else {
      const previous = messages[index - 1];
      responses.push({
        requestId: msg.requestId,
        start: previous ? new Date(previous.timestamp).getTime() : time,
        end: time,
        message: msg.message,
        effort: msg.effort
      });
    }

    if (msg.message?.stop_reason) {
      responses[responses.length - 1].stopReason = msg.message.stop_reason;
    }
  });

  return responses;
}

// Pairs every tool_use block with the tool_result that answers it, giving the
// duration of the call. A call still running when the log ends stays unpaired.
function findToolCalls(messages) {
  const pending = new Map();
  const calls = [];

  messages.forEach((msg) => {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;

    const time = new Date(msg.timestamp).getTime();
    content.forEach((block) => {
      if (block.type === 'tool_use') {
        const call = {
          name: block.name,
          input: block.input,
          start: time,
          end: null
        };
        pending.set(block.id, call);
        calls.push(call);
      } else if (block.type === 'tool_result') {
        const call = pending.get(block.tool_use_id);
        if (call) {
          pending.delete(block.tool_use_id);
          call.end = time;
          call.isError = block.is_error === true;
          call.result = msg.toolUseResult;
        }
      }
    });
  });

  return calls;
}

// The part of a tool call worth reading at a glance: what it ran, or on what.
function toolCallDetail(name, input) {
  if (!input) {
    return '';
  }

  switch (name) {
    case 'Bash':
      return input.command;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return input.file_path;
    case 'Grep':
    case 'Glob':
      return [input.pattern, input.path].filter(Boolean).join(' in ');
    case 'WebFetch':
      return input.url;
    case 'WebSearch':
      return input.query;
    case 'Skill':
      return input.skill;
    case 'Task':
    case 'Agent':
      return input.description;
    default:
      return input.description || JSON.stringify(input);
  }
}

// How much the call sent back, which is what it cost the context.
function toolResultSize(result) {
  if (typeof result === 'string') {
    return result.length;
  }

  if (!result || typeof result !== 'object') {
    return 0;
  }

  if (typeof result.stdout === 'string' || typeof result.stderr === 'string') {
    return (result.stdout || '').length + (result.stderr || '').length;
  }

  if (typeof result.content === 'string') {
    return result.content.length;
  }

  if (typeof result.file?.content === 'string') {
    return result.file.content.length;
  }

  return JSON.stringify(result).length;
}

// Ids of the Task/Agent tool calls made from a set of entries. A sub-agent's
// meta.json points back at one of these, which is how nested agents can be
// attributed to the agent that spawned them rather than to the main session.
function findAgentToolUses(messages) {
  const toolUses = new Set();
  messages.forEach(msg => {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;
    content.forEach(block => {
      if (block.type === 'tool_use' && (block.name === 'Task' || block.name === 'Agent')) {
        toolUses.add(block.id);
      }
    });
  });
  return toolUses;
}

// The tables a v64 profile shares across every thread, plus the sources table
// each track's transcript is embedded in.
function createTimelineShared() {
  const shared = {
    strings: [],
    stringMap: new Map(),
    funcIndexes: new Map(),
    frameIndexes: new Map(),
    stackIndexes: new Map(),
    stackTable: { frame: [], prefix: [], length: 0 },
    frameTable: {
      address: [], inlineDepth: [], category: [], subcategory: [], func: [],
      nativeSymbol: [], innerWindowID: [], originalLocation: [], line: [],
      column: [], length: 0
    },
    funcTable: {
      name: [], isJS: [], relevantForJS: [], resource: [], source: [],
      lineNumber: [], columnNumber: [], originalLocation: [], length: 0
    },
    resourceTable: { lib: [], name: [], host: [], type: [], length: 0 },
    sources: { length: 0, id: [], filename: [], startLine: [], startColumn: [], sourceMapURL: [], content: [] },
    resourceBySource: new Map()
  };

  shared.intern = (text) => {
    if (!shared.stringMap.has(text)) {
      shared.stringMap.set(text, shared.strings.length);
      shared.strings.push(text);
    }
    return shared.stringMap.get(text);
  };

  // A source file whose text travels inside the profile, so the source view
  // needs nothing from the network and a saved profile stays readable.
  shared.registerSource = (fileName, content, resourceName) => {
    const index = shared.sources.length;
    shared.sources.id.push(null);
    shared.sources.filename.push(shared.intern(fileName));
    shared.sources.startLine.push(1);
    shared.sources.startColumn.push(1);
    shared.sources.sourceMapURL.push(null);
    shared.sources.content.push(content);
    shared.sources.length++;

    shared.resourceBySource.set(index, shared.resourceTable.length);
    shared.resourceTable.lib.push(null);
    shared.resourceTable.name.push(shared.intern(resourceName || fileName));
    shared.resourceTable.host.push(null);
    // ResourceType.Url: the "file" is a document, not a library.
    shared.resourceTable.type.push(5);
    shared.resourceTable.length++;

    return index;
  };

  shared.resourceForSource = (sourceIndex) =>
    shared.resourceBySource.has(sourceIndex)
      ? shared.resourceBySource.get(sourceIndex)
      : -1;

  return shared;
}

// The shared half of a v64 profile, once every track has interned into it.
function buildTimelineShared(shared) {
  return {
    stringArray: shared.strings,
    stackTable: {
      length: shared.stackTable.length,
      prefix: shared.stackTable.prefix,
      frame: shared.stackTable.frame
    },
    frameTable: {
      length: shared.frameTable.length,
      address: shared.frameTable.address,
      inlineDepth: shared.frameTable.inlineDepth,
      category: shared.frameTable.category,
      subcategory: shared.frameTable.subcategory,
      func: shared.frameTable.func,
      nativeSymbol: shared.frameTable.nativeSymbol,
      innerWindowID: shared.frameTable.innerWindowID,
      originalLocation: shared.frameTable.originalLocation,
      line: shared.frameTable.line,
      column: shared.frameTable.column
    },
    funcTable: {
      length: shared.funcTable.length,
      name: shared.funcTable.name,
      isJS: shared.funcTable.isJS,
      relevantForJS: shared.funcTable.relevantForJS,
      resource: shared.funcTable.resource,
      source: shared.funcTable.source,
      lineNumber: shared.funcTable.lineNumber,
      columnNumber: shared.funcTable.columnNumber,
      originalLocation: shared.funcTable.originalLocation
    },
    resourceTable: {
      length: shared.resourceTable.length,
      lib: shared.resourceTable.lib,
      name: shared.resourceTable.name,
      host: shared.resourceTable.host,
      type: shared.resourceTable.type
    },
    nativeSymbols: { length: 0, address: [], functionSize: [], libIndex: [], name: [] },
    sources: shared.sources,
    sourceLocationTable: { source: [], line: [], column: [], length: 0 }
  };
}

// A filename for a track's transcript, shown in the source view's header.
function sourceSlug(label) {
  const cleaned = String(label || 'session')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return (cleaned || 'session').slice(0, 60);
}

// Index into the timeline profile's category list below. Drawn as nothing, so an
// idle stretch reads as empty rather than as another kind of work.
const IDLE_CATEGORY = 6;

// The size profile has its own category list; the timeline profile's is about
// what happened rather than where bytes came from, so they are mapped over.
function sizeCategoryToTimeline(category) {
  const { CATEGORY } = require('./size-profile.js');
  switch (category) {
    case CATEGORY['Tool output']: return 3;      // Tools
    case CATEGORY['Tool call']: return 3;        // Tools
    case CATEGORY['Assistant text']: return 5;   // Model
    case CATEGORY['User text']: return 1;        // Messages
    case CATEGORY['Injected context']: return 1; // Messages
    default: return 0;                           // Other
  }
}

function buildThread({
  entries,
  messages,
  apiCalls,
  totalCostPoints,
  startTime,
  threadName,
  processName,
  pid,
  tid,
  spans,
  registerTime,
  unregisterTime,
  shared,
  transcript,
  sourceFile
}) {
  // The string, stack, frame and func tables are shared across every thread
  // from format v60 on, so this thread interns into the profile's set.
  const strings = shared.strings;
  const stringTable = shared.stringMap;

  function addString(str) {
    if (!stringTable.has(str)) {
      stringTable.set(str, strings.length);
      strings.push(str);
    }
    return stringTable.get(str);
  }

  // This track's transcript, embedded so the source view can show it without
  // fetching anything. Registered before any func is created, since a func
  // records which source it belongs to.
  const sourceIndex = shared.registerSource(sourceFile, transcript.text, processName);

  const markers = {
    data: [],
    name: [],
    startTime: [],
    endTime: [],
    phase: [],
    category: [],
    length: 0
  };

  function addMarker(nameIdx, start, end, phase, category, data) {
    markers.name.push(nameIdx);
    markers.startTime.push(start);
    markers.endTime.push(end);
    markers.phase.push(phase);
    markers.category.push(category);
    markers.data.push(data);
    markers.length++;
  }

  // Process messages and extract text content
  const messagesWithText = [];

  messages.forEach((msg) => {
    const contentText = entryText(msg);

    // Only include messages with actual text content
    if (contentText.length > 0) {
      messagesWithText.push({
        ...msg,
        role: msg.message?.role || msg.type,
        contentText
      });
    }
  });

  messagesWithText.forEach((msg) => {
    const relativeTime = new Date(msg.timestamp).getTime() - startTime;
    addMarker(addString(msg.role), relativeTime, relativeTime, 0, 0, {
      type: 'Text',
      text: msg.contentText
    });
  });

  // What the model itself was doing, as opposed to the tools it called. The
  // reasoning behind it is not recoverable: thinking blocks keep their
  // signature but the text is not written to the log.
  findModelResponses(messages).forEach((response) => {
    const usage = response.message?.usage || {};
    addMarker(
      addString(response.message?.model || 'model'),
      response.start - startTime,
      response.end - startTime,
      1,
      5,
      {
        type: 'ModelResponse',
        model: response.message?.model || 'unknown',
        effort: response.effort,
        speed: usage.speed,
        stopReason: response.stopReason,
        outputTokens: usage.output_tokens || 0,
        iterations: Array.isArray(usage.iterations) ? usage.iterations.length : 1
      }
    );
  });

  // Claude Code measures each turn itself and logs the result; no need to infer
  // it. Sub-agent transcripts have no such entries.
  const turnNameIdx = addString('Turn');
  entries.forEach((entry) => {
    if (entry.subtype !== 'turn_duration' || !entry.durationMs) return;

    const end = new Date(entry.timestamp).getTime() - startTime;
    addMarker(turnNameIdx, end - entry.durationMs, end, 1, 1, {
      type: 'Turn',
      messages: entry.messageCount || 0,
      backgroundAgents: entry.pendingBackgroundAgentCount || 0
    });
  });

  // Points where the user stepped in: a denied tool call, or feedback attached
  // to a tool result.
  const interventionNameIdx = addString('User intervention');
  entries.forEach((entry) => {
    if (!entry.toolDenialKind && !entry.userFeedback) return;

    const relativeTime = new Date(entry.timestamp).getTime() - startTime;
    addMarker(interventionNameIdx, relativeTime, relativeTime, 0, 4, {
      type: 'Intervention',
      kind: entry.toolDenialKind || 'feedback',
      text: entryText(entry).slice(0, 500)
    });
  });

  // Tool calls, as intervals running from the request to the result. Each is
  // named after the tool, so the marker chart gets one row per tool.
  const MAX_DETAIL = 200;
  findToolCalls(messages).forEach((call) => {
    const detail = toolCallDetail(call.name, call.input) || '';
    const interrupted = call.result?.interrupted === true;

    addMarker(
      addString(call.name),
      call.start - startTime,
      // A call with no result was still running when the log ended.
      (call.end === null ? unregisterTime + startTime : call.end) - startTime,
      1,
      call.isError || interrupted ? 4 : 3,
      {
        type: 'ToolCall',
        name: call.name,
        detail: detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL)}…` : detail,
        outputBytes: toolResultSize(call.result),
        status: call.end === null ? 'running at end of log'
          : interrupted ? 'interrupted'
          : call.isError ? 'error'
          : 'ok'
      }
    );
  });

  // Sub-agents spawned from this thread, as interval markers covering the
  // lifetime of the sub-agent's own track.
  const subagentNameIdx = addString('Subagent');
  spans.forEach((span) => {
    addMarker(subagentNameIdx, span.start - startTime, span.end - startTime, 1, 2, {
      type: 'Subagent',
      description: span.description,
      agentType: span.agentType,
      agentId: span.agentId,
      cost: span.cost
    });
  });

  // One cost marker per API call. The token counts ride along in the same
  // marker: a chart each for output, input, cache reads and cache writes cost
  // four rows of vertical space to say what four lines of one tooltip say, and
  // the cost bars are where one looks for an expensive call anyway.
  const costNameIdx = addString('Cost ($)');
  const agentCostNameIdx = addString('Agent Cost ($)');
  const contextSizeNameIdx = addString('Context Size');

  apiCalls.forEach(({ msg, costs, agentCost }) => {
    const usage = msg.message.usage;
    const relativeTime = new Date(msg.timestamp).getTime() - startTime;

    // Everything the model was sent is the context at that point, whether it
    // came from the cache or not. It grows as the agent works and drops back
    // when the conversation is compacted.
    addMarker(contextSizeNameIdx, relativeTime, relativeTime, 0, 1, {
      type: 'ContextSize',
      tokens: (usage.input_tokens || 0) +
        (usage.cache_read_input_tokens || 0) +
        (usage.cache_creation_input_tokens || 0)
    });

    if (costs.total > 0) {
      addMarker(costNameIdx, relativeTime, relativeTime, 0, 1, {
        type: 'Cost',
        cost: costs.total,
        output: costWithTokens(costs.output, usage.output_tokens),
        input: costWithTokens(costs.input, usage.input_tokens),
        cacheRead: costWithTokens(costs.cacheRead, usage.cache_read_input_tokens),
        cacheWrite: costWithTokens(costs.cacheWrite, usage.cache_creation_input_tokens)
      });
    }

    // Running total of what this agent has spent so far.
    addMarker(agentCostNameIdx, relativeTime, relativeTime, 0, 1, {
      type: 'AgentCost',
      total: agentCost
    });
  });

  // The session-wide total only goes on the parent track, but it is sampled at
  // every API call of every agent, so the line is complete rather than a
  // staircase between the parent's own calls.
  if (totalCostPoints) {
    const totalCostNameIdx = addString('Total Cost ($)');
    totalCostPoints.forEach(({ time, total }) => {
      const relativeTime = time - startTime;
      addMarker(totalCostNameIdx, relativeTime, relativeTime, 0, 1, {
        type: 'TotalCost',
        total
      });
    });
  }

  // Samples carry what each message added to the context window, so the call
  // tree and the flame graph read like an allocation profile: the stack is what
  // produced the bytes and the weight is how many. Without this the panels are
  // empty, since a conversation has no call stacks of its own.
  const { stackTable, frameTable, funcTable } = shared;

  const funcIndexes = shared.funcIndexes;
  // The line is part of a func's identity, not of its name: two calls can be
  // spelled the same and sit at different places in the transcript, and sharing
  // a func would make both scroll to whichever is heavier.
  function addFunc(name, line) {
    const key = `${name}\u0000${sourceIndex}\u0000${line === undefined ? 'x' : line}`;
    if (!funcIndexes.has(key)) {
      funcIndexes.set(key, funcTable.length);
      funcTable.name.push(addString(name));
      funcTable.isJS.push(false);
      funcTable.relevantForJS.push(false);
      funcTable.resource.push(shared.resourceForSource(sourceIndex));
      funcTable.source.push(sourceIndex);
      funcTable.lineNumber.push(null);
      funcTable.columnNumber.push(null);
      funcTable.originalLocation.push(null);
      funcTable.length++;
    }
    return funcIndexes.get(key);
  }

  const frameIndexes = shared.frameIndexes;
  function addFrame(name, category, line) {
    const key = `${name}\u0000${category}\u0000${sourceIndex}\u0000${line === undefined ? 'x' : line}`;
    if (!frameIndexes.has(key)) {
      frameIndexes.set(key, frameTable.length);
      frameTable.address.push(-1);
      frameTable.inlineDepth.push(0);
      frameTable.category.push(category);
      frameTable.subcategory.push(0);
      frameTable.func.push(addFunc(name, line));
      frameTable.nativeSymbol.push(null);
      frameTable.innerWindowID.push(null);
      frameTable.originalLocation.push(null);
      // Where this frame's content sits in the transcript, so double-clicking it
      // scrolls the source view there.
      frameTable.line.push(line === undefined ? null : line);
      frameTable.column.push(null);
      frameTable.length++;
    }
    return frameIndexes.get(key);
  }

  const stackIndexes = shared.stackIndexes;
  // A call node merges every frame sharing a func, and the source view scrolls
  // to the heaviest line within a node, so a name occurring in many places would
  // scroll somewhere unrelated to the box that was clicked. The location gets a
  // leaf frame of its own below the frames that aggregate by name: parents stay
  // merged, the leaf scrolls exactly.
  function addStack(frames, category, line, leafLabel) {
    const path = line === undefined ? frames : [...frames, leafLabel || `line ${line}`];

    let prefix = null;
    path.forEach((name, index) => {
      const isLeaf = index === path.length - 1;
      const frameIndex = addFrame(name, category, isLeaf ? line : undefined);
      const key = `${frameIndex}\u0000${prefix === null ? 'r' : prefix}`;
      if (!stackIndexes.has(key)) {
        stackIndexes.set(key, stackTable.length);
        stackTable.frame.push(frameIndex);
        stackTable.prefix.push(prefix);
        stackTable.length++;
      }
      prefix = stackIndexes.get(key);
    });
    return prefix;
  }


  const sampleStacks = [];
  const sampleTimes = [];
  const sampleWeights = [];

  const toolUses = new Map();
  messages.forEach((msg) => {
    const content = msg.message?.content;
    if (Array.isArray(content)) {
      content.forEach((block) => {
        if (block.type === 'tool_use') toolUses.set(block.id, block);
      });
    }
  });

  messages.forEach((msg) => {
    const relativeTime = new Date(msg.timestamp).getTime() - startTime;
    attributeEntry(msg, toolUses, (frames, category, bytes, line, leafLabel) => {
      if (bytes <= 0) return;
      const stackIndex = addStack(frames, sizeCategoryToTimeline(category), line, leafLabel);
      if (stackIndex === null) return;
      sampleStacks.push(stackIndex);
      sampleTimes.push(relativeTime);
      sampleWeights.push(bytes);
    }, transcript.lineFor);
  });

  // Bytes only land on the moments something was logged, and the graph gives
  // each sample the span between its neighbours, so a session that spent hours
  // waiting for its user drew as busy throughout: the last sample before a gap
  // was stretched across all of it.
  //
  // Filling the gaps with samples in a category whose colour is `transparent`
  // is what the front end draws as nothing — the same way a profile without CPU
  // measurements shows idle time. The alternative, a threadCPUDelta per sample,
  // would also work but puts a CPU percentage in every tooltip along the
  // timeline, and there is no CPU figure here that would mean anything.
  const busy = [
    ...findModelResponses(messages).map(response => ({
      start: response.start - startTime,
      end: response.end - startTime
    })),
    ...findToolCalls(messages).map(call => ({
      start: call.start - startTime,
      // A call with no result was still running when the log ended.
      end: (call.end === null ? unregisterTime + startTime : call.end) - startTime
    }))
  ].filter(span => span.end >= span.start).sort((a, b) => a.start - b.start);

  // Merged, since the model and its tools overlap and a gap only counts when
  // nothing at all was running.
  const busySpans = [];
  for (const span of busy) {
    const last = busySpans[busySpans.length - 1];
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      busySpans.push({ ...span });
    }
  }

  // Two samples per gap are enough. The graph gives a sample the span from
  // halfway back to the previous sample to halfway on to the next, and fills it
  // with that sample's own category — so one at each end of a gap covers all of
  // it but the quarters nearest the work on either side, which belong to the
  // work. A sample per second would change nothing about how it looks.
  const idleStack = addStack(['Waiting'], IDLE_CATEGORY);

  function markIdle(from, to) {
    if (idleStack === null) return;
    // The closing sample sits just short of where the work resumes: at the same
    // timestamp it would tie with the work's own sample, and the second half of
    // the gap would be filled as work.
    const close = Math.max(from, to - 1);
    for (const time of close === from ? [from] : [from, close]) {
      sampleStacks.push(idleStack);
      sampleTimes.push(time);
      sampleWeights.push(0);
    }
  }

  // Gaps between busy stretches, plus the head and tail of the track. Short
  // gaps are left alone: they are pauses within a turn rather than waiting.
  const IDLE_THRESHOLD = 2000;
  let cursor = registerTime;
  for (const span of busySpans) {
    if (span.start - cursor > IDLE_THRESHOLD) {
      markIdle(cursor, span.start);
    }
    cursor = Math.max(cursor, span.end);
  }
  if (unregisterTime - cursor > IDLE_THRESHOLD) {
    markIdle(cursor, unregisterTime);
  }

  // Samples have to be in time order. Messages are not strictly ordered by
  // timestamp within a thread, and one message contributes several samples, so
  // they are sorted rather than assumed to come out in order.
  const sampleOrder = sampleTimes
    .map((time, index) => index)
    .sort((a, b) => sampleTimes[a] - sampleTimes[b]);

  const samples = {
    length: sampleOrder.length,
    stack: sampleOrder.map(index => sampleStacks[index]),
    time: sampleOrder.map(index => sampleTimes[index]),
    weight: sampleOrder.map(index => sampleWeights[index]),
    weightType: 'bytes'
  };

  // Create resource table
  return {
    processType: 'default',
    processName,
    processStartupTime: registerTime,
    processShutdownTime: unregisterTime,
    registerTime,
    unregisterTime,
    pausedRanges: [],
    showMarkersInTimeline: true,
    name: threadName,
    isMainThread: true,
    pid,
    tid,
    samples,
    markers
    // The stack, frame, func and resource tables are on profile.shared.
  };
}

// `subagents` comes from readSubagents(). Callers that only pass the main
// session entries get the sub-agents looked up from the session id, so they
// don't silently lose everything the sub-agents did; pass [] to opt out.
function createFirefoxProfile(jsonlData, subagents) {
  const messages = conversationEntries(jsonlData);

  if (messages.length === 0) {
    throw new Error('No messages found in the jsonl file');
  }

  if (!subagents) {
    subagents = readSubagentsForSession(messages[0].sessionId);
  }

  // Describe every track: the main conversation plus one per sub-agent.
  const tracks = [{
    id: 'main',
    entries: jsonlData,
    messages,
    threadName: sessionTitle(jsonlData),
    processName: messages[0].cwd || 'Claude Conversation'
  }];

  subagents.forEach((agent) => {
    const agentMessages = conversationEntries(agent.entries);
    if (agentMessages.length === 0) {
      return;
    }

    const description = agent.meta.description || agent.id;
    const agentType = agent.meta.agentType || 'agent';

    tracks.push({
      id: agent.id,
      entries: agent.entries,
      messages: agentMessages,
      threadName: description,
      processName: `${agentType} (depth ${agent.meta.spawnDepth || 1})`,
      agentType,
      description,
      toolUseId: agent.meta.toolUseId
    });
  });

  // Time range covers every track.
  tracks.forEach((track) => {
    const times = track.messages.map(msg => new Date(msg.timestamp).getTime());
    track.start = Math.min(...times);
    track.end = Math.max(...times);
  });

  // Sub-agent tracks are laid out in the order they started, with the main
  // conversation first. Sub-agent files are named after opaque agent ids, so
  // without this the tracks come out in an arbitrary order.
  tracks.sort((a, b) => {
    if (a.id === 'main') return -1;
    if (b.id === 'main') return 1;
    return a.start - b.start;
  });

  const startTime = Math.min(...tracks.map(track => track.start));

  // Cost of every API call, with two running totals: the one for the track the
  // call belongs to, and the one for the session as a whole. The session total
  // has to be accumulated in timestamp order across all tracks, since agents
  // run concurrently.
  tracks.forEach((track) => {
    track.apiCalls = uniqueApiCalls(track.messages).map(msg => ({
      msg,
      time: new Date(msg.timestamp).getTime(),
      costs: calculateCost(msg.message.usage, getPricingForModel(msg.message.model))
    }));

    let agentCost = 0;
    track.apiCalls.forEach((call) => {
      agentCost += call.costs.total;
      call.agentCost = agentCost;
    });
    track.cost = agentCost;
  });

  let sessionCost = 0;
  const totalCostPoints = tracks
    .flatMap(track => track.apiCalls)
    .sort((a, b) => a.time - b.time)
    .map((call) => {
      sessionCost += call.costs.total;
      return { time: call.time, total: sessionCost };
    });

  // A sub-agent is listed on whichever track made the Task/Agent tool call its
  // meta.json points at, so nested agents show up on their spawner's track.
  tracks.forEach((track) => {
    track.toolUses = findAgentToolUses(track.messages);
    track.spans = [];
  });

  tracks.forEach((track) => {
    if (!track.toolUseId) {
      return;
    }
    const spawner = tracks.find(candidate => candidate.toolUses.has(track.toolUseId));
    if (spawner) {
      spawner.spans.push({
        agentId: track.id,
        agentType: track.agentType,
        description: track.description,
        start: track.start,
        end: track.end,
        cost: track.cost
      });
    }
  });

  // One set of tables for the whole profile, and one embedded transcript per
  // track, so the source view shows the conversation for the frame that was
  // double-clicked.
  const shared = createTimelineShared();
  const usedNames = new Map();

  const threads = tracks.map((track, index) => {
    const toolUses = new Map();
    track.messages.forEach((msg) => {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        content.forEach((block) => {
          if (block.type === 'tool_use') toolUses.set(block.id, block);
        });
      }
    });

    const transcript = renderTranscript(track.messages, toolUses, {
      title: track.threadName,
      subtitle: track.processName
    });

    const base = `${sourceSlug(track.threadName)}.transcript.txt`;
    const seen = usedNames.get(base) || 0;
    usedNames.set(base, seen + 1);
    const sourceFile = seen === 0
      ? base
      : `${sourceSlug(track.threadName)}-${seen + 1}.transcript.txt`;

    return buildThread({
      entries: track.entries,
      messages: track.messages,
      apiCalls: track.apiCalls,
      totalCostPoints: track.id === 'main' ? totalCostPoints : null,
      startTime,
      threadName: track.threadName,
      processName: track.processName,
      // Numeric, and increasing with start time: the profiler orders process
      // tracks by pid, and string pids would sort "10" before "2".
      pid: index,
      tid: index,
      spans: track.spans,
      registerTime: track.start - startTime,
      unregisterTime: track.end - startTime,
      shared,
      transcript,
      sourceFile
    });
  });

  // Create categories
  const categories = [
    {
      name: 'Other',
      color: 'grey',
      subcategories: ['Other']
    },
    {
      name: 'Messages',
      color: 'blue',
      subcategories: ['Other']
    },
    {
      name: 'Subagents',
      color: 'yellow',
      subcategories: ['Other']
    },
    {
      name: 'Tools',
      color: 'green',
      subcategories: ['Other']
    },
    {
      name: 'Failed tools',
      color: 'red',
      subcategories: ['Other']
    },
    {
      name: 'Model',
      color: 'purple',
      subcategories: ['Other']
    },
    {
      name: 'Idle',
      color: 'transparent',
      subcategories: ['Other']
    }
  ];

  // Marker schema for Text, Subagent and separate Token Usage markers
  const markerSchema = [
    {
      name: 'Text',
      tooltipLabel: '{marker.name}',
      tableLabel: '{marker.data.text}',
      chartLabel: '{marker.name}',
      display: ['marker-chart', 'marker-table'],
      fields: [
        {
          key: 'text',
          label: 'Content',
          format: 'string'
        }
      ]
    },
    {
      name: 'ModelResponse',
      tooltipLabel: '{marker.data.model}',
      tableLabel: '{marker.data.model} ({marker.data.stopReason})',
      chartLabel: '{marker.data.stopReason}',
      display: ['marker-chart', 'marker-table', 'timeline-overview'],
      fields: [
        {
          key: 'model',
          label: 'Model',
          format: 'string'
        },
        {
          key: 'effort',
          label: 'Effort',
          format: 'string'
        },
        {
          key: 'speed',
          label: 'Speed',
          format: 'string'
        },
        {
          key: 'stopReason',
          label: 'Stop reason',
          format: 'string'
        },
        {
          key: 'outputTokens',
          label: 'Output Tokens',
          format: 'integer'
        },
        {
          key: 'iterations',
          label: 'Iterations',
          format: 'integer'
        }
      ]
    },
    {
      name: 'Turn',
      tooltipLabel: '{marker.name}',
      tableLabel: '{marker.name} ({marker.data.messages} messages)',
      chartLabel: '{marker.name}',
      display: ['marker-chart', 'marker-table'],
      fields: [
        {
          key: 'messages',
          label: 'Messages in context',
          format: 'integer'
        },
        {
          key: 'backgroundAgents',
          label: 'Pending background agents',
          format: 'integer'
        }
      ]
    },
    {
      name: 'Intervention',
      tooltipLabel: '{marker.data.kind}',
      tableLabel: '{marker.name}: {marker.data.kind}',
      chartLabel: '{marker.data.kind}',
      display: ['marker-chart', 'marker-table', 'timeline-overview'],
      fields: [
        {
          key: 'kind',
          label: 'Kind',
          format: 'string'
        },
        {
          key: 'text',
          label: 'Content',
          format: 'string'
        }
      ]
    },
    {
      name: 'ToolCall',
      tooltipLabel: '{marker.data.name}',
      tableLabel: '{marker.data.name} — {marker.data.detail}',
      chartLabel: '{marker.data.detail}',
      display: ['marker-chart', 'marker-table', 'timeline-overview'],
      fields: [
        {
          key: 'detail',
          label: 'Input',
          format: 'string'
        },
        {
          key: 'outputBytes',
          label: 'Output size',
          format: 'bytes'
        },
        {
          key: 'status',
          label: 'Status',
          format: 'string'
        }
      ]
    },
    {
      name: 'Subagent',
      tooltipLabel: '{marker.data.description}',
      tableLabel: '{marker.data.agentType}: {marker.data.description}',
      chartLabel: '{marker.data.description}',
      display: ['marker-chart', 'marker-table', 'timeline-overview'],
      fields: [
        {
          key: 'description',
          label: 'Task',
          format: 'string'
        },
        {
          key: 'agentType',
          label: 'Agent type',
          format: 'string'
        },
        {
          key: 'agentId',
          label: 'Agent id',
          format: 'string'
        },
        {
          key: 'cost',
          label: 'Cost ($)',
          format: 'decimal'
        }
      ]
    },
    {
      name: 'ContextSize',
      tooltipLabel: '{marker.name}',
      display: [],
      fields: [
        {
          key: 'tokens',
          label: 'Context Size',
          format: 'integer'
        }
      ],
      graphs: [
        { key: 'tokens', color: 'teal', type: 'line' }
      ]
    },
    {
      name: 'Cost',
      tooltipLabel: '{marker.name}',
      display: [],
      fields: [
        {
          key: 'cost',
          label: 'Cost',
          format: 'decimal'
        },
        // Pre-formatted, since each of these is a cost and the tokens that
        // bought it rather than a number the front end could format itself.
        {
          key: 'output',
          label: 'Output',
          format: 'string'
        },
        {
          key: 'input',
          label: 'Input',
          format: 'string'
        },
        {
          key: 'cacheRead',
          label: 'Cache read',
          format: 'string'
        },
        {
          key: 'cacheWrite',
          label: 'Cache write',
          format: 'string'
        }
      ],
      graphs: [
        { key: 'cost', color: 'red', type: 'bar' }
      ]
    },
    {
      name: 'AgentCost',
      tooltipLabel: '{marker.name}',
      display: [],
      fields: [
        {
          key: 'total',
          label: 'Agent Cost (cumulative)',
          format: 'decimal'
        }
      ],
      graphs: [
        { key: 'total', color: 'red', type: 'line' }
      ]
    },
    {
      name: 'TotalCost',
      tooltipLabel: '{marker.name}',
      display: [],
      fields: [
        {
          key: 'total',
          label: 'Total Cost',
          format: 'decimal'
        }
      ],
      graphs: [
        { key: 'total', color: 'magenta', type: 'line' }
      ]
    }
  ];

  // Create the profile
  const profile = {
    meta: {
      processType: 0,
      product: 'Claude Code',
      stackwalk: 0,
      // The processed-format version, which is what the front end upgrades
      // from. v64 is the first one whose sources table has a `content` column,
      // where each track's transcript is embedded; older versions have that
      // table rebuilt by the upgraders, which drops the text.
      version: 64,
      preprocessedProfileVersion: 64,
      symbolicationNotSupported: true,
      interval: 1,
      startTime,
      profilingStartTime: 0,
      markerSchema,
      categories,
      usesOnlyOneStackType: true
    },
    libs: [],
    threads,
    // Built after every track has interned into it.
    shared: buildTimelineShared(shared),
    counters: []
  };

  return profile;
}

// The profiler front end fetches the profile from the browser, so it has to be
// told which origin is allowed to read it. profiler.firefox.com is the hosted
// front end; a local checkout runs on http://localhost:4242 by default.
const DEFAULT_PROFILER_ORIGIN = 'https://profiler.firefox.com';

function startServer(profileData, profilerOrigin) {
  return new Promise((resolve) => {
    let shutdownRequested = false;
    // Serialized once: the profile embeds the session transcripts, so this is
    // megabytes of JSON that every request would otherwise rebuild.
    const body = Buffer.from(JSON.stringify(profileData), 'utf8');

    const server = http.createServer((req, res) => {
      // A CORS preflight carries no body and must not be answered with one.
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': profilerOrigin,
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400'
        });
        res.end();
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        // A Buffer's length is the byte count, which is what this header means:
        // the profile contains non-ASCII text, so a string's length would be
        // short of it and the response would look truncated.
        'Content-Length': body.length,
        'Access-Control-Allow-Origin': profilerOrigin
      });

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      // Only once the body has actually gone out: res.end() queues the write
      // rather than completing it, and closing the server before it drains
      // truncates the response mid-body.
      res.end(body, () => {
        shutdownRequested = true;
      });
    });

    // Bound to the IPv4 loopback explicitly: listening on 'localhost' resolves
    // to ::1 on some systems, and the bare IPv6 address it reports back makes
    // an invalid URL (http://::1:1234/) that the front end cannot fetch.
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const serverUrl = `http://127.0.0.1:${port}/`;
      resolve({ server, serverUrl, shutdownRequested: () => shutdownRequested });
    });
  });
}

async function openProfiler(serverUrl, profilerOrigin) {
  // `thread=0` makes the front end treat the track layout as coming from the
  // URL, which skips the default ordering pass — that pass sorts process tracks
  // by activity score and would scramble the order the threads are in.
  const profilerUrl =
    `${profilerOrigin}/from-url/${encodeURIComponent(serverUrl)}?thread=0`;

  // Try to open with xdg-open on Linux, open on macOS, or start on Windows
  const command = process.platform === 'darwin' ? 'open' :
                  process.platform === 'win32' ? 'start' : 'xdg-open';

  try {
    spawn(command, [profilerUrl], { detached: true, stdio: 'ignore' }).unref();
    console.log(`Opening Firefox Profiler...`);
    console.log(`If the browser doesn't open, visit: ${profilerUrl}`);
  } catch (error) {
    console.log(`Please open this URL in a browser: ${profilerUrl}`);
  }
}

// What the size profile found, printed so the numbers are visible without
// opening the front end.
function reportSizeProfile(profile, sizeAt) {
  console.log(`Created size profile with ${profile.threads.length} tracks ` +
    `(context window at its ${sizeAt === 'last' ? 'last API call' : 'peak'})`);

  for (const track of profile.tracks) {
    const { calibration: fit, thread } = track;
    const tokens = Math.round(thread.totalBytes / fit.bytesPerToken);
    console.log(`  ${thread.name}`);
    console.log(`    ${(thread.totalBytes / 1024).toFixed(0)}KB of context ` +
      `≈ ${tokens.toLocaleString()} tokens, ` +
      `API reported ${track.reportedTokens.toLocaleString()} ` +
      `(call ${track.callIndex + 1}/${track.callCount})`);
    if (fit.fitted) {
      console.log(`    calibrated at ${fit.bytesPerToken.toFixed(2)} bytes/token ` +
        `over ${fit.samples} calls, median error ` +
        `${(100 * fit.medianError).toFixed(1)}%`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);

  // Optional --profiler-origin, for pointing at a local front-end checkout
  // instead of the hosted profiler.
  let profilerOrigin = process.env.PROFILER_ORIGIN || DEFAULT_PROFILER_ORIGIN;
  // --size builds a size profile of the context window instead of a timeline.
  let sizeProfile = false;
  let sizeAt = 'peak';
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--profiler-origin') {
      profilerOrigin = args[++i];
    } else if (args[i].startsWith('--profiler-origin=')) {
      profilerOrigin = args[i].slice('--profiler-origin='.length);
    } else if (args[i] === '--size') {
      sizeProfile = true;
    } else if (args[i] === '--at') {
      sizeAt = args[++i];
    } else if (args[i].startsWith('--at=')) {
      sizeAt = args[i].slice('--at='.length);
    } else {
      positional.push(args[i]);
    }
  }

  if (positional.length === 0 || !profilerOrigin) {
    console.error('Usage: claude-profiler <jsonl-file> [options]');
    console.error('');
    console.error('  --size                  Profile what fills the context window,');
    console.error('                          instead of the session timeline.');
    console.error('  --at peak|last          Which API call\'s window to profile,');
    console.error('                          with --size. Defaults to peak.');
    console.error('  --profiler-origin <url> Front end to open.');
    console.error('');
    console.error('Example: claude-profiler ~/.claude/projects/my-project/my-session.jsonl');
    process.exit(1);
  }

  if (sizeAt !== 'peak' && sizeAt !== 'last') {
    console.error(`Error: --at expects "peak" or "last", got "${sizeAt}"`);
    process.exit(1);
  }

  const filePath = positional[0].startsWith('~')
    ? path.join(os.homedir(), positional[0].slice(1))
    : path.resolve(positional[0]);

  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  console.log(`Reading ${filePath}...`);

  try {
    const jsonlData = readJsonlFile(filePath);
    console.log(`Parsed ${jsonlData.length} entries`);

    const subagents = readSubagents(filePath);
    if (subagents.length > 0) {
      const entryCount = subagents.reduce((sum, agent) => sum + agent.entries.length, 0);
      console.log(`Found ${subagents.length} sub-agents (${entryCount} entries)`);
    }

    let profile;
    if (sizeProfile) {
      const { createSizeProfile } = require('./context-size.js');
      profile = createSizeProfile(jsonlData, subagents, { at: sizeAt });
      reportSizeProfile(profile, sizeAt);
      // The reporting fields are not part of the profile format.
      delete profile.tracks;
      delete profile.totalBytes;
    } else {
      profile = createFirefoxProfile(jsonlData, subagents);
      console.log(`Created Firefox profile with ${profile.threads.length} tracks`);

      const cost = totalCost(conversationEntries(jsonlData)) +
        subagents.reduce((sum, agent) => sum + totalCost(conversationEntries(agent.entries)), 0);
      console.log(`Total cost: $${cost.toFixed(2)}`);
    }

    const { server, serverUrl, shutdownRequested } = await startServer(profile, profilerOrigin);
    console.log(`Server started at ${serverUrl}`);

    await openProfiler(serverUrl, profilerOrigin);

    // Wait for the profile to be fetched
    const checkInterval = setInterval(() => {
      if (shutdownRequested()) {
        clearInterval(checkInterval);
        server.close(() => {
          console.log('Profile loaded, server stopped');
          process.exit(0);
        });
      }
    }, 100);

    // Timeout after 60 seconds
    setTimeout(() => {
      clearInterval(checkInterval);
      server.close(() => {
        console.log('Timeout reached, stopping server');
        process.exit(0);
      });
    }, 60000);

  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  readJsonlFile,
  readSubagents,
  readSubagentsForSession,
  createFirefoxProfile,
  // Size profile of the context window, from context-size.js.
  createSizeProfile: (...args) => require('./context-size.js').createSizeProfile(...args)
};

if (require.main === module) {
  main();
}
