// Turn Codex rollout JSONL into a processed Firefox Profiler profile. Modern
// rollouts record completed items with exact start/end times; older point
// events are kept as text markers so their history remains inspectable too.

function timestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const time = typeof value === 'number' ? value : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function durationMs(duration) {
  if (!duration || typeof duration !== 'object') return 0;
  return (duration.secs || 0) * 1000 + (duration.nanos || 0) / 1000000;
}

function textBlocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => block?.text || block?.input_text || block?.output_text || '')
    .filter(Boolean).join('\n');
}

function itemText(item) {
  return textBlocks(item.content) || textBlocks(item.summary_text) ||
    textBlocks(item.raw_content) || '';
}

function toolDetail(item) {
  if (Array.isArray(item.command)) return item.command.join(' ');
  if (typeof item.command === 'string') return item.command;
  if (item.server || item.tool) return [item.server, item.tool].filter(Boolean).join('.');
  if (item.action || item.query) return [item.action, item.query].filter(Boolean).join(': ');
  if (item.changes) return JSON.stringify(item.changes);
  return '';
}

function usageOf(entries) {
  let usage = null;
  for (const entry of entries) {
    if (entry.type === 'token_usage_record' && entry.payload?.thread_token_usage) {
      usage = entry.payload.thread_token_usage;
    } else if (entry.type === 'event_msg' && entry.payload?.type === 'token_count' &&
               entry.payload.info?.total_token_usage) {
      usage = entry.payload.info.total_token_usage;
    }
  }
  return usage || {};
}

function usageSnapshots(entries) {
  const snapshots = [];
  for (const entry of entries) {
    let usage;
    if (entry.type === 'token_usage_record') usage = entry.payload?.thread_token_usage;
    if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
      usage = entry.payload.info?.total_token_usage;
    }
    const at = timestamp(entry.timestamp);
    if (usage && at !== null) snapshots.push({ at, tokens: usage.total_tokens || 0 });
  }
  return snapshots;
}

function responseUsage(entries) {
  const records = [];
  let lastLegacyTotal = null;
  for (const entry of entries) {
    const at = timestamp(entry.timestamp);
    if (at === null) continue;
    if (entry.type === 'token_usage_record' && entry.payload?.usage) {
      records.push({ at, turnId: entry.payload.turn_id,
        responseId: entry.payload.response_id, usage: entry.payload.usage });
    } else if (entry.type === 'event_msg' && entry.payload?.type === 'token_count' &&
               entry.payload.info?.last_token_usage) {
      const total = entry.payload.info.total_token_usage?.total_tokens;
      // Old logs repeat token_count after tool events. A changed cumulative
      // total identifies the actual model response that last_token_usage names.
      if (total !== lastLegacyTotal) {
        records.push({ at, turnId: null, responseId: null,
          usage: entry.payload.info.last_token_usage });
        lastLegacyTotal = total;
      }
    }
  }
  return records;
}

function transcriptEvents(entries) {
  const events = [];
  for (const entry of entries) {
    const at = timestamp(entry.timestamp);
    if (at === null || entry.type !== 'event_msg') continue;
    const payload = entry.payload || {};
    if (payload.type === 'item_completed' && payload.item) {
      const item = payload.item;
      const end = timestamp(payload.completed_at_ms) ?? at;
      let label = item.type;
      let text = itemText(item);
      let category = 5;
      if (item.type === 'UserMessage') { label = 'User'; category = 1; }
      if (item.type === 'AgentMessage') { label = 'Codex'; category = 1; }
      if (['CommandExecution', 'McpToolCall', 'FileChange', 'WebSearch', 'Extension']
        .includes(item.type)) {
        category = 3;
        const output = item.stdout || item.stderr || item.aggregated_output || item.formatted_output || '';
        text = [toolDetail(item), typeof output === 'string' ? output : JSON.stringify(output)]
          .filter(Boolean).join('\n\n');
      }
      if (item.type === 'ContextCompaction') text = 'Context window compacted.';
      if (item.type === 'SubAgentActivity') {
        label = 'Subagent'; category = 2;
        text = [item.kind, item.agent_path, item.agent_thread_id].filter(Boolean).join(' — ');
      }
      if (text) events.push({ at: end, label, text, category });
    } else if (payload.type === 'user_message' || payload.type === 'agent_message') {
      events.push({ at, label: payload.type === 'user_message' ? 'User' : 'Codex',
        text: String(payload.message || ''), category: 1 });
    } else if (payload.type === 'agent_reasoning') {
      events.push({ at, label: 'Reasoning', text: String(payload.text || ''), category: 5 });
    } else if (['exec_command_end', 'patch_apply_end', 'web_search_end', 'mcp_tool_call_end']
      .includes(payload.type)) {
      const detail = payload.command || payload.query || payload.invocation ||
        (payload.changes ? JSON.stringify(payload.changes) : '');
      const output = payload.stdout || payload.stderr || payload.aggregated_output ||
        payload.formatted_output || payload.result || '';
      events.push({ at, label: payload.type.replace(/_end$/, ''), category: 3,
        text: [typeof detail === 'string' ? detail : JSON.stringify(detail),
          typeof output === 'string' ? output : JSON.stringify(output)].filter(Boolean).join('\n\n') });
    } else if (payload.type === 'context_compacted') {
      events.push({ at, label: 'Context compaction', category: 5,
        text: 'Context window compacted.' });
    } else if (payload.type === 'error' || payload.type === 'thread_rolled_back') {
      events.push({ at, label: 'Intervention', category: 4,
        text: String(payload.message || payload.reason || payload.type) });
    }
  }
  return events.sort((a, b) => a.at - b.at);
}

