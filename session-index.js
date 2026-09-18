// The shared session picker page. Backends normalize their on-disk sessions
// into one row shape; this module only formats and renders those rows.

const {
  findSessionFiles, listSessions, summarizeSession, projectLabel
} = require('./claude-backend.js');

// The eight categorical hues, in the fixed order the palette defines. A project
// takes its slot from the sorted list of projects rather than from the order
// the rows happen to be in, so that re-sorting the table never repaints a row:
// colour follows the project, not its rank. Past the eighth project the slots
// repeat, which costs nothing — the hue is a grouping hint beside a label that
// already names the project.
function assignProjectColors(sessions) {
  const projects = [...new Set(sessions.map(session => session.cwd))].sort();
  const slots = new Map(projects.map((cwd, i) => [cwd, i % 8]));

  for (const session of sessions) {
    session.colorSlot = slots.get(session.cwd);
  }

  return slots;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function formatCost(cost) {
  if (!cost) return '—';
  return cost < 0.01 ? '<$0.01' : `$${cost.toFixed(2)}`;
}

function formatTotalCost(total) {
  if (!total.costComplete && total.cost === 0) return '—';
  return `$${total.cost.toFixed(2)}`;
}

function formatTokens(tokens) {
  const value = Math.round(tokens || 0);
  if (Math.abs(value) < 10000) return value.toLocaleString('en-US');
  return new Intl.NumberFormat('en-US', {
    notation: 'compact', maximumFractionDigits: 1
  }).format(value);
}

function tokenCell(tokens, { estimated = false, detail = '' } = {}) {
  const value = Math.round(tokens || 0);
  const formatted = formatTokens(value);
  const exact = value.toLocaleString('en-US');
  const title = [formatted === exact ? '' : `${exact} tokens`, detail]
    .filter(Boolean).join('; ');
  return `<div role="cell"${title ? ` title="${title}"` : ''}>${estimated ? '≈' : ''}${formatted}</div>`;
}

function creditCell(total) {
  if (!total.creditsAvailable) return '<div role="cell" title="Not applicable">—</div>';
  const exact = total.credits.toLocaleString('en-US', { maximumFractionDigits: 6 });
  const formatted = Math.abs(total.credits) < 10000
    ? total.credits.toLocaleString('en-US', { maximumFractionDigits: 2 })
    : new Intl.NumberFormat('en-US', {
      notation: 'compact', maximumFractionDigits: 1
    }).format(total.credits);
  return `<div role="cell" title="${exact} Enterprise credits">${formatted}</div>`;
}

function normalizedUsage(provider, usage = {}) {
  if (provider === 'codex') {
    const cacheRead = usage.cached_input_tokens || 0;
    const fallbackNewInput = Math.max(0, (usage.input_tokens || 0) - cacheRead);
    const hasApiNewInput = Number.isFinite(usage.net_new_input_tokens);
    const newInput = hasApiNewInput ? usage.net_new_input_tokens : fallbackNewInput;
    const reportedCacheWrite = usage.cache_write_input_tokens > 0
      ? usage.cache_write_input_tokens : null;
    return {
      // Codex reports cached input as a subset of input_tokens.
      input: usage.input_tokens || 0,
      output: usage.output_tokens || 0,
      newInput,
      // The Enterprise endpoint calls this net-new input: the authoritative
      // server-side measure of input newly written rather than read from cache.
      cacheWrite: reportedCacheWrite ?? newInput,
      cacheWriteEstimated: reportedCacheWrite === null && !hasApiNewInput,
      cacheWriteFromApi: reportedCacheWrite === null && hasApiNewInput,
      cacheRead
    };
  }

  const creation = usage.cache_creation;
  const cacheWrite = usage.cache_creation_input_tokens ||
    (creation?.ephemeral_5m_input_tokens || 0) +
    (creation?.ephemeral_1h_input_tokens || 0);
  const cacheRead = usage.cache_read_input_tokens || 0;
  return {
    // Claude reports these as three disjoint input buckets. Present their sum
    // as Input, with the cache columns showing how that total breaks down.
    input: (usage.input_tokens || 0) + cacheWrite + cacheRead,
    output: usage.output_tokens || 0,
    newInput: (usage.input_tokens || 0) + cacheWrite,
    cacheWrite,
    cacheRead
  };
}

function emptyTotals(label, provider = null) {
  return { label, provider, cost: 0, costComplete: true,
    credits: 0, creditsAvailable: false, input: 0, output: 0, newInput: 0,
    cacheWrite: 0, cacheWriteAvailable: false, cacheWriteEstimated: false,
    cacheWriteFromApi: false, cacheRead: 0,
    pricedTokens: 0, unpricedTokens: 0 };
}

function addTotals(total, usage, cost = 0, credits = null) {
  const tokens = (usage.input || 0) + (usage.output || 0);
  if (cost === null || cost === undefined) {
    total.costComplete = false;
    total.unpricedTokens += tokens;
  } else {
    total.cost += cost;
    total.pricedTokens += tokens;
  }
  if (Number.isFinite(credits)) {
    total.credits += credits;
    total.creditsAvailable = true;
  }
  for (const key of ['input', 'output', 'newInput', 'cacheRead']) {
    total[key] += usage[key] || 0;
  }
  if (usage.cacheWrite !== null && usage.cacheWrite !== undefined) {
    total.cacheWrite += usage.cacheWrite;
    total.cacheWriteAvailable = true;
    total.cacheWriteEstimated ||= usage.cacheWriteEstimated === true;
    total.cacheWriteFromApi ||= usage.cacheWriteFromApi === true;
  }
}

function cachedPercent(total) {
  return total.input > 0 ? `${(100 * total.cacheRead / total.input).toFixed(1)}%` : '—';
}

function effectiveRateCell(total) {
  const tokens = total.pricedTokens;
  if (tokens <= 0) {
    const reason = total.unpricedTokens > 0 ? 'No billing data for these tokens' : 'No token usage';
    return `<div role="cell" title="${reason}">—</div>`;
  }

  const rate = total.cost * 1000000 / tokens;
  const formatted = rate > 0 && rate < 0.01
    ? '<$0.01/M'
    : rate >= 1000
      ? `$${new Intl.NumberFormat('en-US', {
        notation: 'compact', maximumFractionDigits: 1
      }).format(rate)}/M`
      : `$${rate.toFixed(2)}/M`;
  const partial = total.unpricedTokens > 0;
  const detail = partial
    ? `$${total.cost.toFixed(4)} over ${tokens.toLocaleString('en-US')} priced tokens; ` +
      `excludes ${total.unpricedTokens.toLocaleString('en-US')} tokens without billing data`
    : `$${total.cost.toFixed(4)} over ${tokens.toLocaleString('en-US')} total tokens`;
  return `<div role="cell" title="${detail}">${formatted}</div>`;
}

const USAGE_COLUMNS = [
  { label: 'Usage' },
  { label: 'Est. cost', title: 'Claude price calculation or Codex Enterprise API dollar estimate' },
  { label: 'Credits', title: 'Enterprise credits reported by the Codex usage API' },
  { label: 'Input tokens' },
  { label: 'Output tokens' },
  { label: 'New input', title: 'Input not served from cache; reported directly by the Codex Enterprise API when available' },
  { label: 'Cache write', title: 'Claude cache creation or Codex Enterprise API net-new input; fallback values marked ≈' },
  { label: 'Cache read' },
  { label: 'Cached', title: 'Cache reads as a share of all input-side tokens' },
  { label: 'Est. $/M', title: 'Estimated cost divided by input plus output tokens, normalized to one million tokens' }
];

function usageHeader(target) {
  return `<div class="usage-row usage-head" role="row">
    ${USAGE_COLUMNS.map((column, index) =>
      `<div role="columnheader" tabindex="0" data-usage-column="${index}" ` +
      `data-usage-target="${target}"${column.title ? ` title="${escapeHtml(column.title)}"` : ''}>` +
      `${escapeHtml(column.label)}</div>`).join('')}
  </div>`;
}

function usageSortAttributes(total) {
  const effectiveRate = total.pricedTokens > 0
    ? total.cost * 1000000 / total.pricedTokens : '';
  const keys = [
    total.label.toLowerCase(),
    total.costComplete || total.cost > 0 ? total.cost : '',
    total.creditsAvailable ? total.credits : '',
    total.input,
    total.output,
    total.newInput,
    total.cacheWriteAvailable ? total.cacheWrite : '',
    total.cacheRead,
    total.input > 0 ? total.cacheRead / total.input : '',
    effectiveRate
  ];
  return keys.map((key, index) =>
    `data-usage-sort${index}="${escapeHtml(key)}"`).join(' ');
}

function usageRow(total, className = '') {
  const showProvider = total.provider && className.includes('usage-model');
  return `<div class="usage-row ${className}" role="row" ${usageSortAttributes(total)}>
    <div class="usage-label" role="rowheader">${escapeHtml(total.label)}${showProvider
      ? ` <span class="provider ${total.provider}">${escapeHtml(total.provider)}</span>` : ''}</div>
    <div role="cell"${total.costComplete ? '' : ' title="Some costs are unavailable"'}>${formatTotalCost(total)}</div>
    ${creditCell(total)}
    ${tokenCell(total.input)}
    ${tokenCell(total.output)}
    ${tokenCell(total.newInput)}
    ${total.cacheWriteAvailable
      ? tokenCell(total.cacheWrite, {
        estimated: total.cacheWriteEstimated,
        detail: total.cacheWriteEstimated ? 'includes input-minus-cache-read estimates'
          : total.cacheWriteFromApi ? 'includes Codex Enterprise API net-new input' : ''
      })
      : '<div role="cell" title="Not reported by this provider">—</div>'}
    ${tokenCell(total.cacheRead)}
    <div role="cell">${cachedPercent(total)}</div>
    ${effectiveRateCell(total)}
  </div>`;
}

function usageSummary(sessions) {
  const total = emptyTotals('Total');
  const providers = {
    claude: emptyTotals('Claude', 'claude'),
    codex: emptyTotals('Codex', 'codex')
  };
  const models = new Map();

  for (const session of sessions) {
    const provider = session.provider === 'codex' ? 'codex' : 'claude';
    const usage = normalizedUsage(provider, session.billingUsage || session.usage);
    const credits = provider === 'codex' ? session.credits : null;
    addTotals(total, usage, session.cost, credits);
    addTotals(providers[provider], usage, session.cost, credits);

    const entries = Object.entries(session.billingModels || session.models || {});
    const modelEntries = entries.length ? entries : [[session.model || 'Unknown model',
      session.billingUsage || session.usage]];
    const weights = modelEntries.map(([, modelUsage]) => {
      const normalized = normalizedUsage(provider, modelUsage);
      return normalized.input + normalized.output;
    });
    const weightTotal = weights.reduce((sum, value) => sum + value, 0);

    modelEntries.forEach(([model, modelUsage], index) => {
      // A model row is a cost comparison. If this session has no billing data,
      // exclude both its cost and tokens so the row keeps one coherent
      // denominator. Provider and overall rows above still retain all usage.
      if (!Number.isFinite(modelUsage?.cost) &&
          (session.cost === null || session.cost === undefined)) return;
      const key = `${provider}:${model}`;
      if (!models.has(key)) models.set(key, emptyTotals(model, provider));
      const share = weightTotal > 0 ? weights[index] / weightTotal : 1 / modelEntries.length;
      const modelCost = Number.isFinite(modelUsage?.cost)
        ? modelUsage.cost
        : session.cost === null || session.cost === undefined ? null : session.cost * share;
      addTotals(models.get(key), normalizedUsage(provider, modelUsage), modelCost,
        provider === 'codex' ? modelUsage?.credits : null);
    });
  }

  return { total, providers: Object.values(providers), models: [...models.values()]
    .filter(model => model.input + model.output > 0 || model.cost > 0)
    .sort((a, b) => b.cost - a.cost || a.label.localeCompare(b.label)) };
}

function formatDuration(ms) {
  if (!(ms > 0)) return '—';

  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

// Dates are rendered in the browser rather than here: the server knows its own
// locale and timezone, and toLocaleString on the client is what makes the
// column read as local time.
// What a session cost, in bands, so that the expensive ones are visible without
// reading the figures. The thresholds are round numbers rather than quantiles:
// the question a row answers is "was this session expensive", which does not
// depend on what else happens to be in the list.
//
// Four bands rather than five: the palette's warning yellow and serious orange
// measure ΔE 13.6 apart, below the floor at which they can be told apart even
// with full colour vision, so the two middle tiers would have looked the same.
const COST_BANDS = [
  { over: 200, band: 'critical' },
  { over: 50, band: 'warning' },
  { over: 10, band: 'good' },
  { over: 0, band: 'cheap' }
];

function costBand(cost) {
  return (COST_BANDS.find(({ over }) => cost > over) || { band: 'cheap' }).band;
}

// Cost spans four orders of magnitude across a set of sessions, so the bar is
// scaled by square root rather than linearly: on a linear scale the one $989
// session flattens every other row to an invisible sliver.
function costBar(cost, maxCost) {
  if (!(cost > 0) || !(maxCost > 0)) return 0;
  // A share of the track beside the figure, floored so that a cheap session
  // still shows a tick rather than nothing at all.
  return Math.max(3, Math.round(100 * Math.sqrt(cost / maxCost)));
}

function sessionRow(session, maxCost) {
  const provider = session.provider || 'claude';
  const providerLabel = provider === 'codex' ? 'Codex' : 'Claude';
  const cells = [
    `<td class="title">
       <span class="dot s${session.colorSlot}"></span><span class="provider ${provider}">${providerLabel}</span>${escapeHtml(session.title)}
     </td>`,
    `<td class="date" data-value="${escapeHtml(session.started || '')}"></td>`,
    `<td class="num">${formatDuration(session.active)}</td>`,
    `<td class="num">${session.messages.toLocaleString()}</td>`,
    `<td class="num">${session.subagents || '—'}</td>`,
    `<td class="num">${formatBytes(session.bytes)}</td>`,
    `<td class="num cost">${formatCost(session.cost)}</td>`,
    `<td class="action">
       ${session.profileAvailable === false
         ? '<span class="unavailable">—</span>'
         : `<button type="button" data-id="${escapeHtml(`${provider}:${session.id}`)}" data-provider="${provider}">Profiler</button>`}
     </td>`
  ];

  // The sort keys are the raw numbers, so that clicking a header sorts by value
  // rather than by the formatted text ("9 MB" would sort above "10 MB").
  const keys = [
    session.title.toLowerCase(),
    session.started || '',
    session.active,
    session.messages,
    session.subagents,
    session.bytes,
    session.cost ?? '',
    0
  ];

  const sortAttrs = keys
    .map((key, i) => `data-sort${i}="${escapeHtml(key)}"`)
    .join(' ');

  // The path gets a row of its own rather than a second line inside the title
  // cell: in a narrow window that cell is a few characters wide and a path
  // breaks mid-word down it. Spanning the numeric columns gives the text the
  // width of the table to wrap in, and it wraps at the separators.
  //
  // Both rows live in one <tbody>, which is what the sort reorders — so the
  // pair always moves together and cannot be split apart.
  return `<tbody ${sortAttrs}>
    <tr class="figures">${cells.join('')}</tr>
    <tr class="path">
      <td colspan="${COLUMNS.length - 3}">${escapeHtml(session.cwd)}${
        session.gitBranch ? ` · ${escapeHtml(session.gitBranch)}` : ''
      }${
        session.model ? ` · ${escapeHtml(session.model)}` : ''
      }</td>
      <td class="meter" colspan="2">
        <span class="bar ${costBand(session.cost)}"
              style="width:${costBar(session.cost, maxCost)}%"></span>
      </td>
      <td></td>
    </tr>
  </tbody>`;
}

const COLUMNS = [
  { label: 'Session', className: 'title' },
  { label: 'Started', className: 'date' },
  { label: 'Active', className: 'num' },
  { label: 'Messages', className: 'num' },
  { label: 'Sub-agents', className: 'num' },
  { label: 'Size', className: 'num' },
  { label: 'Cost', className: 'num cost' },
  { label: '', className: 'action', unsortable: true }
];

function renderPage(sessions, { size = false, host = null } = {}) {
  const header = COLUMNS.map((column, i) =>
    column.unsortable
      ? `<th class="${column.className}"></th>`
      : `<th class="${column.className}" data-column="${i}">${escapeHtml(column.label)}</th>`
  ).join('');

  assignProjectColors(sessions);

  const totals = usageSummary(sessions);
  const totalBytes = sessions.reduce((sum, session) => sum + session.bytes, 0);
  const maxCost = sessions.reduce((max, session) => Math.max(max, session.cost), 0);

  return `<!DOCTYPE html>
<meta charset="utf-8">
<title>Claude and Codex sessions${host ? ` on ${escapeHtml(host)}` : ''}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: light-dark(#fcfcfb, #1a1a19);
    --fg: light-dark(#0b0b0b, #ffffff);
    --dim: light-dark(#52514e, #c3c2b7);
    --line: light-dark(#e0e0e6, #38383d);
    --hover: light-dark(#f2f6fc, #23262b);
    --accent: light-dark(#2a78d6, #3987e5);

    /* The cost bands. These are the palette's fixed status colours, which are
       deliberately not themed: green/yellow/red mean the same thing on either
       surface. The cheapest band is the neutral blue instead of a fifth status
       hue, since "this session was cheap" is not a warning about anything. */
    --cost-cheap: light-dark(#2a78d6, #3987e5);
    --cost-good: #0ca30c;
    --cost-warning: #fab219;
    --cost-critical: #d03b3b;

    /* The eight categorical hues, validated for both surfaces. */
    --s0: light-dark(#2a78d6, #3987e5);
    --s1: light-dark(#eb6834, #d95926);
    --s2: light-dark(#1baf7a, #199e70);
    --s3: light-dark(#eda100, #c98500);
    --s4: light-dark(#e87ba4, #d55181);
    --s5: light-dark(#008300, #008300);
    --s6: light-dark(#4a3aa7, #9085e9);
    --s7: light-dark(#e34948, #e66767);
  }
  body {
    margin: 0 auto; padding: 2rem 1.5rem; max-width: 1200px;
    background: var(--bg); color: var(--fg);
    font: 14px/1.5 system-ui, sans-serif;
  }
  /* In a window too narrow for the columns, the table scrolls sideways rather
     than letting the last one fall off the edge. */
  .scroll { overflow-x: auto; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .summary { color: var(--dim); margin-bottom: 1.5rem; }
  .summary strong { color: var(--fg); font-variant-numeric: tabular-nums; }
  .summary .total { color: var(--accent); }
  .usage-summary {
    margin: 1rem 0 1.5rem; overflow-x: auto;
    border: 1px solid var(--line); border-radius: 6px;
    --usage-columns: minmax(10rem, 1fr) repeat(9, minmax(5.5rem, auto));
  }
  .usage-grid {
    display: grid;
    grid-template-columns: var(--usage-columns);
    min-width: 68rem;
  }
  .usage-row {
    display: grid; grid-template-columns: subgrid; grid-column: 1 / -1;
    column-gap: 1rem; padding: .42rem .7rem; align-items: baseline;
    box-sizing: border-box; font-variant-numeric: tabular-nums;
  }
  .usage-row > div:not(:first-child) { text-align: right; }
  .usage-head { color: var(--dim); font-size: .82rem; border-bottom: 1px solid var(--line); }
  .usage-head [data-usage-column] {
    position: relative; cursor: pointer; user-select: none; white-space: nowrap;
  }
  .usage-head [data-usage-column]:hover,
  .usage-head [data-usage-column]:focus-visible { color: var(--accent); }
  .usage-head .asc::after, .usage-head .desc::after {
    position: absolute; margin-left: .2em; font-size: .85em;
  }
  .usage-head .asc::after { content: '▲'; }
  .usage-head .desc::after { content: '▼'; }
  .usage-total { font-weight: 700; background: var(--hover); }
  .usage-label { font-weight: 600; }
  .usage-label .provider { margin-left: .5rem; margin-right: 0; }
  .usage-models {
    grid-column: 1 / -1; border-top: 1px solid var(--line);
  }
  .usage-models summary {
    cursor: pointer; color: var(--dim); padding: .45rem .7rem; user-select: none;
  }
  .usage-models[open] summary { border-bottom: 1px solid var(--line); }
  .usage-model-grid {
    display: grid; grid-template-columns: var(--usage-columns);
  }
  .options {
    margin-bottom: 1rem; display: flex; align-items: center;
    gap: .5rem 1rem; flex-wrap: wrap;
  }
  /* The bands are named here, so a bar's colour is never the only thing that
     says what it means. */
  .legend { margin-left: auto; display: flex; gap: .9rem; color: var(--dim); }
  .key { display: flex; align-items: center; gap: .35rem; white-space: nowrap; }
  .key .bar { width: 1.1rem; height: .55rem; border-radius: 3px; }
  label { user-select: none; cursor: pointer; }
  .hint { color: var(--dim); margin-left: .4rem; }
  table { border-collapse: collapse; width: 100%; min-width: 54rem; }
  th, td { text-align: left; padding: .5rem .6rem; vertical-align: baseline; }
  /* The rule goes under the session, not under each of its two rows. */
  th { border-bottom: 1px solid var(--line); }
  tbody { border-bottom: 1px solid var(--line); }
  tr.figures td { padding-bottom: .15rem; }
  tr.path td { padding-top: 0; padding-bottom: .5rem; }
  th {
    position: sticky; top: 0; background: var(--bg);
    font-weight: 600; white-space: nowrap;
  }
  th[data-column] { cursor: pointer; }
  th[data-column]:hover { color: var(--accent); }
  /* The arrow is drawn in the padding the cells already have between them, so
     it takes no width of its own: an arrow that did would widen its column on
     click and shove every other one sideways. */
  th.asc::after, th.desc::after {
    position: absolute; margin-left: .2em; font-size: .85em;
  }
  th.asc::after { content: '▲'; }
  th.desc::after { content: '▼'; }
  tbody:hover td { background: var(--hover); }
  .num, td.date { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  th.num, th.date { text-align: right; }
  td.title { font-weight: 500; }
  th.title, td.title { width: 100%; min-width: 12rem; }
  tr.path td { color: var(--dim); font-size: .85em; font-weight: 400; }
  /* A dot beside the title, never colour alone: the project path is spelled
     out on the line below it. */
  .dot {
    display: inline-block; width: .5rem; height: .5rem; border-radius: 50%;
    margin-right: .45rem; vertical-align: baseline; flex: none;
  }
  .provider {
    display: inline-block; margin-right: .5rem; padding: .05rem .35rem;
    border: 1px solid var(--line); border-radius: 3px;
    color: var(--dim); font-size: .72rem; font-weight: 650;
    line-height: 1.35; text-transform: uppercase; vertical-align: .05rem;
  }
  .provider.codex { color: light-dark(#086b53, #65d6b5); }
  .provider.claude { color: light-dark(#91451d, #f09a68); }
  .s0 { background: var(--s0); } .s1 { background: var(--s1); }
  .s2 { background: var(--s2); } .s3 { background: var(--s3); }
  .s4 { background: var(--s4); } .s5 { background: var(--s5); }
  .s6 { background: var(--s6); } .s7 { background: var(--s7); }

  /* The bar grows leftward from the figure, which keeps the numbers aligned in
     a column of their own while the bar reads as a row-length magnitude. A
     fixed width is what makes the lengths comparable between rows. */
  td.cost { font-weight: 600; white-space: nowrap; }
  /* The bar sits on the row's second line, spanning the Size and Cost columns,
     so it has the width of both to grow in rather than the sliver left beside
     a four-figure number. It grows from the right, under the figures it is
     about. */
  td.meter { text-align: right; line-height: 0; }
  td.meter .bar {
    display: inline-block; height: .5rem; border-radius: 3px; max-width: 100%;
  }
  .bar.cheap { background: var(--cost-cheap); }
  .bar.good { background: var(--cost-good); }
  .bar.warning { background: var(--cost-warning); }
  .bar.critical { background: var(--cost-critical); }
  td.action { text-align: right; }
  .unavailable { color: var(--dim); }
  /* A fixed width, so that nothing in the button's own state can reflow the
     table: the label never changes, and the busy state is drawn inside it. */
  button {
    font: inherit; font-weight: 500; padding: .25rem 0; width: 5.5rem;
    cursor: pointer; border: 1px solid var(--accent); border-radius: 4px;
    background: transparent; color: var(--accent);
  }
  button:hover:not(:disabled) { background: var(--accent); color: var(--bg); }
  button:disabled { cursor: progress; border-style: dashed; opacity: .7; }
  /* The busy state is a pulse rather than a word, for the same reason. */
  button:disabled { animation: pulse 1s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .35; } }
  .empty { color: var(--dim); padding: 2rem 0; }
  /* The machine being looked at, when it is not this one. Worth saying in the
     heading rather than in small print: every figure on the page is about that
     machine, and a tab left open is easy to mistake for the local list. */
  h1 .host { color: var(--accent); }
</style>

<h1>Claude and Codex sessions${host ? ` on <span class="host">${escapeHtml(host)}</span>` : ''}</h1>
<div class="summary">
  <strong>${sessions.length}</strong> session${sessions.length === 1 ? '' : 's'} ·
  <strong>${formatBytes(totalBytes)}</strong>
</div>

<section class="usage-summary" aria-label="Usage totals">
  <div class="usage-grid" role="table">
    ${usageHeader('providers')}
    ${usageRow(totals.total, 'usage-total')}
    ${totals.providers.map(provider => usageRow(provider, `usage-provider ${provider.provider}`)).join('')}
    ${totals.models.length ? `<details class="usage-models">
      <summary>By model (${totals.models.length})</summary>
      <div class="usage-model-grid">
        ${usageHeader('models')}
        ${totals.models.map(model => usageRow(model, `usage-model ${model.provider}`)).join('')}
      </div>
    </details>` : ''}
  </div>
</section>

<div class="options">
  <label>
    <input type="checkbox" id="size"${size ? ' checked' : ''}>
    Profile what fills the Claude context window
  </label>
  <span class="hint">(the <code>--size</code> profile, instead of the timeline)</span>

  <span class="legend">
    <span class="key"><span class="bar cheap"></span>&lt;$10</span>
    <span class="key"><span class="bar good"></span>$10</span>
    <span class="key"><span class="bar warning"></span>$50</span>
    <span class="key"><span class="bar critical"></span>$200+</span>
  </span>
</div>

${sessions.length === 0
  ? `<p class="empty">No Claude or Codex sessions found${host ? ` on ${escapeHtml(host)}` : ''}.</p>`
  : `<div class="scroll"><table>
  <thead><tr>${header}</tr></thead>
  ${sessions.map(session => sessionRow(session, maxCost)).join('')}
</table></div>`}

<script>
  for (const cell of document.querySelectorAll('td.date')) {
    const value = cell.dataset.value;
    cell.textContent = value
      ? new Date(value).toLocaleString([], {
          dateStyle: 'medium', timeStyle: 'short'
        })
      : '—';
  }

  // The grand total is a fixed reference point. The top header sorts the two
  // provider rows beneath it; the repeated header inside <details> sorts model
  // rows independently, without moving either header or the details element.
  const usageSortState = {
    providers: { column: -1, ascending: false },
    models: { column: -1, ascending: false }
  };

  function sortUsage(target, column) {
    const state = usageSortState[target];
    state.ascending = column === state.column ? !state.ascending : column === 0;
    state.column = column;
    const selector = target === 'providers' ? '.usage-provider' : '.usage-model';
    const rows = [...document.querySelectorAll(selector)].sort((a, b) => {
      const x = a.getAttribute('data-usage-sort' + column);
      const y = b.getAttribute('data-usage-sort' + column);
      // Missing provider-specific values sort last in both directions.
      if (x === '' && y !== '') return 1;
      if (y === '' && x !== '') return -1;
      const numeric = x !== '' && y !== '' && !isNaN(x) && !isNaN(y);
      let order = numeric ? x - y : String(x).localeCompare(String(y));
      if (order === 0 && column !== 0) {
        order = a.getAttribute('data-usage-sort0')
          .localeCompare(b.getAttribute('data-usage-sort0'));
      }
      return state.ascending ? order : -order;
    });

    if (target === 'models') {
      document.querySelector('.usage-model-grid').append(...rows);
    } else {
      const grid = document.querySelector('.usage-grid');
      const details = grid.querySelector('.usage-models');
      if (details) {
        for (const row of rows) grid.insertBefore(row, details);
      } else {
        grid.append(...rows);
      }
    }

    for (const header of document.querySelectorAll(
      '[data-usage-target="' + target + '"][data-usage-column]'
    )) {
      const active = +header.dataset.usageColumn === column;
      header.classList.toggle('asc', active && state.ascending);
      header.classList.toggle('desc', active && !state.ascending);
      if (active) {
        header.setAttribute('aria-sort', state.ascending ? 'ascending' : 'descending');
      } else {
        header.removeAttribute('aria-sort');
      }
    }
  }

  for (const header of document.querySelectorAll('[data-usage-column]')) {
    const activate = () => sortUsage(header.dataset.usageTarget,
      +header.dataset.usageColumn);
    header.addEventListener('click', activate);
    header.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      activate();
    });
  }

  // Each session is a <tbody> of two rows — the figures and the path — so the
  // sort moves those groups rather than individual rows, and a session's two
  // lines can never be separated.
  const table = document.querySelector('table');
  const groups = () => [...table.tBodies];
  // No column is sorted yet, so the first sort() call takes its "new column"
  // branch rather than reversing a sort that has not happened.
  let sortColumn = -1;
  let ascending = false;

  function sort(column) {
    // Clicking the sorted column reverses it; a new column starts descending,
    // which is what "biggest first" means for every numeric column here.
    ascending = column === sortColumn ? !ascending : column === 0;
    sortColumn = column;

    const sorted = groups().sort((a, b) => {
      const x = a.getAttribute('data-sort' + column);
      const y = b.getAttribute('data-sort' + column);
      const numeric = x !== '' && y !== '' && !isNaN(x) && !isNaN(y);
      const order = numeric ? x - y : String(x).localeCompare(String(y));
      return ascending ? order : -order;
    });

    table.append(...sorted);

    for (const th of document.querySelectorAll('th')) {
      th.classList.toggle('asc', +th.dataset.column === column && ascending);
      th.classList.toggle('desc', +th.dataset.column === column && !ascending);
    }
  }

  for (const th of document.querySelectorAll('th[data-column]')) {
    th.addEventListener('click', () => sort(+th.dataset.column));
  }

  sort(1);

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-id]');
    if (!button) return;

    // Context-size profiling is a Claude transcript concept. Codex rows always
    // open their activity timeline even when that page-wide option is checked.
    const size = button.dataset.provider === 'claude' &&
      document.getElementById('size').checked;
    button.disabled = true;

    // The tab is opened now, while the click is still what is running:
    // building a profile takes seconds — over five for a large session — and
    // by then the click no longer counts as user activation, so a popup opened
    // at that point is the browser's to block. It is filled in below.
    const tab = window.open('', '_blank');

    try {
      const response = await fetch(
        '/open/' + encodeURIComponent(button.dataset.id) + (size ? '?size=1' : '')
      );
      if (!response.ok) throw new Error(await response.text());
      // The profiler is opened from here rather than by the server, so that it
      // lands in the browser the person is already looking at.
      const { url } = (await response.json());
      if (tab) {
        tab.location = url;
      } else {
        // A blocked popup is no reason to lose the profile that was just
        // built, so this window goes to it instead.
        window.location = url;
      }
    } catch (error) {
      if (tab) tab.close();
      alert('Could not build the profile:\\n' + error.message);
    } finally {
      button.disabled = false;
    }
  });
</script>
`;
}

module.exports = {
  findSessionFiles,
  listSessions,
  summarizeSession,
  renderPage,
  formatBytes,
  formatCost,
  formatDuration,
  projectLabel
};
