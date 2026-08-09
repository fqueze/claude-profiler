#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Pricing per million tokens (updated January 2025)
// Source: https://docs.anthropic.com/en/docs/about-claude/pricing
// Cache pricing: write = 1.25x input, read = 0.1x input
const PRICING = {
  // Claude 3 Haiku
  'claude-3-haiku': {
    input: 0.25,
    output: 1.25,
    cacheWrite: 0.30,  // 0.25 * 1.25
    cacheRead: 0.03    // 0.25 * 0.1
  },
  // Claude 3.5 Haiku
  'claude-3-5-haiku': {
    input: 0.80,
    output: 4.00,
    cacheWrite: 1.00,  // 0.80 * 1.25
    cacheRead: 0.08    // 0.80 * 0.1
  },
  // Claude 4.5 Haiku
  'claude-haiku-4-5': {
    input: 1.00,
    output: 5.00,
    cacheWrite: 1.25,  // 1.00 * 1.25
    cacheRead: 0.10    // 1.00 * 0.1
  },
  // Claude 3.5 Sonnet
  'claude-3-5-sonnet': {
    input: 3.00,
    output: 15.00,
    cacheWrite: 3.75,  // 3.00 * 1.25
    cacheRead: 0.30    // 3.00 * 0.1
  },
  // Claude 4.5 Sonnet
  'claude-sonnet-4-5': {
    input: 3.00,
    output: 15.00,
    cacheWrite: 3.75,  // 3.00 * 1.25
    cacheRead: 0.30    // 3.00 * 0.1
  },
  // Claude 4.1 Sonnet
  'claude-4-1-sonnet': {
    input: 5.00,
    output: 25.00,
    cacheWrite: 6.25,  // 5.00 * 1.25
    cacheRead: 0.50    // 5.00 * 0.1
  },
  // Claude Opus 4
  'claude-opus-4': {
    input: 15.00,
    output: 75.00,
    cacheWrite: 18.75,  // 15.00 * 1.25
    cacheRead: 1.50     // 15.00 * 0.1
  },
  // Default pricing (use 3.5 Sonnet as default)
  'default': {
    input: 3.00,
    output: 15.00,
    cacheWrite: 3.75,
    cacheRead: 0.30
  }
};

function getPricingForModel(modelId) {
  if (!modelId) return PRICING.default;

  const model = modelId.toLowerCase();

  // Match specific model versions
  if (model.includes('opus') && model.includes('4')) return PRICING['claude-opus-4'];
  if (model.includes('sonnet-4-5') || model.includes('sonnet-4.5')) return PRICING['claude-sonnet-4-5'];
  if (model.includes('haiku-4-5') || model.includes('haiku-4.5')) return PRICING['claude-haiku-4-5'];
  if (model.includes('sonnet') && model.includes('3.5')) return PRICING['claude-3-5-sonnet'];
  if (model.includes('haiku') && model.includes('3.5')) return PRICING['claude-3-5-haiku'];
  if (model.includes('haiku') && model.includes('3-haiku')) return PRICING['claude-3-haiku'];

  // Fallback for generic model names
  if (model.includes('opus')) return PRICING['claude-opus-4'];
  if (model.includes('sonnet')) return PRICING['claude-sonnet-4-5'];
  if (model.includes('haiku')) return PRICING['claude-haiku-4-5'];

  return PRICING.default;
}