function estimatedCostPoints(entries, estimate, trackStart, trackEnd) {
  const dollars = estimate.estimated_usage_usd_micros / 1000000;
  const credits = estimate.estimated_usage_credits_micros / 1000000;
  const snapshots = usageSnapshots(entries);
  const finalTokens = snapshots.at(-1)?.tokens || usageOf(entries).total_tokens || 0;
  const points = [{ at: trackStart, cost: 0, credits: 0 }];

  for (const snapshot of snapshots) {
    const share = finalTokens > 0 ? Math.min(1, snapshot.tokens / finalTokens) : 0;
    const point = { at: snapshot.at, cost: dollars * share, credits: credits * share };
    if (points.at(-1).at === point.at) points[points.length - 1] = point;
    else points.push(point);
  }

  // The endpoint is authoritative even if a final local usage record is
  // missing or precedes the last event in the rollout.
  const final = { at: trackEnd, cost: dollars, credits };
  if (points.at(-1).at === trackEnd) points[points.length - 1] = final;
  else points.push(final);
  return points;
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
        { key: 'cost', label: 'Estimated cost ($)', format: 'decimal' }
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
        { key: 'credits', label: 'Estimated credits', format: 'decimal' },
        { key: 'cost', label: 'Estimated cost ($)', format: 'decimal' }
      ] },
    { name: 'EstimatedThreadCost', tooltipLabel: '{marker.name}',
      tableLabel: '{marker.name}: ${marker.data.cost}', display: [], fields: [
        { key: 'cost', label: 'Thread cost ($)', format: 'decimal' },
        { key: 'credits', label: 'Thread credits', format: 'decimal' }
      ], graphs: [{ key: 'cost', color: 'blue', type: 'line' }] },
    { name: 'EstimatedResponseCost', tooltipLabel: '{marker.name}',
      tableLabel: '{marker.name}: ${marker.data.cost}', display: [], fields: [
        { key: 'cost', label: 'Response cost ($)', format: 'decimal' },
        { key: 'inputTokens', label: 'Context tokens', format: 'integer' },
        { key: 'cachedInputTokens', label: 'Cached input', format: 'integer' },
        { key: 'outputTokens', label: 'Output tokens', format: 'integer' }
      ], graphs: [{ key: 'cost', color: 'orange', type: 'bar' }] },
    { name: 'EstimatedTotalCost', tooltipLabel: '{marker.name}',
      tableLabel: '{marker.name}: ${marker.data.cost}', display: [], fields: [
        { key: 'cost', label: 'Total cost ($)', format: 'decimal' },
        { key: 'credits', label: 'Total credits', format: 'decimal' }
      ], graphs: [{ key: 'cost', color: 'purple', type: 'line' }] },
    { name: 'Subagent', tooltipLabel: '{marker.data.title}', tableLabel: '{marker.data.title}',
      chartLabel: '{marker.name}', display: ['marker-chart', 'marker-table'], fields: [
        { key: 'title', label: 'Thread', format: 'string' },
        { key: 'threadId', label: 'Thread id', format: 'string' }
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

function createCodexProfile(tree, billing) {
  if (!tree?.length) throw new Error('No Codex thread found');
  if (!(billing instanceof Map)) throw new Error('Codex billing estimates are required');
  const allTimes = tree.flatMap(({ entries }) => entries.map(entry => timestamp(entry.timestamp)))
    .filter(time => time !== null);
  if (!allTimes.length) throw new Error('No timestamped events found in Codex rollout');
  const startTime = Math.min(...allTimes);
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

  const costs = new Map();
  const totalDeltas = [];
  for (const track of tracks) {
    const estimate = billing.get(track.session.id);
    if (!estimate) throw new Error(`Missing dollar estimate for Codex thread ${track.session.id}`);
    const times = track.entries.map(entry => timestamp(entry.timestamp)).filter(time => time !== null);
    const points = estimatedCostPoints(track.entries, estimate, Math.min(...times), Math.max(...times));
    costs.set(track.session.id, points);
    let previousCost = 0;
    let previousCredits = 0;
    for (const point of points) {
      totalDeltas.push({ at: point.at, cost: point.cost - previousCost,
        credits: point.credits - previousCredits });
      previousCost = point.cost;
      previousCredits = point.credits;
    }
  }
  totalDeltas.sort((a, b) => a.at - b.at);
  let totalCost = 0;
  let totalCredits = 0;
  const totalPoints = totalDeltas.map(point => {
    totalCost += point.cost;
    totalCredits += point.credits;
    return { at: point.at, cost: totalCost, credits: totalCredits };
  });
  const profileEnd = Math.max(...allTimes);

  const threads = tracks.map(({ session, entries }, index) => {
    const times = entries.map(entry => timestamp(entry.timestamp)).filter(time => time !== null);
    const trackStart = Math.min(...times);
    const trackEnd = Math.max(...times);
    const markers = { data: [], name: [], startTime: [], endTime: [], phase: [], category: [], length: 0 };
    const add = (name, start, end, category, data) => {
      markers.name.push(intern(name));
      markers.startTime.push(Math.max(0, start - startTime));
      markers.endTime.push(Math.max(0, end - startTime));
      markers.phase.push(start === end ? 0 : 1);
      markers.category.push(category);
      markers.data.push(data);
      markers.length++;
    };
    const addCostGraph = (points, name, type, end) => {
      points.forEach((point, pointIndex) => add(name, point.at,
        points[pointIndex + 1]?.at ?? end, 0,
        { type, cost: point.cost, credits: point.credits }));
    };

    // Embed a readable transcript and put every logged contribution on an
    // allocation-like sample stack. This gives Codex the same useful call-tree,
    // flame-graph and source-view surfaces as a Claude profile.
    const transcript = transcriptEvents(entries);
    const document = [`# ${session.title}`, `# ${session.cwd || 'Codex'}`, ''];
    for (const event of transcript) {
      event.line = document.length + 1;
      document.push(`[${new Date(event.at).toISOString()}] ${event.label}`);
      document.push(...event.text.split('\n'), '');
    }
    const slug = session.id.replace(/[^A-Za-z0-9-]/g, '').slice(0, 60) || `thread-${index}`;
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
    const rootStack = addStack('Codex context', 0, null);
    const sampleRows = transcript.map(event => ({
      time: event.at - startTime,
      stack: addStack(event.label, event.category, event.line, rootStack),
      weight: Buffer.byteLength(event.text, 'utf8')
    }));
    const idleStack = addStack('Idle', 6, null);
    const IDLE_GAP = 60000;
    for (let sampleIndex = 1; sampleIndex < transcript.length; sampleIndex++) {
      const before = transcript[sampleIndex - 1].at;
      const after = transcript[sampleIndex].at;
      if (after - before > IDLE_GAP) {
        sampleRows.push({ time: before - startTime + 1, stack: idleStack, weight: 0 });
        sampleRows.push({ time: after - startTime - 1, stack: idleStack, weight: 0 });
      }
    }
    sampleRows.sort((a, b) => a.time - b.time);

    const contextByTurn = new Map(entries.filter(e => e.type === 'turn_context')
      .map(e => [e.payload?.turn_id, e.payload || {}]));
    const turnStarts = new Map();
    const explicitActivity = [];
    for (const entry of entries) {
      const at = timestamp(entry.timestamp);
      if (at === null || entry.type !== 'event_msg') continue;
      const payload = entry.payload || {};
      if (payload.type === 'task_started') turnStarts.set(payload.turn_id, at);
      if (payload.type === 'task_complete' || payload.type === 'turn_aborted') {
        const begin = timestamp(payload.started_at ? payload.started_at * 1000 : null) ??
          turnStarts.get(payload.turn_id) ?? at;
        const context = contextByTurn.get(payload.turn_id) || {};
        explicitActivity.push({ start: begin, end: at });
        add('Turn', begin, at, 5, { type: 'Turn',
          status: payload.type === 'task_complete' ? 'complete' : (payload.reason || 'aborted'),
          model: context.model || session.model || 'unknown', effort: context.effort || 'unknown' });
      }

      if (payload.type === 'item_completed' && payload.item) {
        const item = payload.item;
        const end = timestamp(payload.completed_at_ms) ?? at;
        const begin = timestamp(payload.started_at_ms) ?? Math.max(trackStart, end - durationMs(item.duration));
        if (item.type === 'UserMessage' || item.type === 'AgentMessage') {
          const text = itemText(item);
          if (text) add(item.type === 'UserMessage' ? 'User' : 'Codex', end, end, 1,
            { type: 'Text', text });
        } else if (item.type === 'Reasoning') {
          add('Reasoning', begin, end, 5, { type: 'Reasoning', text: itemText(item) });
        } else if (['CommandExecution', 'McpToolCall', 'FileChange', 'WebSearch', 'Extension']
          .includes(item.type)) {
          const output = item.stdout || item.stderr || item.aggregated_output || item.formatted_output || '';
          add(item.type, begin, end, item.status && !['completed', 'success'].includes(item.status) ? 4 : 3,
            { type: 'ToolCall', detail: toolDetail(item).slice(0, 500), status: item.status || 'complete',
              outputBytes: Buffer.byteLength(typeof output === 'string' ? output : JSON.stringify(output)) });
        } else if (item.type === 'ContextCompaction') {
          add('Context compaction', end, end, 5,
            { type: 'Text', text: 'Codex compacted the model context window.' });
        } else if (item.type === 'SubAgentActivity') {
          add('Subagent activity', end, end, 2, { type: 'Text',
            text: [item.kind, item.agent_path, item.agent_thread_id].filter(Boolean).join(' — ') });
        }
      } else if (payload.type === 'user_message' || payload.type === 'agent_message') {
        add(payload.type === 'user_message' ? 'User' : 'Codex', at, at, 1,
          { type: 'Text', text: String(payload.message || '') });
      } else if (payload.type === 'agent_reasoning') {
        add('Reasoning', at, at, 5,
          { type: 'Reasoning', text: String(payload.text || '') });
      } else if (['exec_command_end', 'patch_apply_end', 'web_search_end', 'mcp_tool_call_end']
        .includes(payload.type)) {
        const elapsed = typeof payload.duration === 'number'
          ? payload.duration * 1000 : durationMs(payload.duration);
        const detail = payload.command || payload.query || payload.invocation ||
          (payload.changes ? JSON.stringify(payload.changes) : '');
        const output = payload.stdout || payload.stderr || payload.aggregated_output ||
          payload.formatted_output || payload.result || '';
        const failed = payload.success === false || payload.status === 'failed' ||
          (Number.isInteger(payload.exit_code) && payload.exit_code !== 0);
        add(payload.type.replace(/_end$/, ''), Math.max(trackStart, at - elapsed), at,
          failed ? 4 : 3, { type: 'ToolCall',
            detail: (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500),
            status: failed ? 'error' : (payload.status || 'complete'),
            outputBytes: Buffer.byteLength(typeof output === 'string' ? output : JSON.stringify(output)) });
      } else if (payload.type === 'context_compacted') {
        add('Context compaction', at, at, 5,
          { type: 'Text', text: 'Codex compacted the model context window.' });
      } else if (payload.type === 'error' || payload.type === 'thread_rolled_back') {
        add(payload.type === 'error' ? 'Error' : 'Thread rolled back', at, at, 4,
          { type: 'Intervention', text: String(payload.message || payload.reason || payload.type) });
      }
    }

    for (const child of tracks.filter(track => track.session.parentId === session.id)) {
      const childStart = timestamp(child.session.started) ?? trackStart;
      const childEnd = timestamp(child.session.ended) ?? childStart;
      add('Subagent', childStart, childEnd, 2, { type: 'Subagent',
        title: child.session.title, threadId: child.session.id });
    }

    const responses = responseUsage(entries);
    const threadCostPoints = costs.get(session.id);
    const costAt = time => [...threadCostPoints].reverse()
      .find(point => point.at <= time)?.cost || 0;
    const contexts = entries.filter(entry => entry.type === 'turn_context')
      .map(entry => ({ at: timestamp(entry.timestamp), payload: entry.payload || {} }))
      .filter(context => context.at !== null);
    responses.forEach((response, responseIndex) => {
      const next = responses[responseIndex + 1]?.at ?? trackEnd;
      const previous = responses[responseIndex - 1]?.at ??
        turnStarts.get(response.turnId) ?? trackStart;
      const produced = transcript.filter(event =>
        event.at > previous && event.at <= response.at &&
        (event.category === 5 || event.label === 'Codex'));
      const responseStart = produced.length ? produced[0].at : previous;
      const context = contextByTurn.get(response.turnId) ||
        [...contexts].reverse().find(candidate => candidate.at <= response.at)?.payload || {};
      const usage = response.usage;
      add(context.model || session.model || 'Model', responseStart, response.at, 5, {
        type: 'ModelResponse', model: context.model || session.model || 'unknown',
        effort: context.effort || 'unknown', inputTokens: usage.input_tokens || 0,
        cachedInputTokens: usage.cached_input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        reasoningTokens: usage.reasoning_output_tokens || 0
      });
      add('Context Size', response.at, next, 1, { type: 'ContextSize',
        tokens: usage.input_tokens || 0,
        cachedTokens: usage.cached_input_tokens || 0,
        uncachedTokens: Math.max(0, (usage.input_tokens || 0) - (usage.cached_input_tokens || 0)) });
      add('Output Tokens', responseStart, response.at, 5, { type: 'OutputTokens',
        tokens: usage.output_tokens || 0,
        reasoningTokens: usage.reasoning_output_tokens || 0 });
      add('Estimated Response Cost ($)', responseStart, response.at, 5, {
        type: 'EstimatedResponseCost',
        cost: Math.max(0, costAt(response.at) - costAt(previous)),
        inputTokens: usage.input_tokens || 0,
        cachedInputTokens: usage.cached_input_tokens || 0,
        outputTokens: usage.output_tokens || 0
      });
    });

    // Older Codex rollouts predate explicit task spans. Group work separated
    // by less than a minute into activity spans so their overview remains as
    // useful as modern Turn markers and Claude's Activity markers.
    if (transcript.length > 0) {
      const spans = explicitActivity;
      if (spans.length === 0) {
        for (const event of transcript) {
          const previous = spans.at(-1);
          if (!previous || event.at - previous.end > 60000) {
            spans.push({ start: event.at, end: event.at, events: [event] });
          } else {
            previous.end = event.at;
            previous.events.push(event);
          }
        }
      }
      for (const span of spans) {
        const prompt = (span.events || transcript.filter(event =>
          event.at >= span.start && event.at <= span.end))
          .find(event => event.label === 'User')?.text || '';
        add('Activity', span.start, Math.max(span.start + 1, span.end), 1, {
          type: 'Activity', prompt: prompt.replace(/\s+/g, ' ').slice(0, 300),
          cost: Math.max(0, costAt(span.end) - costAt(span.start))
        });
      }
    }

    const estimate = billing.get(session.id);
    const usage = usageOf(entries);
    add('Usage', trackEnd, trackEnd, 0, { type: 'Usage',
      totalTokens: usage.total_tokens || 0, inputTokens: usage.input_tokens || 0,
      cachedTokens: usage.cached_input_tokens || 0, outputTokens: usage.output_tokens || 0,
      credits: estimate.estimated_usage_credits_micros / 1000000,
      cost: estimate.estimated_usage_usd_micros / 1000000 });
    addCostGraph(costs.get(session.id), 'Estimated Thread Cost ($)',
      'EstimatedThreadCost', trackEnd);
    if (index === 0) {
      addCostGraph(totalPoints, 'Estimated Total Cost ($)', 'EstimatedTotalCost', profileEnd);
    }

    return {
      processType: 'default', processName: session.cwd || 'Codex',
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

  return { meta: { processType: 0, product: 'Codex', stackwalk: 0, version: 64,
    preprocessedProfileVersion: 64, symbolicationNotSupported: true, interval: 1,
    startTime, profilingStartTime: 0, markerSchema: markerSchemas(), categories: CATEGORIES,
    usesOnlyOneStackType: true }, libs: [], threads, shared: shared.finish(), counters: [] };
}

module.exports = { createCodexProfile };
