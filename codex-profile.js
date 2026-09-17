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
  return textBlocks(item.content) || item.summary_text || textBlocks(item.raw_content) || '';
}

function toolDetail(item) {
  if (Array.isArray(item.command)) return item.command.join(' ');
  if (typeof item.command === 'string') return item.command;
  if (item.server || item.tool) return [item.server, item.tool].filter(Boolean).join('.');
  if (item.action || item.query) return [item.action, item.query].filter(Boolean).join(': ');
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
    { name: 'Usage', tooltipLabel: '{marker.name}', tableLabel: '{marker.name}',
      display: ['marker-table'], fields: [
        { key: 'totalTokens', label: 'Total tokens', format: 'integer' },
        { key: 'inputTokens', label: 'Input tokens', format: 'integer' },
        { key: 'cachedTokens', label: 'Cached input', format: 'integer' },
        { key: 'outputTokens', label: 'Output tokens', format: 'integer' },
        { key: 'credits', label: 'Estimated credits', format: 'decimal' },
        { key: 'cost', label: 'Estimated cost ($)', format: 'decimal' }
      ] },
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
  { name: 'Model', color: 'purple', subcategories: ['Other'] }
];

function emptyShared(strings) {
  return {
    stringArray: strings,
    stackTable: { length: 0, prefix: [], frame: [] },
    frameTable: { length: 0, address: [], inlineDepth: [], category: [], subcategory: [],
      func: [], nativeSymbol: [], innerWindowID: [], originalLocation: [], line: [], column: [] },
    funcTable: { length: 0, name: [], isJS: [], relevantForJS: [], resource: [], source: [],
      lineNumber: [], columnNumber: [], originalLocation: [] },
    resourceTable: { length: 0, lib: [], name: [], host: [], type: [] },
    nativeSymbols: { length: 0, address: [], functionSize: [], libIndex: [], name: [] },
    sources: { length: 0, id: [], filename: [], startLine: [], startColumn: [],
      sourceMapURL: [], content: [] },
    sourceLocationTable: { source: [], line: [], column: [], length: 0 }
  };
}

function createCodexProfile(tree, billing = {}) {
  if (!tree?.length) throw new Error('No Codex thread found');
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

  const tracks = [...tree].sort((a, b) => {
    if (!a.session.parentId) return -1;
    if (!b.session.parentId) return 1;
    return String(a.session.started).localeCompare(String(b.session.started));
  });

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

    const contextByTurn = new Map(entries.filter(e => e.type === 'turn_context')
      .map(e => [e.payload?.turn_id, e.payload || {}]));
    const turnStarts = new Map();
    for (const entry of entries) {
      const at = timestamp(entry.timestamp);
      if (at === null || entry.type !== 'event_msg') continue;
      const payload = entry.payload || {};
      if (payload.type === 'task_started') turnStarts.set(payload.turn_id, at);
      if (payload.type === 'task_complete' || payload.type === 'turn_aborted') {
        const begin = timestamp(payload.started_at ? payload.started_at * 1000 : null) ??
          turnStarts.get(payload.turn_id) ?? at;
        const context = contextByTurn.get(payload.turn_id) || {};
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
      }
    }

    for (const child of tracks.filter(track => track.session.parentId === session.id)) {
      const childStart = timestamp(child.session.started) ?? trackStart;
      const childEnd = timestamp(child.session.ended) ?? childStart;
      add('Subagent', childStart, childEnd, 2, { type: 'Subagent',
        title: child.session.title, threadId: child.session.id });
    }

    const usage = usageOf(entries);
    add('Usage', trackEnd, trackEnd, 0, { type: 'Usage',
      totalTokens: usage.total_tokens || 0, inputTokens: usage.input_tokens || 0,
      cachedTokens: usage.cached_input_tokens || 0, outputTokens: usage.output_tokens || 0,
      credits: index === 0 ? billing.credits : undefined,
      cost: index === 0 ? billing.cost : undefined });

    return {
      processType: 'default', processName: session.cwd || 'Codex',
      processStartupTime: trackStart - startTime, processShutdownTime: trackEnd - startTime,
      registerTime: trackStart - startTime, unregisterTime: trackEnd - startTime,
      pausedRanges: [], showMarkersInTimeline: true, name: session.title,
      isMainThread: true, pid: index, tid: index,
      samples: { length: 0, stack: [], time: [], weight: [], weightType: 'samples' }, markers
    };
  });

  return { meta: { processType: 0, product: 'Codex', stackwalk: 0, version: 64,
    preprocessedProfileVersion: 64, symbolicationNotSupported: true, interval: 1,
    startTime, profilingStartTime: 0, markerSchema: markerSchemas(), categories: CATEGORIES,
    usesOnlyOneStackType: true }, libs: [], threads, shared: emptyShared(strings), counters: [] };
}

module.exports = { createCodexProfile };
