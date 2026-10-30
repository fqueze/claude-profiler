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
  if (bytes >= 100 * 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
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

// The providers the picker knows how to label and total. Anything else is a
// Claude session, which is what protocol 1/2 callers sent a bare id for.
function providerOf(session) {
  return session.provider === 'codex' || session.provider === 'dsh'
    ? session.provider
    : 'claude';
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

  if (provider === 'dsh') {
    // DSH reports newly processed input and cache reads as disjoint buckets, so
    // their sum is the whole input side while newInput is the fresh part.
    const cacheRead = usage.cacheReadTokens || 0;
    const cacheWrite = usage.cacheWriteTokens > 0 ? usage.cacheWriteTokens : null;
    return {
      input: (usage.inputTokens || 0) + cacheRead,
      output: usage.outputTokens || 0,
      newInput: usage.inputTokens || 0,
      // OpenRouter does not report cache writes; a provider that does is kept.
      cacheWrite,
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

// Folds one already-totalled bucket into another, with addTotals' semantics.
// The calendar sums a week from its days' totals rather than re-reading every
// session, so it needs the same completeness flags and priced-token split.
function mergeTotals(target, source) {
  target.cost += source.cost;
  target.costComplete = target.costComplete && source.costComplete;
  target.pricedTokens += source.pricedTokens;
  target.unpricedTokens += source.unpricedTokens;
  if (source.creditsAvailable) {
    target.credits += source.credits;
    target.creditsAvailable = true;
  }
  for (const key of ['input', 'output', 'newInput', 'cacheRead']) {
    target[key] += source[key];
  }
  if (source.cacheWriteAvailable) {
    target.cacheWrite += source.cacheWrite;
    target.cacheWriteAvailable = true;
    target.cacheWriteEstimated ||= source.cacheWriteEstimated;
    target.cacheWriteFromApi ||= source.cacheWriteFromApi;
  }
  return target;
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

// A provider and the model rows it expands into, which move together when the
// providers are sorted.
function usageGroup(provider) {
  return `<div class="usage-group" role="rowgroup" ${usageSortAttributes(provider)}>
    ${usageRow(provider, `usage-provider ${provider.provider}`, provider.models.length > 0)}
    ${provider.models.map(model => usageRow(model, 'usage-model')).join('')}
  </div>`;
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

function usageHeader() {
  return `<div class="usage-row usage-head" role="row">
    ${USAGE_COLUMNS.map((column, index) =>
      `<div role="columnheader" tabindex="0" data-usage-column="${index}"` +
      `${column.title ? ` title="${escapeHtml(column.title)}"` : ''}>` +
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

// The figures of a usage row, without the label. Split out so that the period
// table can render its own label cell — the period and its session count —
// around exactly the same cells as the summary.
function usageCells(total) {
  return `<div role="cell"${total.costComplete ? '' : ' title="Some costs are unavailable"'}>${formatTotalCost(total)}</div>
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
    ${effectiveRateCell(total)}`;
}

function usageRow(total, className = '', expandable = false) {
  return `<div class="usage-row ${className}" role="row" ${usageSortAttributes(total)}${
    expandable ? ' tabindex="0" aria-expanded="false"' : ''}>
    <div class="usage-label" role="rowheader">${escapeHtml(total.label)}</div>
    ${usageCells(total)}
  </div>`;
}

// What each model contributed to a session's totals. Models without a cost of
// their own share what the ones with an exact cost leave of the session's, in
// proportion to their tokens. Resolved here rather than in the page so that a
// period bucket splits a session the same way the summary above it does.
function modelContributions(provider, session) {
  const entries = Object.entries(session.billingModels || session.models || {});
  const modelEntries = entries.length ? entries : [[session.model || 'Unknown model',
    session.billingUsage || session.usage]];
  const exact = ([, modelUsage]) => Number.isFinite(modelUsage?.cost);
  const weights = modelEntries.map(entry => {
    if (exact(entry)) return 0;
    const normalized = normalizedUsage(provider, entry[1]);
    return normalized.input + normalized.output;
  });
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  const unattributed = modelEntries.filter(entry => !exact(entry)).length;
  const remainingCost = Math.max(0, (session.cost ?? 0) -
    modelEntries.filter(exact).reduce((sum, [, modelUsage]) => sum + modelUsage.cost, 0));

  return modelEntries.map(([model, modelUsage], index) => ({
    model,
    provider,
    usage: normalizedUsage(provider, modelUsage),
    cost: Number.isFinite(modelUsage?.cost)
      ? modelUsage.cost
      : session.cost === null || session.cost === undefined ? null
        : remainingCost *
          (weightTotal > 0 ? weights[index] / weightTotal : 1 / unattributed),
    credits: provider === 'codex' ? modelUsage?.credits : null
  }));
}

function usageSummary(sessions) {
  const total = emptyTotals('Total');
  const providers = {
    claude: emptyTotals('Claude', 'claude'),
    codex: emptyTotals('Codex', 'codex'),
    dsh: emptyTotals('DSH', 'dsh')
  };
  const models = new Map();

  for (const session of sessions) {
    const provider = providerOf(session);
    const usage = normalizedUsage(provider, session.billingUsage || session.usage);
    const credits = provider === 'codex' ? session.credits : null;
    addTotals(total, usage, session.cost, credits);
    addTotals(providers[provider], usage, session.cost, credits);

    for (const contribution of modelContributions(provider, session)) {
      // An unpriced session's tokens still count; its cost is unknown, which
      // the row shows, and the $/M figure only divides the priced ones.
      const key = `${contribution.provider}:${contribution.model}`;
      if (!models.has(key)) {
        models.set(key, emptyTotals(modelLabel(contribution.model), contribution.provider));
      }
      addTotals(models.get(key), contribution.usage, contribution.cost, contribution.credits);
    }
  }

  const used = totals => totals.input + totals.output > 0 || totals.cost > 0;
  return { total, providers: Object.values(providers).filter(used).map(provider => ({
    ...provider,
    models: [...models.values()]
      .filter(model => model.provider === provider.provider && used(model))
      .sort((a, b) => b.cost - a.cost || a.label.localeCompare(b.label))
  })) };
}

// The minimal per-session record the page buckets by date. The two non-obvious
// pieces — normalizing a provider's usage shape and splitting a session's cost
// across models — are resolved here, so the page script only sums and formats.
function periodSessions(sessions) {
  return sessions.map(session => {
    const provider = providerOf(session);
    return {
      started: session.started || null,
      provider,
      cost: Number.isFinite(session.cost) ? session.cost : null,
      credits: provider === 'codex' && Number.isFinite(session.credits)
        ? session.credits : null,
      usage: normalizedUsage(provider, session.billingUsage || session.usage),
      models: modelContributions(provider, session)
        // The summary omits models that contributed nothing, and the page would
        // filter them out anyway; not shipping them keeps the payload honest.
        .filter(contribution => contribution.usage.input + contribution.usage.output > 0 ||
          contribution.cost > 0)
        .map(contribution => ({
          ...contribution,
          // A period bucket opens onto model rows that have no provider row above
          // them, so they carry the label the summary's model rows would have.
          label: modelLabel(contribution.model)
        }))
    };
  });
}

// The period table's header is plain labels: unlike the summary, its rows are
// chronological and its columns are not sortable.
function periodUsageHeader() {
  return `<div class="usage-row usage-head" role="row">
    ${USAGE_COLUMNS.map(column =>
      `<div role="columnheader"${column.title ? ` title="${escapeHtml(column.title)}"` : ''}>` +
      `${escapeHtml(column.label)}</div>`).join('')}
  </div>`;
}

// The period aggregation runs in the browser, because the start and end dates
// change without a round trip. These are the server's own usage helpers,
// serialized into the page, so a period row formats its figures with the same
// code as the summary above it rather than a copy that can drift.
const CLIENT_USAGE_FUNCTIONS = [
  escapeHtml, formatTokens, tokenCell, creditCell, formatTotalCost, cachedPercent,
  effectiveRateCell, emptyTotals, addTotals, mergeTotals, costBands, costBand,
  usageSortAttributes, usageCells, usageRow
];

// The collapsible "Usage over time" section. It is closed by default, so it
// adds one line near the top of the page until it is asked for.
function periodPanel(sessions) {
  // The data is JSON inside a <script>, so any `<` is escaped: an unescaped
  // `</script>` in a model name would end the block early.
  const data = JSON.stringify(periodSessions(sessions))
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

  return `<details class="period-panel">
  <summary>Usage over time</summary>
  <div class="period-controls">
    <span class="period-modes" role="radiogroup" aria-label="Aggregation period">
      <label><input type="radio" name="period-mode" value="day"> Day</label>
      <label><input type="radio" name="period-mode" value="month" checked> Month</label>
      <label><input type="radio" name="period-mode" value="half"> Half-year</label>
      <label><input type="radio" name="period-mode" value="total"> Total</label>
    </span>
    <label class="period-date">From <input type="date" id="period-start"></label>
    <label class="period-date">To <input type="date" id="period-end"></label>
    <button type="button" id="period-clear">Clear</button>
  </div>
  <div class="period-grid" role="table" id="period-grid"
       aria-label="Usage by period">
    ${periodUsageHeader()}
  </div>
  <div class="calendar" id="period-calendar" role="grid"
       aria-label="Usage by day" hidden></div>
  <p class="period-note" id="period-note"></p>
  <script type="application/json" id="period-data">${data}</script>
</details>`;
}

// In a provider's model rows, the provider's name is already on the row above.
function modelLabel(model) {
  return model.replace(/^claude-/, '');
}

// The models a session used, its sub-agents' included, most used first.
function sessionModels(session) {
  const provider = providerOf(session);
  const models = Object.entries(session.models || {})
    .map(([model, usage]) => {
      const tokens = normalizedUsage(provider, usage);
      return { model, tokens: tokens.input + tokens.output };
    })
    .filter(({ tokens }) => tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .map(({ model }) => model);
  return models.length ? models : [session.model].filter(Boolean);
}

// A count in a narrow column: 7.6K rather than 7,578.
function formatCount(count) {
  return count >= 1000
    ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
      .format(count)
    : String(count);
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
// A function rather than a constant so that the same source can be serialized
// into the page for the calendar's day cells.
function costBands() {
  return [
    { over: 200, band: 'critical' },
    { over: 50, band: 'warning' },
    { over: 10, band: 'good' },
    { over: 0, band: 'cheap' }
  ];
}

function costBand(cost) {
  return (costBands().find(({ over }) => cost > over) || { band: 'cheap' }).band;
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
  const provider = providerOf(session);
  const models = sessionModels(session);
  const cells = [
    `<td class="title" title="${escapeHtml(session.title)}">
       <span class="dot s${session.colorSlot}"></span>${escapeHtml(session.title)}
     </td>`,
    `<td class="model">${models.map(escapeHtml).join('<br>') || '—'}</td>`,
    `<td class="date" data-value="${escapeHtml(session.ended || '')}"></td>`,
    `<td class="num">${formatDuration(session.active)}</td>`,
    `<td class="num" title="${session.messages.toLocaleString('en-US')} messages">${
      formatCount(session.messages)}</td>`,
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
    models.join(' '),
    session.ended || '',
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
  { label: 'Model', className: 'model' },
  { label: 'Last active', className: 'date' },
  { label: 'Active', className: 'num' },
  { label: 'Msgs', title: 'Messages', className: 'num' },
  { label: 'Agents', title: 'Sub-agents', className: 'num' },
  { label: 'Size', className: 'num' },
  { label: 'Cost', className: 'num cost' },
  { label: '', className: 'action', unsortable: true }
];

function renderPage(sessions, { size = false, host = null } = {}) {
  const header = COLUMNS.map((column, i) =>
    column.unsortable
      ? `<th class="${column.className}"></th>`
      : `<th class="${column.className}" data-column="${i}"${
        column.title ? ` title="${column.title}"` : ''}>${escapeHtml(column.label)}</th>`
  ).join('');

  assignProjectColors(sessions);

  const totals = usageSummary(sessions);
  const totalBytes = sessions.reduce((sum, session) => sum + session.bytes, 0);
  const maxCost = sessions.reduce((max, session) => Math.max(max, session.cost), 0);

  return `<!DOCTYPE html>
<meta charset="utf-8">
<title>Agent sessions${host ? ` on ${escapeHtml(host)}` : ''}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: light-dark(#fcfcfb, #1a1a19);
    --fg: light-dark(#0b0b0b, #ffffff);
    --dim: light-dark(#52514e, #c3c2b7);
    --line: light-dark(#e0e0e6, #38383d);
    --hover: light-dark(#f2f6fc, #23262b);
    --hover-strong: light-dark(#e3ebf7, #2d3238);
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
  .usage-group { display: contents; }
  /* A provider with model rows expands into them; the triangle says which do. */
  .usage-provider[aria-expanded] { cursor: pointer; }
  /* Darker than the Total row's tint, so the hovered row of a long expanded
     list stands out even when it is the Total row. */
  .usage-row:not(.usage-head):hover,
  .usage-provider[aria-expanded]:focus-visible { background: var(--hover-strong); }
  .usage-provider .usage-label::before {
    content: ''; display: inline-block; width: 1em; color: var(--dim);
  }
  .usage-provider[aria-expanded] .usage-label::before { content: '▸'; }
  .usage-provider[aria-expanded="true"] .usage-label::before { content: '▾'; }
  .usage-model { display: none; color: var(--dim); }
  .usage-provider[aria-expanded="true"] ~ .usage-model { display: grid; }
  .usage-model .usage-label { font-weight: 400; padding-left: 1.5em; }
  /* The collapsible period aggregation. It brings the summary's column widths
     with it, since the panel is not inside .usage-summary, but its header is
     not sortable and its model rows live in a grid of their own rather than in
     a provider's expandable group. */
  .period-panel {
    margin: 1rem 0 1.5rem; overflow-x: auto;
    border: 1px solid var(--line); border-radius: 6px;
    --usage-columns: minmax(10rem, 1fr) repeat(9, minmax(5.5rem, auto));
  }
  .period-panel > summary {
    cursor: pointer; user-select: none; color: var(--dim); font-weight: 600;
    padding: .5rem .7rem;
  }
  .period-panel[open] > summary { border-bottom: 1px solid var(--line); }
  .period-controls {
    display: flex; align-items: center; gap: .5rem 1rem; flex-wrap: wrap;
    padding: .6rem .7rem; color: var(--dim);
  }
  .period-modes { display: inline-flex; gap: .8rem; }
  .period-modes label, .period-date {
    display: inline-flex; align-items: center; gap: .3rem;
  }
  .period-date input {
    font: inherit; color: inherit; background: transparent;
    border: 1px solid var(--line); border-radius: 4px; padding: .15rem .3rem;
  }
  .period-controls button {
    font-size: .85rem; width: auto; padding: .2rem .6rem;
  }
  /* The bucket's own row is set apart from the model rows it opens. */
  .usage-period { background: var(--hover); font-weight: 600; }
  .usage-period .hint { font-weight: 400; }
  /* Both bodies are grids of their own, with the summary's column widths. */
  .period-grid, .period-model-grid {
    display: grid; grid-template-columns: var(--usage-columns); min-width: 68rem;
  }
  .period-models { grid-column: 1 / -1; border-top: 1px solid var(--line); }
  .period-models summary {
    cursor: pointer; color: var(--dim); padding: .45rem .7rem; user-select: none;
  }
  .period-models[open] summary { border-bottom: 1px solid var(--line); }
  .period-model { color: var(--dim); }
  .period-model .usage-label { font-weight: 400; padding-left: 1.5em; }
  /* The calendar replaces the day list: weeks stacked, weekdays as columns.
     --cal-columns is set by the script, since the weekend columns appear only
     when the displayed range has a weekend session. */
  .calendar { min-width: 68rem; padding: .6rem .7rem; }
  .cal-head, .cal-week {
    display: grid; grid-template-columns: var(--cal-columns);
    column-gap: .4rem; align-items: stretch;
  }
  .cal-head { color: var(--dim); font-size: .82rem; padding-bottom: .3rem; }
  .cal-head > div { text-align: center; }
  .cal-head .cal-week-head { text-align: right; }
  .cal-week { margin-bottom: .4rem; }
  .cal-week-label {
    align-self: center; white-space: nowrap; color: var(--dim); font-size: .82rem;
  }
  /* A day cell is a button, so clicking it opens the day's full row below the
     week. Empty days keep their number to hold the calendar's shape. */
  .cal-day {
    display: flex; flex-direction: column; align-items: flex-start;
    gap: .15rem; min-height: 3.6rem; width: auto; padding: .35rem .45rem;
    border: 1px solid var(--line); border-radius: 5px; background: transparent;
    color: inherit; font: inherit; text-align: left;
  }
  .cal-day:not(.empty) { cursor: pointer; }
  .cal-day:not(.empty):hover { background: var(--hover); color: var(--fg); }
  .cal-day.empty { border-style: dashed; opacity: .55; }
  .cal-day .cal-date { color: var(--dim); font-size: .8rem; }
  .cal-day .cal-cost, .cal-week-total .cal-cost {
    font-weight: 600; font-variant-numeric: tabular-nums;
  }
  .cal-cost.cheap { color: var(--cost-cheap); }
  .cal-cost.good { color: var(--cost-good); }
  .cal-cost.warning { color: var(--cost-warning); }
  .cal-cost.critical { color: var(--cost-critical); }
  .cal-sessions { color: var(--dim); font-size: .78rem; white-space: nowrap; }
  .cal-week-total {
    display: flex; flex-direction: column; align-items: flex-end;
    justify-content: center; gap: .15rem; white-space: nowrap;
  }
  /* The expanded day uses the summary's own grid, so its figures line up. */
  .cal-detail {
    grid-column: 1 / -1; margin: .35rem 0 .1rem;
    border-top: 1px dashed var(--line);
  }
  .period-note { margin: 0; padding: .5rem .7rem; color: var(--dim); }
  .period-note:empty { display: none; }
  /* Both bodies carry a display value of their own, so the hidden attribute
     needs a rule with the same weight to actually take them off the page. */
  .period-grid[hidden], .calendar[hidden] { display: none; }
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
  /* Every other column is as narrow as its content, and the title takes the
     rest of the width, on one line; the full title is its tooltip. */
  th:not(.title) { width: 1%; white-space: nowrap; }
  td.title { min-width: 12rem; }
  tr.path td { color: var(--dim); font-size: .85em; font-weight: 400; }
  td.title { max-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* A dot beside the title, never colour alone: the project path is spelled
     out on the line below it. */
  .dot {
    display: inline-block; width: .5rem; height: .5rem; border-radius: 50%;
    margin-right: .45rem; vertical-align: baseline; flex: none;
  }
  td.model { color: var(--dim); white-space: nowrap; }
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

<h1>Agent sessions${host ? ` on <span class="host">${escapeHtml(host)}</span>` : ''}</h1>
<div class="summary">
  <strong>${sessions.length}</strong> session${sessions.length === 1 ? '' : 's'} ·
  <strong>${formatBytes(totalBytes)}</strong>
</div>

${periodPanel(sessions)}

<section class="usage-summary" aria-label="Usage totals">
  <div class="usage-grid" role="table">
    ${usageHeader()}
    ${usageRow(totals.total, 'usage-total')}
    ${totals.providers.map(usageGroup).join('')}
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
  ? `<p class="empty">No agent sessions found${host ? ` on ${escapeHtml(host)}` : ''}.</p>`
  : `<div class="scroll"><table>
  <thead><tr>${header}</tr></thead>
  ${sessions.map(session => sessionRow(session, maxCost)).join('')}
</table></div>`}

<script>
  // How long ago, which is what the column is read for; the date itself is
  // the tooltip. Rendered here because only the browser knows the time zone,
  // and redrawn every minute so that a page left open stays right.
  function ago(date) {
    const minutes = Math.floor((Date.now() - date) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return minutes + ' min ago';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    const days = Math.floor(hours / 24);
    if (days < 30) return days + 'd ago';
    const months = Math.floor(days / 30.44);
    if (months < 12) return months + (months === 1 ? ' month ago' : ' months ago');
    const years = Math.floor(days / 365.25);
    return years + (years === 1 ? ' year ago' : ' years ago');
  }

  function drawDates() {
    for (const cell of document.querySelectorAll('td.date')) {
      const value = cell.dataset.value;
      if (!value) {
        cell.textContent = '—';
        continue;
      }
      const date = new Date(value);
      cell.textContent = ago(date);
      cell.title = date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    }
  }
  drawDates();
  setInterval(drawDates, 60000);

  // The grand total is a fixed reference point. The header sorts the
  // provider rows beneath it, each moving with its model rows, and the model
  // rows within each provider by the same column.
  let usageColumn = -1;
  let usageAscending = false;

  function usageOrder(column) {
    return (a, b) => {
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
      return usageAscending ? order : -order;
    };
  }

  function sortUsage(column) {
    usageAscending = column === usageColumn ? !usageAscending : column === 0;
    usageColumn = column;
    const order = usageOrder(column);
    const groups = [...document.querySelectorAll('.usage-group')];
    for (const group of groups) {
      group.append(...[...group.querySelectorAll('.usage-model')].sort(order));
    }
    document.querySelector('.usage-grid').append(...groups.sort(order));

    for (const header of document.querySelectorAll('[data-usage-column]')) {
      const active = +header.dataset.usageColumn === column;
      header.classList.toggle('asc', active && usageAscending);
      header.classList.toggle('desc', active && !usageAscending);
      if (active) {
        header.setAttribute('aria-sort', usageAscending ? 'ascending' : 'descending');
      } else {
        header.removeAttribute('aria-sort');
      }
    }
  }

  function onActivate(element, activate) {
    element.addEventListener('click', activate);
    element.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      activate();
    });
  }

  for (const header of document.querySelectorAll('[data-usage-column]')) {
    onActivate(header, () => sortUsage(+header.dataset.usageColumn));
  }
  for (const row of document.querySelectorAll('.usage-provider[aria-expanded]')) {
    onActivate(row, () => row.setAttribute('aria-expanded',
      row.getAttribute('aria-expanded') === 'true' ? 'false' : 'true'));
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

  sort(2);

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

  // --- Usage over time ------------------------------------------------------
  // The period table sums the embedded per-session records in the browser, so
  // the dates can be changed without asking the server for a new page. The
  // formatting helpers below are the server's own, serialized in above, which
  // is why a period row looks exactly like a summary row.
${CLIENT_USAGE_FUNCTIONS.map(fn => fn.toString()).join('\n\n')}

  const periodData = JSON.parse(document.getElementById('period-data').textContent);
  const periodGrid = document.getElementById('period-grid');
  const periodCalendar = document.getElementById('period-calendar');
  const periodNote = document.getElementById('period-note');
  const periodStart = document.getElementById('period-start');
  const periodEnd = document.getElementById('period-end');

  function periodMode() {
    return document.querySelector('input[name="period-mode"]:checked').value;
  }

  // Boundaries are local, like the date inputs: bucketing in UTC would move a
  // late-evening session into the next day for most of the world.
  function periodKey(date, mode) {
    const year = date.getFullYear();
    const month = date.getMonth();
    if (mode === 'day') {
      return year + '-' + String(month + 1).padStart(2, '0') + '-' +
        String(date.getDate()).padStart(2, '0');
    }
    if (mode === 'month') return year + '-' + String(month + 1).padStart(2, '0');
    if (mode === 'half') return year + '-H' + (month < 6 ? 1 : 2);
    return 'total';
  }

  function periodLabel(date, mode) {
    if (mode === 'day') return date.toLocaleDateString([], { dateStyle: 'medium' });
    if (mode === 'month') {
      return date.toLocaleDateString([], { year: 'numeric', month: 'long' });
    }
    if (mode === 'half') return date.getFullYear() + ' H' + (date.getMonth() < 6 ? 1 : 2);
    return 'Total';
  }

  function periodRow(bucket) {
    return '<div class="usage-row usage-period" role="row" ' +
      usageSortAttributes(bucket.total) + '>' +
      '<div class="usage-label" role="rowheader">' + escapeHtml(bucket.label) +
      '<span class="hint">' + bucket.count + ' session' +
      (bucket.count === 1 ? '' : 's') + '</span></div>' +
      usageCells(bucket.total) + '</div>';
  }

  // --- The day calendar -----------------------------------------------------
  // Day mode is a calendar rather than a list: one row per week, Monday first,
  // weekday columns, and a day cell that opens its full usage row and model
  // breakdown beneath the week.
  const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const WEEKDAY_POSITION = { 0: 6, 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5 };

  function addDays(date, days) {
    const shifted = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    shifted.setDate(shifted.getDate() + days);
    return shifted;
  }

  // The Monday on or before the given date.
  function startOfWeek(date) {
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    start.setDate(start.getDate() - WEEKDAY_POSITION[start.getDay()]);
    return start;
  }

  function daysOfWeek(weekday, count) {
    return Array.from({ length: count }, (unused, position) =>
      addDays(weekday, position));
  }

  function weekLabel(start, count) {
    const last = addDays(start, count - 1);
    const first = start.toLocaleDateString([], { month: 'short', day: 'numeric' });
    const sameMonth = start.getMonth() === last.getMonth() &&
      start.getFullYear() === last.getFullYear();
    const end = sameMonth ? String(last.getDate())
      : last.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return first + '–' + end;
  }

  function costCell(total) {
    return '<span class="cal-cost ' + costBand(total.cost) + '">' +
      formatTotalCost(total) + '</span>';
  }

  function countCell(count) {
    return '<span class="cal-sessions">' + count + ' session' +
      (count === 1 ? '' : 's') + '</span>';
  }

  function modelDetails(bucket) {
    const models = [...bucket.models.values()]
      .filter(model => model.input + model.output > 0 || model.cost > 0)
      .sort((a, b) => b.cost - a.cost || a.label.localeCompare(b.label));
    if (!models.length) return '';
    return '<details class="period-models"><summary>By model (' + models.length +
      ')</summary><div class="period-model-grid">' +
      models.map(model => usageRow(model, 'period-model ' + model.provider))
        .join('') + '</div></details>';
  }

  // The day's full row lives inside the week, hidden until its cell is clicked.
  function dayDetail(bucket) {
    return '<div class="cal-detail" data-detail="' + bucket.key + '" hidden>' +
      '<div class="period-grid" role="table">' +
      usageRow(bucket.total, 'usage-period') + modelDetails(bucket) +
      '</div></div>';
  }

  function renderCalendar(dated) {
    const byDay = new Map(dated.map(bucket => [bucket.key, bucket]));
    // Weekend columns appear only when something in the displayed range
    // happened on one, so a work-only history reads as five columns.
    const hasWeekend = dated.some(bucket => {
      const day = bucket.date.getDay();
      return day === 0 || day === 6;
    });
    const weekdays = hasWeekend ? WEEKDAY_ORDER : WEEKDAY_ORDER.slice(0, 5);

    // Weeks are built from the days that have content, so a long quiet stretch
    // does not become a stack of empty rows.
    const weeks = new Map();
    for (const bucket of dated) {
      const start = startOfWeek(bucket.date);
      const key = periodKey(start, 'day');
      if (!weeks.has(key)) {
        weeks.set(key, { start, count: 0, total: emptyTotals('Week') });
      }
      const week = weeks.get(key);
      week.count += bucket.count;
      mergeTotals(week.total, bucket.total);
    }

    periodCalendar.style.setProperty('--cal-columns',
      '10rem repeat(' + weekdays.length + ', minmax(7rem, 1fr)) 9.5rem');

    const head = '<div class="cal-head" role="row"><div></div>' +
      weekdays.map(day => '<div role="columnheader">' +
        WEEKDAY_NAMES[WEEKDAY_POSITION[day]] + '</div>').join('') +
      '<div class="cal-week-head" role="columnheader">Week</div></div>';

    const body = [...weeks.values()]
      .sort((a, b) => a.start - b.start)
      .map(week => {
        const dates = daysOfWeek(week.start, weekdays.length);
        const cells = dates.map(date => {
          const bucket = byDay.get(periodKey(date, 'day'));
          if (!bucket) {
            return '<div class="cal-day empty" role="gridcell">' +
              '<span class="cal-date">' + date.getDate() + '</span></div>';
          }
          return '<button type="button" class="cal-day" role="gridcell" ' +
            'data-day="' + bucket.key + '" aria-expanded="false" aria-label="' +
            escapeHtml(bucket.label + ', ' + bucket.count + ' session' +
              (bucket.count === 1 ? '' : 's') + ', ' +
              formatTotalCost(bucket.total)) + '">' +
            '<span class="cal-date">' + date.getDate() + '</span>' +
            costCell(bucket.total) + countCell(bucket.count) + '</button>';
        }).join('');

        const details = dates.map(date => {
          const bucket = byDay.get(periodKey(date, 'day'));
          return bucket ? dayDetail(bucket) : '';
        }).join('');

        return '<div class="cal-week" role="row">' +
          '<div class="cal-week-label">' +
          escapeHtml(weekLabel(week.start, weekdays.length)) + '</div>' +
          cells +
          '<div class="cal-week-total" role="gridcell">' +
          costCell(week.total) + countCell(week.count) + '</div>' +
          details + '</div>';
      }).join('');

    periodCalendar.innerHTML = head + body;
  }

  function renderPeriods() {
    const mode = periodMode();
    const start = periodStart.value ? new Date(periodStart.value + 'T00:00:00') : null;
    const end = periodEnd.value ? new Date(periodEnd.value + 'T23:59:59.999') : null;
    const bounded = start !== null || end !== null;
    const buckets = new Map();

    for (const record of periodData) {
      const date = record.started ? new Date(record.started) : null;
      const valid = date !== null && !isNaN(date);
      const time = valid ? date.getTime() : null;
      // A session with no date can still be totalled, but it cannot be placed
      // inside a bounded range.
      if (bounded && !valid) continue;
      if (start !== null && time < start.getTime()) continue;
      if (end !== null && time > end.getTime()) continue;

      const key = valid ? periodKey(date, mode) : '';
      if (!buckets.has(key)) {
        buckets.set(key, {
          key,
          date: valid ? date : null,
          label: valid ? periodLabel(date, mode) : 'Unknown date',
          count: 0,
          total: emptyTotals(valid ? periodLabel(date, mode) : 'Unknown date'),
          models: new Map()
        });
      }

      const bucket = buckets.get(key);
      bucket.count++;
      addTotals(bucket.total, record.usage, record.cost, record.credits);
      for (const contribution of record.models) {
        const modelKey = contribution.provider + ':' + contribution.model;
        if (!bucket.models.has(modelKey)) {
          bucket.models.set(modelKey,
            emptyTotals(contribution.label || contribution.model, contribution.provider));
        }
        addTotals(bucket.models.get(modelKey), contribution.usage,
          contribution.cost, contribution.credits);
      }
    }

    // Sorted on the raw key, not the localized label: "Sep 2" reads after
    // "Sep 10" alphabetically, and months would sort by name.
    const ordered = [...buckets.values()].sort((a, b) => {
      if (a.key === '') return 1;
      if (b.key === '') return -1;
      return a.key.localeCompare(b.key);
    });
    const dated = ordered.filter(bucket => bucket.key !== '');
    const unknown = buckets.get('');
    const sessions = ordered.reduce((sum, bucket) => sum + bucket.count, 0);

    if (mode === 'day') {
      renderCalendar(dated);
      periodGrid.hidden = true;
      periodCalendar.hidden = dated.length === 0;
      if (!dated.length) {
        periodNote.textContent = unknown
          ? 'No dated sessions; ' + unknown.count + ' with no date.'
          : 'No sessions in this range.';
      } else {
        const notes = [sessions + (sessions === 1 ? ' session' : ' sessions') +
          ' across ' + dated.length + (dated.length === 1 ? ' day' : ' days') +
          ', dates in local time'];
        if (unknown) notes.push(unknown.count + ' with no date');
        periodNote.textContent = notes.join('; ');
      }
      return;
    }

    periodCalendar.hidden = true;
    periodGrid.hidden = false;
    const rows = ordered.map(bucket => periodRow(bucket) + modelDetails(bucket));

    // The header is the grid's first child; everything after it is re-rendered.
    while (periodGrid.children.length > 1) periodGrid.lastElementChild.remove();
    periodGrid.insertAdjacentHTML('beforeend', rows.join(''));
    periodNote.textContent = ordered.length
      ? sessions + ' sessions, dates in local time'
      : 'No sessions in this range.';
  }

  for (const input of document.querySelectorAll('input[name="period-mode"]')) {
    input.addEventListener('change', renderPeriods);
  }
  for (const input of [periodStart, periodEnd]) {
    input.addEventListener('change', renderPeriods);
  }
  document.getElementById('period-clear').addEventListener('click', () => {
    periodStart.value = '';
    periodEnd.value = '';
    renderPeriods();
  });
  // Delegated, since re-rendering replaces the calendar's cells.
  periodCalendar.addEventListener('click', event => {
    const button = event.target.closest('button.cal-day');
    if (!button || !button.dataset.day) return;
    const detail = periodCalendar.querySelector(
      '[data-detail="' + button.dataset.day + '"]');
    if (!detail) return;
    detail.hidden = !detail.hidden;
    button.setAttribute('aria-expanded', String(!detail.hidden));
  });
  renderPeriods();
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
