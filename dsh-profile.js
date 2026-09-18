// Turn DSH session logs into a processed Firefox Profiler profile. DSH records
// explicit turn, step and tool spans with millisecond timestamps, one usage
// snapshot per model response, and the OpenRouter generation id that response
// was billed under, so tracks carry tokens and dollars as well as what ran.

function timestamp(entry) {
  return Number.isFinite(entry?.time) ? entry.time : null;
}

function textBlocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => block?.text || '').filter(Boolean).join('\n');
}

// A tool result carries its call id either on the result block or on the
// message's tool source, depending on the record generation.
function toolResultOf(entry) {
  const message = entry.data?.message || {};
  const content = message.content;
  const block = Array.isArray(content)
    ? content.find(candidate => candidate?.type === 'tool-result')
    : content;
  return {
    callId: block?.toolCallId || message.source?.callId || null,
    text: textBlocks(block?.content ?? content),
    failed: block?.isError === true || entry.data?.meta?.isError === true
  };
}

// The one line that identifies what a tool was asked to do, out of the JSON
// arguments DSH stores as a string.
function toolDetail(name, args) {
  let parsed = null;
  try {
    parsed = JSON.parse(args);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') return String(args || '').slice(0, 500);

  const parts = [];
  if (parsed.command) parts.push(parsed.command);
  else if (parsed.file_path) parts.push(parsed.file_path);
  else if (parsed.path) parts.push(parsed.path);
  if (parsed.pattern) parts.push(parsed.pattern);
  if (parts.length === 0 && parsed.description) parts.push(parsed.description);
  return (parts.join(' · ') || String(args || '')).slice(0, 500);
}

// Everything one session's records say about its timeline, in one pass. The
// current request config is carried forward because request/header has no turn
// or step of its own: it is what the step that follows is about to use.
function readTrack(entries) {
  let config = {};
  const calls = new Map();
  const results = new Map();
  const responses = [];
  const userMessages = [];
  const systemMessages = [];
  const errors = [];
  const turns = [];
  const openTurns = new Map();
  let title = null;

  for (const entry of entries) {
    const at = timestamp(entry);
    switch (entry.type) {
      case 'request/header':
        config = entry.data?.header?.config || config;
        // turn/start precedes the request that describes it, so the open turn
        // learns its model and effort from the first header that follows.
        for (const open of openTurns.values()) {
          if (!open.config?.model) open.config = { ...config };
        }
        break;
      case 'request/context':
        config = { ...config, ...(entry.data || {}) };
        break;
      case 'user/message':
        if (at !== null && textBlocks(entry.data?.content)) {
          userMessages.push({ at, text: textBlocks(entry.data.content) });
        }
        break;
      case 'system/message': {
        const text = textBlocks(entry.data?.message) ||
          (typeof entry.data?.message === 'string' ? entry.data.message : '');
        if (at !== null && text) systemMessages.push({ at, text });
        break;
      }
      case 'assistant/message': {
        const message = entry.data?.message || {};
        responses.push({
          at,
          turn: entry.data?.turn,
          step: entry.data?.step,
          model: message.source?.model || config.model || 'unknown',
          effort: config.reasoningEffort || '',
          usage: entry.data?.usage || {},
          responseId: message.source?.replayState?.response?.responseId || null,
          blocks: Array.isArray(message.content) ? message.content : []
        });
        break;
      }
      case 'assistant/attempt': {
        const failure = entry.data?.stream
          ?.map(chunk => chunk?.chunk?.reason?.failure)
          .find(Boolean);
        if (at !== null) {
          errors.push({ at, text: failure?.message || 'model call failed' });
        }
        break;
      }
      case 'tool/call':
        calls.set(entry.data?.callId || `${entry.data?.turn}:${entry.data?.step}`,
          { callId: entry.data?.callId || `${entry.data?.turn}:${entry.data?.step}`,
            at, name: entry.data?.name || 'tool', arguments: entry.data?.arguments || '',
            turn: entry.data?.turn, step: entry.data?.step, config: { ...config } });
        break;
      case 'tool/result': {
        const result = toolResultOf(entry);
        if (result.callId) results.set(result.callId, { at, ...result });
        break;
      }
      case 'turn/start':
        openTurns.set(entry.data?.turn, { at, config: { ...config } });
        break;
      case 'turn/end': {
        const open = openTurns.get(entry.data?.turn);
        if (at !== null) {
          turns.push({ start: open?.at ?? at, end: at, turn: entry.data?.turn,
            reason: entry.data?.reason?.kind || 'ended',
            config: open?.config || {} });
        }
        break;
      }
      case 'session/title':
        title = entry.data?.title || title;
        break;
    }
  }

  return { calls, results, responses, userMessages, systemMessages, errors, turns, title };
}

// The readable transcript that becomes the sample stacks, so the call tree,
// flame graph and source view have the same content as the markers.
function transcriptEvents(track) {
  const events = [];
  for (const message of track.userMessages) {
    events.push({ at: message.at, label: 'User', text: message.text, category: 1 });
  }
  for (const message of track.systemMessages) {
    events.push({ at: message.at, label: 'System', text: message.text, category: 0 });
  }
  for (const error of track.errors) {
    events.push({ at: error.at, label: 'Error', text: error.text, category: 4 });
  }
  for (const response of track.responses) {
    if (response.at === null) continue;
    const text = textBlocks(response.blocks.filter(block => block?.type === 'text'));
    const reasoning = textBlocks(response.blocks.filter(block => block?.type === 'reasoning'));
    if (text) events.push({ at: response.at, label: 'DSH', text, category: 1 });
    if (reasoning) {
      events.push({ at: response.at, label: 'Reasoning', text: reasoning, category: 5 });
    }
  }
  for (const call of track.calls.values()) {
    const result = track.results.get(call.callId);
    const text = [toolDetail(call.name, call.arguments), result?.text || '']
      .filter(Boolean).join('\n\n');
    if (call.at === null || !text) continue;
    events.push({ at: result?.at ?? call.at, label: call.name, text,
      category: result?.failed ? 4 : 3 });
  }
  return events.sort((a, b) => a.at - b.at);
}

function markerSchemas() {
  return [
    { name: 'Text', tooltipLabel: '{marker.name}', tableLabel: '{marker.name}: {marker.data.text}',
      chartLabel: '{marker.name}', display: ['marker-chart', 'marker-table'],
      fields: [{ key: 'text', label: 'Content', format: 'string' }] },
    { name: 'Turn', tooltipLabel: '{marker.name}', tableLabel: '{marker.name}: {marker.data.status}',
      chartLabel: '{marker.name}', display: ['marker-chart', 'marker-table', 'timeline-overview'],
      fields: [
        { key: 'status', label: 'Status', format: 'string' },
        { key: 'model', label: 'Model', format: 'string' },
        { key: 'effort', label: 'Effort', format: 'string' }
      ] },
    { name: 'Activity', tooltipLabel: '{marker.name}',
      tableLabel: '{marker.name}: {marker.data.prompt}', chartLabel: '{marker.data.prompt}',
      display: ['marker-chart', 'marker-table', 'timeline-overview'], fields: [
        { key: 'prompt', label: 'Prompt', format: 'string' },
        { key: 'cost', label: 'Cost ($)', format: 'decimal' }
      ] },
    { name: 'Intervention', tooltipLabel: '{marker.name}',
      tableLabel: '{marker.name}: {marker.data.text}', chartLabel: '{marker.name}',
      display: ['marker-chart', 'marker-table'], fields: [
        { key: 'text', label: 'Detail', format: 'string' }
      ] },
    { name: 'ToolCall', tooltipLabel: '{marker.name}',
      tableLabel: '{marker.name} — {marker.data.detail}', chartLabel: '{marker.name}',
      display: ['marker-chart', 'marker-table'], fields: [
        { key: 'detail', label: 'Input', format: 'string' },
        { key: 'status', label: 'Status', format: 'string' },
        { key: 'outputBytes', label: 'Output size', format: 'bytes' }
      ] },
    { name: 'Reasoning', tooltipLabel: '{marker.name}', tableLabel: '{marker.data.text}',
      chartLabel: '{marker.name}', display: ['marker-chart', 'marker-table'],
      fields: [{ key: 'text', label: 'Summary', format: 'string' }] },
    { name: 'ModelResponse', tooltipLabel: '{marker.data.model}',
      tableLabel: '{marker.data.model} ({marker.data.outputTokens} output tokens)',
      chartLabel: '{marker.data.model}', display: ['marker-chart', 'marker-table'], fields: [
        { key: 'model', label: 'Model', format: 'string' },
        { key: 'effort', label: 'Effort', format: 'string' },
        { key: 'inputTokens', label: 'Context tokens', format: 'integer' },
        { key: 'cachedInputTokens', label: 'Cached input', format: 'integer' },
        { key: 'outputTokens', label: 'Output tokens', format: 'integer' },
        { key: 'reasoningTokens', label: 'Reasoning tokens', format: 'integer' }
      ] },
    { name: 'ContextSize', tooltipLabel: '{marker.name}', display: [], fields: [
        { key: 'tokens', label: 'Context Size', format: 'integer' },
        { key: 'cachedTokens', label: 'Cached input', format: 'integer' },
        { key: 'uncachedTokens', label: 'Uncached input', format: 'integer' }
      ], graphs: [
        { key: 'tokens', color: 'blue', type: 'bar' },
        { key: 'cachedTokens', color: 'green', type: 'bar' }
      ] },
    { name: 'OutputTokens', tooltipLabel: '{marker.name}', display: [], fields: [
        { key: 'tokens', label: 'Output Tokens', format: 'integer' },
        { key: 'reasoningTokens', label: 'Reasoning Tokens', format: 'integer' }
      ], graphs: [
        { key: 'tokens', color: 'purple', type: 'bar' },
        { key: 'reasoningTokens', color: 'orange', type: 'bar' }
      ] },
    { name: 'Usage', tooltipLabel: '{marker.name}', tableLabel: '{marker.name}',
      display: ['marker-table'], fields: [
        { key: 'totalTokens', label: 'Total tokens', format: 'integer' },
        { key: 'inputTokens', label: 'Input tokens', format: 'integer' },
        { key: 'cachedTokens', label: 'Cached input', format: 'integer' },
        { key: 'outputTokens', label: 'Output tokens', format: 'integer' },
        { key: 'cost', label: 'Cost ($)', format: 'decimal' }
      ] },
    { name: 'ThreadCost', tooltipLabel: '{marker.name}',
      tableLabel: '{marker.name}: ${marker.data.cost}', display: [], fields: [
        { key: 'cost', label: 'Thread cost ($)', format: 'decimal' }
      ], graphs: [{ key: 'cost', color: 'blue', type: 'line' }] },
    { name: 'ResponseCost', tooltipLabel: '{marker.name}',
      tableLabel: '{marker.name}: ${marker.data.cost}', display: [], fields: [
        { key: 'cost', label: 'Response cost ($)', format: 'decimal' },
        { key: 'inputTokens', label: 'Context tokens', format: 'integer' },
        { key: 'cachedInputTokens', label: 'Cached input', format: 'integer' },
        { key: 'outputTokens', label: 'Output tokens', format: 'integer' }
      ], graphs: [{ key: 'cost', color: 'orange', type: 'bar' }] },
    { name: 'TotalCost', tooltipLabel: '{marker.name}',
      tableLabel: '{marker.name}: ${marker.data.cost}', display: [], fields: [
        { key: 'cost', label: 'Total cost ($)', format: 'decimal' }
      ], graphs: [{ key: 'cost', color: 'purple', type: 'line' }] },
    { name: 'Subagent', tooltipLabel: '{marker.data.title}', tableLabel: '{marker.data.title}',
      chartLabel: '{marker.name}', display: ['marker-chart', 'marker-table'], fields: [
        { key: 'title', label: 'Session', format: 'string' },
        { key: 'threadId', label: 'Session id', format: 'string' }
      ] }
  ];
}

const CATEGORIES = [
  { name: 'Other', color: 'grey', subcategories: ['Other'] },
  { name: 'Messages', color: 'blue', subcategories: ['Other'] },
  { name: 'Subagents', color: 'yellow', subcategories: ['Other'] },
  { name: 'Tools', color: 'green', subcategories: ['Other'] },
  { name: 'Failed tools', color: 'red', subcategories: ['Other'] },
  { name: 'Model', color: 'purple', subcategories: ['Other'] },
  { name: 'Idle', color: 'transparent', subcategories: ['Other'] }
];

function createShared(strings, intern) {
  const shared = {
    stackTable: { length: 0, prefix: [], frame: [] },
    frameTable: { length: 0, address: [], inlineDepth: [], category: [], subcategory: [],
      func: [], nativeSymbol: [], innerWindowID: [], originalLocation: [], line: [], column: [] },
    funcTable: { length: 0, name: [], isJS: [], relevantForJS: [], resource: [], source: [],
      lineNumber: [], columnNumber: [], originalLocation: [] },
    resourceTable: { length: 0, lib: [], name: [], host: [], type: [] },
    nativeSymbols: { length: 0, address: [], functionSize: [], libIndex: [], name: [] },
    sources: { length: 0, id: [], filename: [], startLine: [], startColumn: [],
      sourceMapURL: [], content: [] },
    sourceLocationTable: { source: [], line: [], column: [], length: 0 },
    funcIndexes: new Map(), frameIndexes: new Map(), stackIndexes: new Map()
  };
  shared.registerSource = (name, content) => {
    const source = shared.sources.length++;
    shared.sources.id.push(null); shared.sources.filename.push(intern(name));
    shared.sources.startLine.push(1); shared.sources.startColumn.push(1);
    shared.sources.sourceMapURL.push(null); shared.sources.content.push(content);
    const resource = shared.resourceTable.length++;
    shared.resourceTable.lib.push(null); shared.resourceTable.name.push(intern(name));
    shared.resourceTable.host.push(null); shared.resourceTable.type.push(5);
    return { source, resource };
  };
  shared.finish = () => ({ stringArray: strings, stackTable: shared.stackTable,
    frameTable: shared.frameTable, funcTable: shared.funcTable,
    resourceTable: shared.resourceTable, nativeSymbols: shared.nativeSymbols,
    sources: shared.sources, sourceLocationTable: shared.sourceLocationTable });
  return shared;
}

function createDshProfile(tree, billing) {
  if (!tree?.length) throw new Error('No DSH session found');
  if (!(billing instanceof Map)) throw new Error('DSH billing data is required');

  const allTimes = tree.flatMap(({ entries }) =>
    entries.map(entry => timestamp(entry))).filter(time => time !== null);
  if (!allTimes.length) throw new Error('No timestamped events found in DSH session');
  const startTime = Math.min(...allTimes);
  const profileEnd = Math.max(...allTimes);

  const strings = [];
  const stringMap = new Map();
  const intern = value => {
    const text = String(value);
    if (!stringMap.has(text)) { stringMap.set(text, strings.length); strings.push(text); }
    return stringMap.get(text);
  };
  const shared = createShared(strings, intern);

  const tracks = [...tree].sort((a, b) => {
    if (!a.session.parentId) return -1;
    if (!b.session.parentId) return 1;
    return String(a.session.started).localeCompare(String(b.session.started));
  });

  const costOf = (response) => {
    if (!response.responseId) return null;
    const row = billing.get(response.responseId);
    return row ? row.cost : null;
  };

  // Cumulative dollars over each track, and the sum of those deltas for the
  // root's session-wide total. A generation the API did not return contributes
  // nothing rather than a fabricated zero.
  const trackData = tracks.map(({ session, entries }) => {
    const track = readTrack(entries);
    const times = entries.map(entry => timestamp(entry)).filter(time => time !== null);
    const trackStart = Math.min(...times);
    const trackEnd = Math.max(...times);
    const responses = track.responses.filter(response => response.at !== null)
      .sort((a, b) => a.at - b.at);

    let cumulative = 0;
    let known = true;
    const costPoints = [{ at: trackStart, cost: 0 }];
    for (const response of responses) {
      const cost = costOf(response);
      if (cost === null) known = false;
      else {
        cumulative += cost;
        costPoints.push({ at: response.at, cost: cumulative });
      }
    }

    return { session, entries, track, trackStart, trackEnd, responses, costPoints,
      costKnown: known, cost: known ? cumulative : null };
  });

  const totalDeltas = [];
  for (const data of trackData) {
    if (!data.costKnown) continue;
    let previous = 0;
    for (const point of data.costPoints) {
      totalDeltas.push({ at: point.at, cost: point.cost - previous });
      previous = point.cost;
    }
  }
  totalDeltas.sort((a, b) => a.at - b.at);
  let totalCost = 0;
  const totalPoints = totalDeltas.map(point => {
    totalCost += point.cost;
    return { at: point.at, cost: totalCost };
  });
  // A session-wide figure is only honest when every track was billed; a
  // partial total would read as cheaper than the session was.
  const totalKnown = trackData.every(data => data.costKnown);

  const threads = trackData.map((data, index) => {
    const { session, entries, track, trackStart, trackEnd, responses, costPoints } = data;
    const markers = { data: [], name: [], startTime: [], endTime: [], phase: [],
      category: [], length: 0 };
    const add = (name, start, end, category, markerData) => {
      markers.name.push(intern(name));
      markers.startTime.push(Math.max(0, start - startTime));
      markers.endTime.push(Math.max(0, end - startTime));
      markers.phase.push(start === end ? 0 : 1);
      markers.category.push(category);
      markers.data.push(markerData);
      markers.length++;
    };
    const addCostGraph = (points, name, type, end) => {
      points.forEach((point, pointIndex) => add(name, point.at,
        points[pointIndex + 1]?.at ?? end, 0, { type, cost: point.cost }));
    };
    const costAt = time => [...costPoints].reverse()
      .find(point => point.at <= time)?.cost || 0;

    const transcript = transcriptEvents(track);
    const document = [`# ${session.title}`, `# ${session.cwd || 'DSH'}`, ''];
    for (const event of transcript) {
      event.line = document.length + 1;
      document.push(`[${new Date(event.at).toISOString()}] ${event.label}`);
      document.push(...event.text.split('\n'), '');
    }
    const slug = session.id.replace(/[^A-Za-z0-9-]/g, '').slice(0, 60) || `session-${index}`;
    const sourceInfo = shared.registerSource(`${slug}.transcript.txt`, document.join('\n'));
    const addStack = (name, category, line, prefix = null) => {
      const funcKey = `${sourceInfo.source}\0${name}\0${line || 0}`;
      let func = shared.funcIndexes.get(funcKey);
      if (func === undefined) {
        func = shared.funcTable.length++;
        shared.funcIndexes.set(funcKey, func);
        shared.funcTable.name.push(intern(name)); shared.funcTable.isJS.push(false);
        shared.funcTable.relevantForJS.push(false); shared.funcTable.resource.push(sourceInfo.resource);
        shared.funcTable.source.push(sourceInfo.source); shared.funcTable.lineNumber.push(null);
        shared.funcTable.columnNumber.push(null); shared.funcTable.originalLocation.push(null);
      }
      const frameKey = `${func}\0${category}\0${line || 0}`;
      let frame = shared.frameIndexes.get(frameKey);
      if (frame === undefined) {
        frame = shared.frameTable.length++;
        shared.frameIndexes.set(frameKey, frame);
        shared.frameTable.address.push(-1); shared.frameTable.inlineDepth.push(0);
        shared.frameTable.category.push(category); shared.frameTable.subcategory.push(0);
        shared.frameTable.func.push(func); shared.frameTable.nativeSymbol.push(null);
        shared.frameTable.innerWindowID.push(0); shared.frameTable.originalLocation.push(null);
        shared.frameTable.line.push(line || null); shared.frameTable.column.push(null);
      }
      const stackKey = `${prefix ?? 'root'}\0${frame}`;
      let stack = shared.stackIndexes.get(stackKey);
      if (stack === undefined) {
        stack = shared.stackTable.length++;
        shared.stackIndexes.set(stackKey, stack);
        shared.stackTable.prefix.push(prefix); shared.stackTable.frame.push(frame);
      }
      return stack;
    };
    const rootStack = addStack('DSH context', 0, null);
    const sampleRows = transcript.map(event => ({
      time: event.at - startTime,
      stack: addStack(event.label, event.category, event.line, rootStack),
      weight: Buffer.byteLength(event.text, 'utf8')
    }));
    const idleStack = addStack('Idle', 6, null);
    for (let sampleIndex = 1; sampleIndex < transcript.length; sampleIndex++) {
      const before = transcript[sampleIndex - 1].at;
      const after = transcript[sampleIndex].at;
      if (after - before > 60000) {
        sampleRows.push({ time: before - startTime + 1, stack: idleStack, weight: 0 });
        sampleRows.push({ time: after - startTime - 1, stack: idleStack, weight: 0 });
      }
    }
    sampleRows.sort((a, b) => a.time - b.time);

    for (const message of track.userMessages) {
      add('User', message.at, message.at, 1, { type: 'Text', text: message.text });
    }
    for (const message of track.systemMessages) {
      add('System', message.at, message.at, 0, { type: 'Text', text: message.text });
    }
    for (const error of track.errors) {
      add('Error', error.at, error.at, 4, { type: 'Intervention', text: error.text });
    }

    // Tool spans: the call is the start, its result the end. A call still
    // waiting for its result is kept as a pending point rather than dropped.
    for (const [callId, call] of track.calls) {
      if (call.at === null) continue;
      const result = track.results.get(callId);
      const end = result?.at ?? call.at;
      const output = result?.text || '';
      add(call.name, call.at, end, result?.failed ? 4 : 3, {
        type: 'ToolCall',
        detail: toolDetail(call.name, call.arguments),
        status: result ? (result.failed ? 'error' : 'complete') : 'pending',
        outputBytes: Buffer.byteLength(output, 'utf8')
      });
    }

    // Turns are DSH's explicit activity spans; the overview keeps a prompt and
    // the dollars spent inside each one.
    const turnStart = new Map(track.turns.map(turn => [turn.turn, turn.start]));
    let previousResponse = trackStart;
    responses.forEach((response, responseIndex) => {
      const next = responses[responseIndex + 1]?.at ?? trackEnd;
      const begin = Math.max(trackStart, turnStart.get(response.turn) ?? previousResponse);
      previousResponse = response.at;
      const usage = response.usage;
      const text = textBlocks(response.blocks.filter(block => block?.type === 'text'));
      const reasoning = textBlocks(response.blocks.filter(block => block?.type === 'reasoning'));
      if (text) add('DSH', response.at, response.at, 1, { type: 'Text', text });
      if (reasoning) {
        add('Reasoning', begin, response.at, 5, { type: 'Reasoning', text: reasoning });
      }
      add(response.model, begin, response.at, 5, {
        type: 'ModelResponse', model: response.model, effort: response.effort,
        inputTokens: usage.inputTokens || 0,
        cachedInputTokens: usage.cacheReadTokens || 0,
        outputTokens: usage.outputTokens || 0,
        reasoningTokens: usage.reasoningTokens || 0
      });
      add('Context Size', response.at, next, 1, { type: 'ContextSize',
        tokens: (usage.inputTokens || 0) + (usage.cacheReadTokens || 0),
        cachedTokens: usage.cacheReadTokens || 0,
        uncachedTokens: usage.inputTokens || 0 });
      add('Output Tokens', begin, response.at, 5, { type: 'OutputTokens',
        tokens: usage.outputTokens || 0,
        reasoningTokens: usage.reasoningTokens || 0 });
      const cost = costOf(response);
      if (cost !== null) {
        add('Response Cost ($)', begin, response.at, 5, { type: 'ResponseCost',
          cost, inputTokens: usage.inputTokens || 0,
          cachedInputTokens: usage.cacheReadTokens || 0,
          outputTokens: usage.outputTokens || 0 });
      }
    });

    for (const turn of track.turns) {
      add('Turn', turn.start, Math.max(turn.start + 1, turn.end), 5, { type: 'Turn',
        status: turn.reason, model: turn.config.model || session.model || 'unknown',
        effort: turn.config.reasoningEffort || 'unknown' });
      const prompt = transcript.find(event =>
        event.label === 'User' && event.at >= turn.start && event.at <= turn.end)?.text || '';
      add('Activity', turn.start, Math.max(turn.start + 1, turn.end), 1, {
        type: 'Activity', prompt: prompt.replace(/\s+/g, ' ').slice(0, 300),
        cost: Math.max(0, costAt(turn.end) - costAt(turn.start))
      });
    }

    // Fallback overview for a session with no explicit turn records: group
    // work separated by less than a minute, as the Codex profile does.
    if (track.turns.length === 0 && transcript.length > 0) {
      const spans = [];
      for (const event of transcript) {
        const previous = spans.at(-1);
        if (!previous || event.at - previous.end > 60000) {
          spans.push({ start: event.at, end: event.at, events: [event] });
        } else {
          previous.end = event.at;
          previous.events.push(event);
        }
      }
      for (const span of spans) {
        const prompt = span.events.find(event => event.label === 'User')?.text || '';
        add('Activity', span.start, Math.max(span.start + 1, span.end), 1, {
          type: 'Activity', prompt: prompt.replace(/\s+/g, ' ').slice(0, 300),
          cost: Math.max(0, costAt(span.end) - costAt(span.start))
        });
      }
    }

    for (const child of tracks.filter(candidate =>
      candidate.session.parentId === session.id)) {
      const childStart = Date.parse(child.session.started) || trackStart;
      const childEnd = Date.parse(child.session.ended) || childStart;
      add('Subagent', childStart, childEnd, 2, { type: 'Subagent',
        title: child.session.title, threadId: child.session.id });
    }

    const usage = session.usage || {};
    add('Usage', trackEnd, trackEnd, 0, { type: 'Usage',
      totalTokens: usage.totalTokens || 0,
      inputTokens: usage.inputTokens || 0,
      cachedTokens: usage.cacheReadTokens || 0,
      outputTokens: usage.outputTokens || 0,
      cost: data.cost });
    if (data.costKnown) addCostGraph(costPoints, 'Thread Cost ($)', 'ThreadCost', trackEnd);
    if (data.costKnown && index === 0 && totalKnown) {
      addCostGraph(totalPoints, 'Total Cost ($)', 'TotalCost', profileEnd);
    }

    return {
      processType: 'default', processName: session.cwd || 'DSH',
      processStartupTime: trackStart - startTime,
      processShutdownTime: (index === 0 ? profileEnd : trackEnd) - startTime,
      registerTime: trackStart - startTime,
      unregisterTime: (index === 0 ? profileEnd : trackEnd) - startTime,
      pausedRanges: [], showMarkersInTimeline: true, name: session.title,
      isMainThread: true, pid: index, tid: index,
      samples: { length: sampleRows.length, stack: sampleRows.map(row => row.stack),
        time: sampleRows.map(row => row.time), weight: sampleRows.map(row => row.weight),
        weightType: 'bytes' }, markers
    };
  });

  return { meta: { processType: 0, product: 'DSH', stackwalk: 0, version: 64,
    preprocessedProfileVersion: 64, symbolicationNotSupported: true, interval: 1,
    startTime, profilingStartTime: 0, markerSchema: markerSchemas(), categories: CATEGORIES,
    usesOnlyOneStackType: true }, libs: [], threads, shared: shared.finish(), counters: [] };
}

module.exports = { createDshProfile };
