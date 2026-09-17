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

function formatTokens(tokens) {
  if (!(tokens > 0)) return '—';
  return Math.round(tokens).toLocaleString('en-US');
}

function formatCredits(credits) {
  if (!Number.isFinite(credits)) return '—';
  if (credits !== 0 && Math.abs(credits) < 0.01) {
    return credits.toFixed(6).replace(/0+$/, '');
  }
  return credits.toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });
}

function usageTitle(session) {
  if (!session.usage) return '';
  const uncached = Math.max(0,
    (session.usage.input_tokens || 0) - (session.usage.cached_input_tokens || 0));
  return [
    `Uncached input: ${formatTokens(uncached)}`,
    `Cached input: ${formatTokens(session.usage.cached_input_tokens)}`,
    `Output (including reasoning): ${formatTokens(session.usage.output_tokens)}`,
    `Reasoning portion: ${formatTokens(session.usage.reasoning_output_tokens)}`
  ].join(' · ');
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
    `<td class="num tokens" title="${escapeHtml(usageTitle(session))}">${formatTokens(session.tokens)}</td>`,
    `<td class="num credits">${formatCredits(session.credits)}</td>`,
    `<td class="num cost">${formatCost(session.cost)}</td>`,
    `<td class="action">
       ${session.profileAvailable === false
         ? '<span class="unavailable">—</span>'
         : `<button type="button" data-id="${escapeHtml(session.id)}">Profiler</button>`}
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
    session.tokens ?? '',
    session.credits ?? '',
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
  { label: 'Codex tokens', className: 'num tokens' },
  { label: 'Codex credits', className: 'num credits' },
  { label: 'Est. cost', className: 'num cost' },
  { label: '', className: 'action', unsortable: true }
];

function renderPage(sessions, { size = false, host = null } = {}) {
  const header = COLUMNS.map((column, i) =>
    column.unsortable
      ? `<th class="${column.className}"></th>`
      : `<th class="${column.className}" data-column="${i}">${escapeHtml(column.label)}</th>`
  ).join('');

  assignProjectColors(sessions);

  const claudeCost = sessions.filter(session => session.provider !== 'codex')
    .reduce((sum, session) => sum + (session.cost || 0), 0);
  const codexCost = sessions.filter(session => session.provider === 'codex')
    .reduce((sum, session) => sum + (session.cost || 0), 0);
  const totalCredits = sessions.reduce((sum, session) => sum + (session.credits || 0), 0);
  const totalTokens = sessions.reduce((sum, session) => sum + (session.tokens || 0), 0);
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
  <strong>${formatBytes(totalBytes)}</strong> ·
  <strong class="total">${formatCost(claudeCost)}</strong> Claude ·
  <strong>${formatCredits(totalCredits)}</strong> Codex credits ·
  <strong class="total">${formatCost(codexCost)}</strong> Codex ·
  <strong>${formatTokens(totalTokens)}</strong> Codex tokens
</div>

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

    const size = document.getElementById('size').checked;
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
  formatTokens,
  formatCredits,
  formatDuration,
  projectLabel
};
