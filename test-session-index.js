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
  [...new Set(sortAttributes)].sort(), ['0', '1', '2', '3', '4', '5', '6', '7']);

check('the script reads the attribute the rows actually carry',
  html.includes("getAttribute('data-sort' + column)"), true);

// Sorting has to be on the numbers: "9 MB" sorts above "10 MB" as text.
const costKeys = [...html.matchAll(/data-sort6="([^"]*)"/g)].map(m => m[1]);
check('the cost sort key is the raw number, not the formatted figure',
  costKeys.every(k => k !== '' && !isNaN(k)), true);

check('the size sort key is a byte count',
  [...html.matchAll(/data-sort5="([^"]*)"/g)].map(m => m[1]).every(k => !isNaN(k)),
  true);

check('the date column sorts on when the session started',
  [...html.matchAll(/data-sort1="([^"]*)"/g)].map(m => m[1]),
  [sessions[0].started, sessions[1].started]);

// The first sort() call must not reverse a sort that has not happened yet.
check('no column is marked sorted before the first sort',
  html.includes('let sortColumn = -1'), true);

check('every row has a button carrying its session id',
  [...html.matchAll(/data-id="([^"]+)"/g)].map(m => m[1]).sort(),
  ['claude:aaaa', 'claude:bbbb']);

check('the page offers the --size option', html.includes('id="size"'), true);

check('Claude rows are labeled', html.includes('provider claude">Claude'), true);

check('a Codex row is labeled, reports cost, and offers its profiler', (() => {
  const page = renderPage([{
    ...sessions[0], provider: 'codex', id: 'codex', tokens: 1234,
    credits: 12.5, cost: 1.25,
    profileAvailable: true, usage: {
      input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 34,
      reasoning_output_tokens: 12
    }
  }]);
  return page.includes('provider codex">Codex') &&
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
    /usage-model codex[\s\S]*?gpt-enterprise[\s\S]*?28\.5 Enterprise credits">28\.5<[\s\S]*?Enterprise API net-new input">200</.test(page);
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
  const row = page.match(/usage-total[\s\S]*?<\/div>\s*<div class="usage-row usage-provider/)[0];
  return row.includes('title="No billing data for these tokens">—</div>');
})(), true);

check('empty synthetic and unknown models are omitted', (() => {
  const page = renderPage([{ ...sessions[0], cost: 0, usage: {}, models: {
    '<synthetic>': {}, 'Unknown model': {}
  } }]);
  return !page.includes('&lt;synthetic&gt;') && !page.includes('Unknown model');
})(), true);

check('unpriced sessions are excluded consistently from model cost rows', (() => {
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
  const details = page.match(/<details class="usage-models">([\s\S]*?)<\/details>/)[1];
  return details.includes('>1,000</div>') && !details.includes('>10,000</div>');
})(), true);

check('the per-model usage breakdown is collapsible', (() => {
  const page = renderPage([{ ...sessions[0], model: 'claude-test', cost: 2,
    usage: { input_tokens: 10, output_tokens: 2 },
    models: { 'claude-test': { input_tokens: 10, output_tokens: 2 } } }]);
  return page.includes('<details class="usage-models">') &&
    page.includes('<div class="usage-model-grid">') &&
    page.includes('By model (1)') && page.includes('claude-test');
})(), true);

check('provider and model headers sort every usage column independently', (() => {
  const page = renderPage([{ ...sessions[0], model: 'claude-test', cost: 2,
    usage: { input_tokens: 10, output_tokens: 2 },
    models: { 'claude-test': { input_tokens: 10, output_tokens: 2 } } }]);
  const headers = target => [...page.matchAll(new RegExp(
    `data-usage-column="(\\d+)" data-usage-target="${target}"`, 'g'
  ))].map(match => +match[1]);
  const rows = [...page.matchAll(
    /<div class="usage-row usage-(?:provider|model)[^"]*" role="row" ([^>]+)>/g
  )].map(match => match[1]);
  return JSON.stringify(headers('providers')) === JSON.stringify([...Array(10).keys()]) &&
    JSON.stringify(headers('models')) === JSON.stringify([...Array(10).keys()]) &&
    rows.every(attributes => [...Array(10).keys()].every(index =>
      attributes.includes(`data-usage-sort${index}=`))) &&
    page.includes("target === 'providers' ? '.usage-provider' : '.usage-model'") &&
    page.includes('grid.insertBefore(row, details)');
})(), true);

check('model rows use a nested grid instead of making details a subgrid',
  html.includes('.usage-models {\n    display: grid;'), false);

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
    ['Session','Started','Active','Messages','Sub-agents','Size','Cost','']
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

fs.rmSync(root, { recursive: true, force: true });

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