function calculateCost(usage, pricing) {
  const inputCost = (usage.input_tokens || 0) * pricing.input / 1000000;
  const outputCost = (usage.output_tokens || 0) * pricing.output / 1000000;
  const cacheWriteCost = (usage.cache_creation_input_tokens || 0) * pricing.cacheWrite / 1000000;
  const cacheReadCost = (usage.cache_read_input_tokens || 0) * pricing.cacheRead / 1000000;

  return {
    input: inputCost,
    output: outputCost,
    cacheWrite: cacheWriteCost,
    cacheRead: cacheReadCost,
    total: inputCost + outputCost + cacheWriteCost + cacheReadCost
  };
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
  unregisterTime
}) {
  const stringTable = new Map();
  const strings = [];

  function addString(str) {
    if (!stringTable.has(str)) {
      stringTable.set(str, strings.length);
      strings.push(str);
    }
    return stringTable.get(str);
  }

  const rootStrIdx = addString('(root)');

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

  // Separate token usage markers for each unique API call
  const outputTokensNameIdx = addString('Output Tokens');
  const inputTokensNameIdx = addString('Input Tokens');
  const cacheReadTokensNameIdx = addString('Cache Read Tokens');
  const cacheCreationTokensNameIdx = addString('Cache Creation Tokens');
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

    if (usage.output_tokens > 0) {
      addMarker(outputTokensNameIdx, relativeTime, relativeTime, 0, 1, {
        type: 'OutputTokens',
        count: usage.output_tokens
      });
    }

    if (usage.input_tokens > 0) {
      addMarker(inputTokensNameIdx, relativeTime, relativeTime, 0, 1, {
        type: 'InputTokens',
        count: usage.input_tokens
      });
    }

    if (usage.cache_read_input_tokens > 0) {
      addMarker(cacheReadTokensNameIdx, relativeTime, relativeTime, 0, 1, {
        type: 'CacheReadTokens',
        count: usage.cache_read_input_tokens
      });
    }

    if (usage.cache_creation_input_tokens > 0) {
      addMarker(cacheCreationTokensNameIdx, relativeTime, relativeTime, 0, 1, {
        type: 'CacheCreationTokens',
        count: usage.cache_creation_input_tokens
      });
    }

    if (costs.total > 0) {
      addMarker(costNameIdx, relativeTime, relativeTime, 0, 1, {
        type: 'Cost',
        cost: costs.total,
        input: costs.input,
        output: costs.output,
        cacheWrite: costs.cacheWrite,
        cacheRead: costs.cacheRead
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

  // Create samples (one sample per message with text)
  const samples = {
    length: messagesWithText.length,
    stack: new Array(messagesWithText.length).fill(0),
    time: messagesWithText.map(msg => new Date(msg.timestamp).getTime() - startTime),
    weight: null,
    weightType: 'samples'
  };

  // Create stack table (simple: just one stack frame)
  const stackTable = {
    frame: [0],
    prefix: [null],
    category: [0],
    subcategory: [0],
    length: 1
  };

  // Create frame table
  const frameTable = {
    address: [-1],
    inlineDepth: [0],
    category: [null],
    subcategory: [0],
    func: [0],
    nativeSymbol: [null],
    innerWindowID: [0],
    implementation: [null],
    line: [null],
    column: [null],
    length: 1
  };

  // Create function table
  const funcTable = {
    name: [rootStrIdx],
    isJS: [false],
    relevantForJS: [false],
    resource: [-1],
    fileName: [null],
    lineNumber: [null],
    columnNumber: [null],
    length: 1
  };

  // Create resource table
  const resourceTable = {
    lib: [],
    name: [],
    host: [],
    type: [],
    length: 0
  };

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
    markers,
    stackTable,
    frameTable,
    stringArray: strings,
    funcTable,
    resourceTable,
    nativeSymbols: {
      address: [],
      functionSize: [],
      libIndex: [],
      name: [],
      length: 0
    }
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

  const threads = tracks.map((track, index) => buildThread({
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
    unregisterTime: track.end - startTime
  }));

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
      data: [
        {
          key: 'text',
          label: 'Content',
          format: 'string',
          searchable: true
        }
      ]
    },
    {
      name: 'ModelResponse',
      tooltipLabel: '{marker.data.model}',
      tableLabel: '{marker.data.model} ({marker.data.stopReason})',
      chartLabel: '{marker.data.stopReason}',
      display: ['marker-chart', 'marker-table', 'timeline-overview'],
      data: [
        {
          key: 'model',
          label: 'Model',
          format: 'string',
          searchable: true
        },
        {
          key: 'effort',
          label: 'Effort',
          format: 'string',
          searchable: true
        },
        {
          key: 'speed',
          label: 'Speed',
          format: 'string'
        },
        {
          key: 'stopReason',
          label: 'Stop reason',
          format: 'string',
          searchable: true
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
      data: [
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
      data: [
        {
          key: 'kind',
          label: 'Kind',
          format: 'string',
          searchable: true
        },
        {
          key: 'text',
          label: 'Content',
          format: 'string',
          searchable: true
        }
      ]
    },
    {
      name: 'ToolCall',
      tooltipLabel: '{marker.data.name}',
      tableLabel: '{marker.data.name} — {marker.data.detail}',
      chartLabel: '{marker.data.detail}',
      display: ['marker-chart', 'marker-table', 'timeline-overview'],
      data: [
        {
          key: 'detail',
          label: 'Input',
          format: 'string',
          searchable: true
        },
        {
          key: 'outputBytes',
          label: 'Output size',
          format: 'bytes'
        },
        {
          key: 'status',
          label: 'Status',
          format: 'string',
          searchable: true
        }
      ]
    },
    {
      name: 'Subagent',
      tooltipLabel: '{marker.data.description}',
      tableLabel: '{marker.data.agentType}: {marker.data.description}',
      chartLabel: '{marker.data.description}',
      display: ['marker-chart', 'marker-table', 'timeline-overview'],
      data: [
        {
          key: 'description',
          label: 'Task',
          format: 'string',
          searchable: true
        },
        {
          key: 'agentType',
          label: 'Agent type',
          format: 'string',
          searchable: true
        },
        {
          key: 'agentId',
          label: 'Agent id',
          format: 'string',
          searchable: true
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
      data: [
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
      name: 'OutputTokens',
      tooltipLabel: '{marker.name}',
      display: [],
      data: [
        {
          key: 'count',
          label: 'Output Tokens',
          format: 'integer'
        }
      ],
      graphs: [
        { key: 'count', color: 'blue', type: 'bar' }
      ]
    },
    {
      name: 'InputTokens',
      tooltipLabel: '{marker.name}',
      display: [],
      data: [
        {
          key: 'count',
          label: 'Input Tokens',
          format: 'integer'
        }
      ],
      graphs: [
        { key: 'count', color: 'green', type: 'bar' }
      ]
    },
    {
      name: 'CacheReadTokens',
      tooltipLabel: '{marker.name}',
      display: [],
      data: [
        {
          key: 'count',
          label: 'Cache Read Tokens',
          format: 'integer'
        }
      ],
      graphs: [
        { key: 'count', color: 'purple', type: 'bar' }
      ]
    },
    {
      name: 'CacheCreationTokens',
      tooltipLabel: '{marker.name}',
      display: [],
      data: [
        {
          key: 'count',
          label: 'Cache Creation Tokens',
          format: 'integer'
        }
      ],
      graphs: [
        { key: 'count', color: 'orange', type: 'bar' }
      ]
    },
    {
      name: 'Cost',
      tooltipLabel: '{marker.name}',
      display: [],
      data: [
        {
          key: 'cost',
          label: 'Cost',
          format: 'decimal'
        },
        {
          key: 'input',
          label: 'Input Cost',
          format: 'decimal'
        },
        {
          key: 'output',
          label: 'Output Cost',
          format: 'decimal'
        },
        {
          key: 'cacheWrite',
          label: 'Cache Write Cost',
          format: 'decimal'
        },
        {
          key: 'cacheRead',
          label: 'Cache Read Cost',
          format: 'decimal'
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
      data: [
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
      data: [
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
      version: 27,
      preprocessedProfileVersion: 47,
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
    counters: []
  };

  return profile;
}

function startServer(profileData) {
  return new Promise((resolve) => {
    let shutdownRequested = false;

    const server = http.createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': 'https://profiler.firefox.com'
      });
      res.end(JSON.stringify(profileData));
      shutdownRequested = true;
    });

    server.listen(0, 'localhost', () => {
      const { address, port } = server.address();
      const serverUrl = `http://${address}:${port}/`;
      resolve({ server, serverUrl, shutdownRequested: () => shutdownRequested });
    });
  });
}

async function openProfiler(serverUrl) {
  // `thread=0` makes the front end treat the track layout as coming from the
  // URL, which skips the default ordering pass — that pass sorts process tracks
  // by activity score and would scramble the order the threads are in.
  const profilerUrl =
    `https://profiler.firefox.com/from-url/${encodeURIComponent(serverUrl)}?thread=0`;

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

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: claude-profiler <jsonl-file>');
    console.error('Example: claude-profiler ~/.claude/projects/my-session.jsonl');
    process.exit(1);
  }

  const filePath = args[0].startsWith('~')
    ? path.join(process.env.HOME, args[0].slice(1))
    : path.resolve(args[0]);

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

    const profile = createFirefoxProfile(jsonlData, subagents);
    console.log(`Created Firefox profile with ${profile.threads.length} tracks`);

    const cost = totalCost(conversationEntries(jsonlData)) +
      subagents.reduce((sum, agent) => sum + totalCost(conversationEntries(agent.entries)), 0);
    console.log(`Total cost: $${cost.toFixed(2)}`);

    const { server, serverUrl, shutdownRequested } = await startServer(profile);
    console.log(`Server started at ${serverUrl}`);

    await openProfiler(serverUrl);

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
  createFirefoxProfile
};

if (require.main === module) {
  main();
}
