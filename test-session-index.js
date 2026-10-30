// Checks the session picker: what it finds under ~/.claude/projects/, what it
// reports about each session, and that the table it renders sorts on the values
// rather than on the formatted text.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  findSessionFiles, listSessions, renderPage, formatBytes, formatCost,
  formatDuration, projectLabel
} = require('./session-index.js');

let failures = 0;
function check(name, actual, expected) {
  try {
    assert.deepStrictEqual(actual, expected);
    console.log(`ok   ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${name}`);
    console.log(`  actual:   ${JSON.stringify(actual)}`);
    console.log(`  expected: ${JSON.stringify(expected)}`);
  }
}

// The picker takes its readers as dependencies, so the tests can supply the
// same ones index.js does without importing the CLI itself.
const deps = {
  readJsonlFile: (file) => fs.readFileSync(file, 'utf-8').trim().split('\n')
    .filter(Boolean).map(line => JSON.parse(line)),
  readSubagents: (sessionFile) => {
    const dir = path.join(path.dirname(sessionFile), path.basename(sessionFile, '.jsonl'),
      'subagents');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(name => name.endsWith('.jsonl')).map(name => ({
      entries: fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n')
        .filter(Boolean).map(line => JSON.parse(line))
    }));
  },
  sessionTitle: (entries) => {
    const titled = [...entries].reverse().find(e => e.type === 'ai-title');
    return titled ? titled.aiTitle : 'Main conversation';
  },
  conversationEntries: (entries) =>
    entries.filter(e => e.type === 'user' || e.type === 'assistant'),
  totalCost: (messages) => messages.length * 0.5
};

// A throwaway ~/.claude/projects/ to scan, so the tests do not depend on what
// the machine running them happens to have in its own.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-profiler-test-'));

function writeSession(project, id, entries, subagents = []) {
  const dir = path.join(root, project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.jsonl`),
    entries.map(e => JSON.stringify(e)).join('\n') + '\n'
  );

  if (subagents.length > 0) {
    const agentDir = path.join(dir, id, 'subagents');
    fs.mkdirSync(agentDir, { recursive: true });
    subagents.forEach((body, i) => {
      fs.writeFileSync(path.join(agentDir, `agent-${i}.jsonl`), body);
    });
  }
}

const at = (minutes) =>
  new Date(Date.UTC(2026, 0, 1, 12, minutes)).toISOString();

// A session with two API calls a minute apart, in a project with a sub-agent.
writeSession('-Users-me-buildgit-alpha', 'aaaa', [
  { type: 'user', message: { role: 'user', content: 'hi' },
    timestamp: at(0), cwd: '/Users/me/buildgit/alpha', gitBranch: 'main' },
  { type: 'assistant', requestId: 'request-1', timestamp: at(1), cwd: '/Users/me/buildgit/alpha',
    gitBranch: 'main', message: { role: 'assistant', content: 'yo', model: 'claude-test',
      usage: { input_tokens: 10, output_tokens: 2,
        cache_creation_input_tokens: 3, cache_read_input_tokens: 85 } } },
  { type: 'ai-title', aiTitle: 'Alpha session' }
], [
  `${JSON.stringify({ type: 'assistant', requestId: 'agent-request-1', message: {
    role: 'assistant', model: 'claude-test', usage: { input_tokens: 1, output_tokens: 1 }
  } })}\n`,
  `${JSON.stringify({ type: 'assistant', requestId: 'agent-request-2', message: {
    role: 'assistant', model: 'claude-test', usage: { input_tokens: 2, output_tokens: 1 }
  } })}\n`
]);

// A newer session, in a different project, with a long idle gap in the middle.
writeSession('-Users-me-buildgit-beta', 'bbbb', [
  { type: 'user', message: { role: 'user', content: 'go' },
    timestamp: at(60), cwd: '/Users/me/buildgit/beta', gitBranch: 'topic' },
  // Two hours later: the session was left open, which is not working time.
  { type: 'assistant', message: { role: 'assistant', content: 'done' },
    timestamp: at(180), cwd: '/Users/me/buildgit/beta', gitBranch: 'topic' },
  { type: 'ai-title', aiTitle: 'Beta session' }
]);

// Nothing but metadata: opened and abandoned, so it is not worth listing.
writeSession('-Users-me-buildgit-beta', 'empty', [
  { type: 'mode', timestamp: at(200) }
]);

// A file that is not valid JSONL, as a session being written to can be.
fs.writeFileSync(path.join(root, '-Users-me-buildgit-beta', 'broken.jsonl'),
  '{"type":"user"\nnot json at all\n');

check('finds every session file, and only those',
  findSessionFiles(root).map(f => path.basename(f.file)).sort(),
  ['aaaa.jsonl', 'bbbb.jsonl', 'broken.jsonl', 'empty.jsonl']);

const sessions = listSessions(deps, { root });

check('lists the sessions that have messages, most recently active first',
  sessions.map(s => s.title),
  ['Beta session', 'Alpha session']);

check('a session with no messages is left out',
  sessions.some(s => s.id === 'empty'), false);

check('an unparseable session does not break the listing',
  sessions.some(s => s.id === 'broken'), false);

const alpha = sessions.find(s => s.id === 'aaaa');

check('reports the working directory and branch from the entries',
  [alpha.cwd, alpha.gitBranch], ['/Users/me/buildgit/alpha', 'main']);

check('counts the conversation messages, not every entry',
  [alpha.messages, alpha.entries], [2, 3]);

check('counts the sub-agent transcripts', alpha.subagents, 2);

check('collects Claude token usage by model',
  [alpha.usage, alpha.models], [{
    input_tokens: 13, cache_creation_input_tokens: 3,
    cache_read_input_tokens: 85, output_tokens: 4
  }, { 'claude-test': {
    input_tokens: 13, cache_creation_input_tokens: 3,
    cache_read_input_tokens: 85, output_tokens: 4, cost: 1.5
  } }]);

// Wall clock would call this a two hour session; only the first minute of it
// was the session doing anything.
check('active time ignores the gaps where nothing happened',
  formatDuration(sessions.find(s => s.id === 'bbbb').active), '—');

check('active time counts a gap short enough to be work',
  formatDuration(alpha.active), '1m');

check('size includes the sub-agent transcripts',
  alpha.bytes > fs.statSync(alpha.file).size, true);

check('formats bytes', [formatBytes(512), formatBytes(2048), formatBytes(5 << 20)],
  ['512 B', '2 KB', '5.0 MB']);

check('formats cost, and says nothing for a free session',
  [formatCost(0), formatCost(0.004), formatCost(12.5)], ['—', '<$0.01', '$12.50']);

check('large usage totals are compact but retain their exact value', (() => {
  const page = renderPage([{ ...sessions[0], usage: {
    input_tokens: 1234567, output_tokens: 0,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 0
  } }]);
  return page.includes('title="1,234,567 tokens">1.2M</div>');
})(), true);

check('formats a duration in hours and minutes', formatDuration(3900000), '1h 5m');

check('turns a project directory name back into a path',
  projectLabel('-Users-me-buildgit-alpha'), '/Users/me/buildgit/alpha');

// --- The rendered page -----------------------------------------------------

const html = renderPage(sessions);

// The bug this catches: `data-sort-0` reads back as dataset['sort-0'], so the
// page's `dataset['sort' + column]` found nothing and no column ever sorted.
const sortAttributes = [...html.matchAll(/data-sort(\d+)=/g)].map(m => m[1]);
check('rows carry the sort keys the script reads',
  [...new Set(sortAttributes)].sort(), ['0', '1', '2', '3', '4', '5', '6', '7', '8']);

check('the script reads the attribute the rows actually carry',
  html.includes("getAttribute('data-sort' + column)"), true);

// Sorting has to be on the numbers: "9 MB" sorts above "10 MB" as text.
const costKeys = [...html.matchAll(/data-sort7="([^"]*)"/g)].map(m => m[1]);
check('the cost sort key is the raw number, not the formatted figure',
  costKeys.every(k => k !== '' && !isNaN(k)), true);

check('the size sort key is a byte count',
  [...html.matchAll(/data-sort6="([^"]*)"/g)].map(m => m[1]).every(k => !isNaN(k)),
  true);

check('the date column sorts on when the session was last active',
  [...html.matchAll(/data-sort2="([^"]*)"/g)].map(m => m[1]),
  [sessions[0].ended, sessions[1].ended]);

check('the model column lists the models a session used, sub-agents included',
  [...html.matchAll(/<td class="model">([^<]*(?:<br>[^<]*)*)<\/td>/g)].map(m => m[1]),
  ['—', 'claude-test']);

// The first sort() call must not reverse a sort that has not happened yet.
check('no column is marked sorted before the first sort',
  html.includes('let sortColumn = -1'), true);

check('every row has a button carrying its session id',
  [...html.matchAll(/data-id="([^"]+)"/g)].map(m => m[1]).sort(),
  ['claude:aaaa', 'claude:bbbb']);

check('the page offers the --size option', html.includes('id="size"'), true);

check('narrow columns show compact counts, with the exact figure as a tooltip',
  renderPage([{ ...sessions[0], messages: 7578 }])
    .includes('<td class="num" title="7,578 messages">7.6K</td>'), true);

check('narrow columns have short headers, named in full as tooltips',
  /title="Messages">Msgs<\/th>[\s\S]*title="Sub-agents">Agents<\/th>/.test(html), true);

check('the last activity is shown as how long ago, with the date as tooltip',
  html.includes("return minutes + ' min ago'") && html.includes('cell.title = date.toLocaleString'),
  true);

check('rows carry no provider badge', html.includes('class="provider'), false);

check('a Codex row names its model, reports cost, and offers its profiler', (() => {
  const page = renderPage([{
    ...sessions[0], provider: 'codex', id: 'codex', tokens: 1234,
    credits: 12.5, cost: 1.25,
    profileAvailable: true, usage: {
      input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 34,
      reasoning_output_tokens: 12
    }, models: { 'gpt-test': { input_tokens: 1200, output_tokens: 34 } }
  }]);
  return page.includes('<td class="model">gpt-test</td>') &&
    page.includes('>$1.25</td>') && page.includes('data-id="codex:codex"') &&
    !page.includes('Codex tokens') && !page.includes('Codex credits');
})(), true);

check('usage totals include overall and provider breakdowns', (() => {
  const page = renderPage([
    { ...sessions[0], cost: 2, usage: {
      input_tokens: 100, output_tokens: 20,
      cache_creation_input_tokens: 50, cache_read_input_tokens: 850
    }, models: { 'claude-test': {
      input_tokens: 100, output_tokens: 20,
      cache_creation_input_tokens: 50, cache_read_input_tokens: 850
    } } },
    { ...sessions[1], provider: 'codex', id: 'codex-usage', cost: 1, usage: {
      input_tokens: 1000, cached_input_tokens: 800,
      cache_write_input_tokens: 0, output_tokens: 30
    }, models: { 'gpt-test': {
      input_tokens: 1000, cached_input_tokens: 800,
      cache_write_input_tokens: 0, output_tokens: 30
    } } }
  ]);
  return page.includes('aria-label="Usage totals"') &&
    /usage-total[\s\S]*?>Total<[\s\S]*?\$3\.00[\s\S]*?>—<[\s\S]*?>2,000<[\s\S]*?>50<[\s\S]*?>350<[\s\S]*?input-minus-cache-read estimates">≈250<[\s\S]*?>1,650<[\s\S]*?>82\.5%</.test(page) &&
    page.includes('usage-provider claude') && page.includes('usage-provider codex');
})(), true);

check('Codex retains an estimated cache-write fallback without API groups', (() => {
  const page = renderPage([{ ...sessions[0], provider: 'codex', id: 'codex-cache',
    usage: { input_tokens: 1000, cached_input_tokens: 800,
      cache_write_input_tokens: 0, output_tokens: 30 } }]);
  return /usage-provider codex[\s\S]*?>Codex<[\s\S]*?\$1\.00[\s\S]*?>—<[\s\S]*?>1,000<[\s\S]*?>30<[\s\S]*?>200<[\s\S]*?input-minus-cache-read estimates">≈200<[\s\S]*?>800</.test(page);
})(), true);

check('Codex totals use Enterprise API credits and breakdowns', (() => {
  const billingUsage = {
    input_tokens: 1000, cached_input_tokens: 800, net_new_input_tokens: 200,
    cache_write_input_tokens: null, output_tokens: 25, total_tokens: 1025
  };
  const page = renderPage([{ ...sessions[0], provider: 'codex', id: 'codex-api',
    cost: 2, credits: 28.5, billingUsage, billingModels: {
      'gpt-enterprise': { ...billingUsage, cost: 2, credits: 28.5 }
    } }]);
  return /usage-provider codex[\s\S]*?>Codex<[\s\S]*?\$2\.00[\s\S]*?28\.5 Enterprise credits">28\.5<[\s\S]*?>1,000<[\s\S]*?>25<[\s\S]*?>200<[\s\S]*?Enterprise API net-new input">200<[\s\S]*?>800</.test(page) &&
    /usage-model[\s\S]*?gpt-enterprise[\s\S]*?28\.5 Enterprise credits">28\.5<[\s\S]*?Enterprise API net-new input">200</.test(page);
})(), true);

check('the effective rate amortizes cost over all input and output tokens', (() => {
  const page = renderPage([{ ...sessions[0], cost: 3, usage: {
    input_tokens: 400000, output_tokens: 100000,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 500000
  } }]);
  return page.includes('>Est. $/M</div>') &&
    page.includes('title="$3.0000 over 1,000,000 total tokens">$3.00/M</div>');
})(), true);

check('the effective rate is unavailable when none of the tokens have billing data', (() => {
  const page = renderPage([{ ...sessions[0], provider: 'codex', cost: null,
    usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 30 } }]);
  const row = page.match(/usage-total[\s\S]*?<div class="usage-group/)[0];
  return row.includes('title="No billing data for these tokens">—</div>');
})(), true);

// The usage table's model rows, which come after every provider row.
const modelRows = page => page.slice(page.indexOf('usage-row usage-model'),
  page.indexOf('</section>'));

check('empty synthetic and unknown models are omitted', (() => {
  const page = renderPage([{ ...sessions[0], cost: 0, usage: {}, models: {
    '<synthetic>': {}, 'Unknown model': {}
  } }]);
  return !page.includes('&lt;synthetic&gt;') && !page.includes('Unknown model');
})(), true);

check('unpriced sessions add their tokens to model rows but no cost', (() => {
  const model = { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 10 };
  const page = renderPage([
    { ...sessions[0], provider: 'codex', id: 'priced', cost: 1,
      usage: model, models: { 'gpt-test': model } },
    { ...sessions[1], provider: 'codex', id: 'unpriced', cost: null,
      usage: { input_tokens: 9000, cached_input_tokens: 8000, output_tokens: 90 },
      models: { 'gpt-test': {
        input_tokens: 9000, cached_input_tokens: 8000, output_tokens: 90
      } } }
  ]);
  const rows = modelRows(page);
  return rows.includes('title="10,000 tokens">10K') &&
    rows.includes('title="Some costs are unavailable">$1.00');
})(), true);

check('a model without its own cost gets what the others leave of the session cost', (() => {
  const page = renderPage([{ ...sessions[0], provider: 'codex', cost: 8,
    usage: { input_tokens: 200, output_tokens: 20 }, models: {
      'gpt-a': { input_tokens: 100, output_tokens: 10, cost: 5 },
      'gpt-b': { input_tokens: 100, output_tokens: 10 }
    } }]);
  const rows = modelRows(page);
  return rows.includes('>$5.00</div>') && rows.includes('>$3.00</div>');
})(), true);

check('a provider row expands into its model rows, without the claude- prefix', (() => {
  const page = renderPage([{ ...sessions[0], model: 'claude-test', cost: 2,
    usage: { input_tokens: 10, output_tokens: 2 },
    models: { 'claude-test': { input_tokens: 10, output_tokens: 2 } } }]);
  const start = page.indexOf('<section class="usage-summary"');
  const summary = page.slice(start, page.indexOf('</section>', start));
  return /<div class="usage-group" role="rowgroup"[^>]*>\s*<div class="usage-row usage-provider claude" role="row" [^>]*tabindex="0" aria-expanded="false">/.test(page) &&
    /usage-model"[^>]*>\s*<div class="usage-label" role="rowheader">test</.test(page) &&
    !summary.includes('<details');
})(), true);

check('providers with no usage are not listed', (() => {
  const page = renderPage([{ ...sessions[0], cost: 2,
    usage: { input_tokens: 10, output_tokens: 2 },
    models: { 'claude-test': { input_tokens: 10, output_tokens: 2 } } }]);
  return page.includes('usage-provider claude') && !page.includes('usage-provider codex') &&
    !page.includes('usage-provider dsh');
})(), true);

check('the usage header sorts the provider groups and every usage column', (() => {
  const page = renderPage([{ ...sessions[0], model: 'claude-test', cost: 2,
    usage: { input_tokens: 10, output_tokens: 2 },
    models: { 'claude-test': { input_tokens: 10, output_tokens: 2 } } }]);
  const headers = [...page.matchAll(/data-usage-column="(\d+)"/g)].map(match => +match[1]);
  const rows = [...page.matchAll(
    /<div class="usage-(?:group|row usage-(?:provider|model))[^"]*" role="row(?:group)?" ([^>]+)>/g
  )].map(match => match[1]);
  return JSON.stringify(headers) === JSON.stringify([...Array(10).keys()]) &&
    rows.length === 3 && rows.every(attributes => [...Array(10).keys()].every(index =>
      attributes.includes(`data-usage-sort${index}=`))) &&
    page.includes("document.querySelectorAll('.usage-group')");
})(), true);

// --- Usage over time -------------------------------------------------------

// The aggregation is a menu item, not a headline: closed, and above the fixed
// summary, so the totals the page always showed stay where they were.
check('the usage-over-time panel is near the top and closed by default', (() => {
  const panel = html.indexOf('<details class="period-panel">');
  const summary = html.indexOf('<section class="usage-summary"');
  return panel !== -1 && panel < summary && !/class="period-panel"[^>]*\sopen/.test(html);
})(), true);

check('the panel offers day, month, half-year and total buckets', (() => {
  const panel = html.match(
    /<details class="period-panel">[\s\S]*?<div class="period-grid"/)[0];
  return ['value="day"', 'value="month"', 'value="half"', 'value="total"',
    'value="month" checked', 'id="period-start"', 'id="period-end"']
    .every(needle => panel.includes(needle));
})(), true);

// The browser sums these records, so they carry provider-normalized usage and
// the model split the server already resolved.
check('the page embeds a normalized usage record per session', (() => {
  const raw = html.match(
    /<script type="application\/json" id="period-data">([\s\S]*?)<\/script>/)[1];
  const data = JSON.parse(raw);
  const alpha = data.find(record => record.provider === 'claude' &&
    record.models.some(model => model.model === 'claude-test'));
  return data.length === sessions.length && alpha !== undefined &&
    alpha.usage.input === 13 + 3 + 85 && alpha.usage.output === 4 &&
    alpha.usage.newInput === 16 &&
    alpha.cost === sessions.find(session => session.id === 'aaaa').cost;
})(), true);

// A `<` inside the JSON — a model name, say — must not be able to close the
// script block it lives in.
check('the embedded period data escapes angle brackets', (() => {
  const page = renderPage([{ ...sessions[0], model: '<script>alert(1)</script>',
    cost: 1, usage: { input_tokens: 1, output_tokens: 1 },
    models: { '<script>alert(1)</script>': { input_tokens: 1, output_tokens: 1 } } }]);
  const raw = page.match(
    /<script type="application\/json" id="period-data">([\s\S]*?)<\/script>/)[1];
  return !/[<>]/.test(raw) &&
    JSON.parse(raw)[0].models[0].model === '<script>alert(1)</script>';
})(), true);

// The summary's sorter reorders .usage-group elements and the .usage-model rows
// inside them, so period rows carry classes of their own and a grid of their
// own: sweeping one into the other would reorder the wrong table.
check('period rows stay out of the summary sorter', (() => {
  const panel = html.slice(html.indexOf('<details class="period-panel">'),
    html.indexOf('<section class="usage-summary"'));
  return !/class="[^"]*\b(?:usage-grid|usage-group|usage-model)\b/.test(panel) &&
    panel.includes('class="period-grid"') &&
    html.includes("usageRow(model, 'period-model ' + model.provider)") &&
    html.includes("usageRow(bucket.total, 'usage-period')");
})(), true);

check('the period table reuses the server usage helpers', (() => {
  return html.includes('function usageCells(total)') &&
    html.includes('function addTotals(total, usage, cost = 0, credits = null)') &&
    html.includes('function mergeTotals(target, source)') &&
    html.includes('function periodRow(bucket)');
})(), true);

// The panel is outside .usage-summary, so it has to bring the grid columns
// with it or its rows lose every column but the first.
check('the period panel defines the usage columns it inherits', (() => {
  const panel = html.slice(html.indexOf('.period-panel {'),
    html.indexOf('.period-controls {'));
  return panel.includes('--usage-columns:');
})(), true);

// --- The day calendar ------------------------------------------------------

// Day mode is a calendar, which means it replaces the day list rather than
// adding to it; both bodies start out of the way and the script picks one.
check('the calendar is a separate, hidden body until day mode asks for it', (() => {
  return /id="period-calendar"[^>]*hidden/.test(html) &&
    html.includes('if (mode === \'day\')') &&
    html.includes('periodGrid.hidden = true') &&
    html.includes('.period-grid[hidden], .calendar[hidden] { display: none; }');
})(), true);

check('the calendar stacks Monday-first weeks, weekend only when needed', (() => {
  const script = html.slice(html.indexOf('<script>'));
  return script.includes('const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];') &&
    script.includes('WEEKDAY_ORDER.slice(0, 5)') &&
    script.includes("'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'") &&
    script.includes('--cal-columns');
})(), true);

check('a day cell opens its full usage row and per-model breakdown', (() => {
  const script = html.slice(html.indexOf('<script>'));
  return script.includes('function dayDetail(bucket)') &&
    script.includes("usageRow(bucket.total, 'usage-period')") &&
    script.includes('function modelDetails(bucket)') &&
    script.includes("event.target.closest('button.cal-day')");
})(), true);

// The page script is assembled from template strings and serialized functions,
// so a stray backtick or brace is a syntax error only the browser would see.
check('the generated page script compiles', (() => {
  new Function(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  return true;
})(), true);

check('a title with markup in it is escaped', (() => {
  writeSession('-Users-me-buildgit-x', 'xss', [
    { type: 'user', message: { role: 'user', content: 'hi' }, timestamp: at(0) },
    { type: 'ai-title', aiTitle: '<script>alert(1)</script>' }
  ]);
  const page = renderPage(listSessions(deps, { root }));
  fs.rmSync(path.join(root, '-Users-me-buildgit-x'), { recursive: true });
  return page.includes('<script>alert(1)</script>');
})(), false);

// Projects keep their colour when the table is re-sorted, so a row's hue means
// the same thing wherever it lands.
const slots = sessions.map(s => s.colorSlot);
check('each project gets its own colour slot',
  new Set(slots).size, new Set(sessions.map(s => s.cwd)).size);

check('colour follows the project, not the row order', (() => {
  const reversed = renderPage([...sessions].reverse());
  const forOne = (page, id) =>
    page.match(new RegExp(`<tbody [^>]*>(?:(?!</tbody>)[\\s\\S])*?data-id="claude:${id}"`))[0]
      .match(/class="dot (s\d)"/)[1];
  return forOne(html, 'aaaa') === forOne(reversed, 'aaaa');
})(), true);

// --- The two-row layout ----------------------------------------------------

// Each session is one <tbody>, so the sort moves its figures and its path
// together; two <tr>s in a shared <tbody> cannot be torn apart by a re-sort.
check('each session is a group of its own',
  (html.match(/<tbody /g) || []).length, sessions.length);

check('the sort keys are on the group, not on a row',
  /<tr [^>]*data-sort0=/.test(html), false);

check('the script reorders the groups', html.includes('table.append(...sorted)'),
  true);

// The path spans the columns rather than living in the title cell, which is a
// few characters wide in a narrow window and breaks a path down it.
check('the path is a full-width row under the figures',
  new RegExp(`<tr class="path">\\s*<td colspan="${
    ['Session','Model','Last active','Active','Messages','Sub-agents','Size','Cost','']
      .length - 3}"`).test(html), true);

check('the path row carries the working directory and branch',
  /<tr class="path">\s*<td[^>]*>\/Users\/me\/buildgit\/alpha · main</.test(html),
  true);

// The bar is on the second line spanning Size and Cost, where it has the width
// of both columns rather than the sliver left beside a four-figure number.
check('the cost bar spans the two numeric columns',
  /<td class="meter" colspan="2">/.test(html), true);

// The legend carries a swatch of every band, so the rows are what is checked.
check('a row is banded by what its session cost', (() => {
  const rows = [...html.matchAll(/<td class="meter"[^>]*>\s*<span class="bar (\w+)"/g)]
    .map(m => m[1]);
  return [...new Set(rows)];
})(), ['cheap']);

// $0 to $200+ crosses every threshold, in order.
check('the bands rise with the cost', (() => {
  const { renderPage: render } = require('./session-index.js');
  const priced = [0.5, 25, 80, 500].map((cost, i) => ({
    ...sessions[0], id: `p${i}`, cwd: `/p${i}`, cost
  }));
  return [...render(priced).matchAll(
    /<td class="meter"[^>]*>\s*<span class="bar (\w+)"/g)].map(m => m[1]);
})(), ['cheap', 'good', 'warning', 'critical']);

// --- The click handler -----------------------------------------------------

// Building a profile takes seconds, and by the time the fetch resolves the
// click is no longer user activation — a popup opened then is the browser's to
// block. The tab has to be opened while the click is still running.
check('the tab is opened before the profile is awaited', (() => {
  const script = html.slice(html.indexOf('<script>'));
  const opened = script.indexOf("window.open('', '_blank')");
  const fetched = script.indexOf("await fetch(");
  return opened !== -1 && opened < fetched;
})(), true);

check('a blocked popup falls back to this window',
  html.includes('window.location = url'), true);

// The server decodes the id, so the client has to encode it.
check('the session id is encoded into the request URL',
  html.includes("encodeURIComponent(button.dataset.id)"), true);

// A call with usage but no requestId costs nothing in totalCost, so its tokens
// stay out of the model breakdown too.
fs.mkdirSync(path.join(root, '-Users-me-buildgit-norequest'));
const noRequestRoot = path.join(root, '-Users-me-buildgit-norequest');
fs.writeFileSync(path.join(noRequestRoot, 'nnnn.jsonl'), [
  { type: 'user', message: { role: 'user', content: 'hi' }, timestamp: at(0) },
  { type: 'assistant', requestId: 'request-1', timestamp: at(1), message: { role: 'assistant',
    model: 'claude-test', usage: { input_tokens: 10, output_tokens: 2 } } },
  { type: 'assistant', uuid: 'u3', timestamp: at(2), message: { role: 'assistant',
    model: 'claude-test', usage: { input_tokens: 1000, output_tokens: 200 } } }
].map(e => JSON.stringify(e)).join('\n') + '\n');
check('calls without a requestId add no model tokens',
  listSessions(deps, { root }).find(session => session.id === 'nnnn').models['claude-test']
    .input_tokens, 10);

fs.rmSync(root, { recursive: true, force: true });

// An untitled session is named after the first line of its first prompt.
const { readJsonlFile, promptTitle } = require('./session-util.js');
check('a prompt title is the first line, its spacing collapsed',
  promptTitle('  Fix   the thing\nwith more detail'), 'Fix the thing');
check('a prompt title is cut at 300 characters',
  promptTitle('x'.repeat(400)), `${'x'.repeat(300)}…`);

// A session being written to can be read halfway through its last line.
const partial = path.join(os.tmpdir(), `claude-profiler-partial-${process.pid}.jsonl`);
fs.writeFileSync(partial, '{"a":1}\n{"b":2}\n{"c":');
check('a half-written last line is skipped', readJsonlFile(partial), [{ a: 1 }, { b: 2 }]);
fs.writeFileSync(partial, '{"a":1}\n{"b":\n{"c":3}\n');
check('a corrupt line before the last one still throws',
  (() => { try { readJsonlFile(partial); return false; } catch { return true; } })(), true);
fs.rmSync(partial);

// --- Opening a browser -----------------------------------------------------

// A missing opener makes spawn emit 'error' asynchronously rather than throw,
// so a try/catch around it never fires and the unhandled event takes the whole
// server down. This is that shape, run for real against a command that does
// not exist.
const openUrlCheck = (async () => {
  const { spawn } = require('child_process');

  // The same contract index.js's openUrl has: resolve false rather than throw
  // or die, so the caller can print the URL instead.
  function openUrl(url, command) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(command, [url], { detached: true, stdio: 'ignore' });
      } catch {
        return resolve(false);
      }
      child.on('error', () => resolve(false));
      child.on('spawn', () => { child.unref(); resolve(true); });
    });
  }

  check('a missing browser opener resolves false instead of crashing',
    await openUrl('http://127.0.0.1/', 'claude-profiler-no-such-opener'), false);

  check('an opener that runs resolves true',
    await openUrl('--version', 'echo'), true);

  // index.js has to use that shape, not a bare try/catch.
  const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf-8');
  check('index.js listens for the spawn error event',
    /child\.on\('error'/.test(source), true);

  console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
