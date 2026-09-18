# claude-profiler

Lists Claude Code and Codex sessions together, and turns either session log
into a [Firefox Profiler](https://profiler.firefox.com) profile. The list shows
where the time and money went; profiles show what the model was doing, which
tools ran and for how long, and what the sub-agents were up to.

Claude Code writes sessions under `~/.claude/projects/`; Codex writes them under
`~/.codex/sessions/`. Both hold timestamps and usage data, but reading JSONL by
hand does not make sessions easy to compare. The picker normalizes both formats
into one start-time-sorted page and labels every row by provider.

## Install

Requires Node.js. There are no runtime dependencies.

```sh
git clone https://github.com/fqueze/claude-profiler
cd claude-profiler
npm link          # makes the `claude-profiler` command available
```

Or run it straight out of the checkout without installing anything:

```sh
node /path/to/claude-profiler/index.js
```

## Quick start

Run it with no arguments. It finds every session on the machine and opens the
list in a browser, so there is no file to go looking for:

```sh
claude-profiler
```

Each row is a session — what it was about, where it ran, when it started, how
long it actually worked, and its measured usage. Every row has a **Profiler**
button. Claude rows report calculated dollar cost; for a signed-in Enterprise
account, Codex rows report the backend's Enterprise dollar estimate and credit
consumption.
Above the session table, an overall usage row and one row per provider report
estimated cost, Enterprise credits, input and output tokens, net-new input,
cache writes, cache reads, and the cached share of input-side tokens. A
collapsible section breaks the same totals down by model. Codex cache writes
use the Enterprise API's exact net-new-input count. When that breakdown is
unavailable, the input-minus-cache-read fallback is visibly marked `≈`.
The estimated $/M figure divides cost by input plus output tokens. It is
the blended, cache-amortized price of processing one million tokens, so cache
reuse lowers it while costly output and model choice remain reflected in it. An
effective rate always uses the same billed sessions for both dollars and
tokens; unpriced sessions remain in overall/provider usage totals but are left
out of the per-model cost comparison. Every usage column is sortable; the top
header reorders providers while keeping Total fixed, and the header inside the
expanded model section sorts models independently.
Sort by any column to find the session worth looking at: the expensive one, the
long one, or the one with sub-agents.

To look at another machine instead, give its name. Anything you can `ssh`
into works, and the sessions are listed and profiled the same way:

```sh
claude-profiler my-build-machine
```

That is the whole workflow. Everything below is detail.

## Usage

### The session list

```sh
claude-profiler
```

```
Session list at http://127.0.0.1:64761/
Press Ctrl+C to stop.
```

The page interleaves sessions under `~/.claude/projects/` and
`~/.codex/sessions/`, newest start first. A row carries its provider, title,
working directory and branch, start time, active time, message and sub-agent
counts, size on disk, and dollar cost. Cost is banded so expensive
sessions stand out.

Codex JSONL does not contain a dollar amount or consumed-credit amount. Its
`rate_limits.credits` object only records whether credits are enabled. When the
local Codex login is available in `~/.codex/auth.json`, the picker uses the same
authenticated per-thread usage endpoint as Codex's credit and cost status-line
items. Spawned-agent costs are included
in their root session. The API is best-effort: when offline, signed out, or when
the backend omits an old thread, the row leaves cost blank rather than treating
unavailable billing data as zero. Locally recorded tokens remain available in
the JSON session summary and are included in the totals above the table, while
remaining out of each session row to keep the table compact.

Clicking a column header sorts by it, so "which session cost the most" and
"which one ran the most sub-agents" are one click each. The checkbox at the top
switches Claude buttons to building [`--size`](#profiling-what-filled-the-context-window)
profiles instead of timelines. Codex buttons always build activity timelines.

Profiles are built when a button is clicked rather than up front — a large
session takes a few seconds — and the server stays up until it is interrupted,
since the page is a menu rather than a single profile.

Costs are computed for real, including every sub-agent's own API calls, which
is most of the bill on a session that spawned any.

### A single session

Point it straight at a session file:

```sh
claude-profiler ~/.claude/projects/-Users-me-buildgit-myproject/<session-id>.jsonl
```

It builds the profile, serves it from a random port on `127.0.0.1`, opens the
profiler front end pointed at that URL, and shuts the server down as soon as the
profile has been fetched (or after 60 seconds if nothing fetches it).

```
Reading /Users/me/.claude/projects/-Users-me-buildgit-myproject/d48a9b32….jsonl...
Parsed 4789 entries
Found 77 sub-agents (22329 entries)
Created Firefox profile with 78 tracks
Total cost: $989.24
Server started at http://127.0.0.1:60659/
Opening Firefox Profiler...
```

### Another machine

Given a name that is not a file, `claude-profiler` treats it as an ssh host:

```sh
claude-profiler m4
```

The list is that machine's sessions, and the **Profiler** button builds the
profile there. Only JSON crosses the network — the transcripts stay where they
are, which matters because they are usually the largest thing on the machine.

This needs `claude-profiler` installed on the remote as well, since that is
what reads the sessions and builds the profiles. If it is missing, you are
offered the install:

```
Checking m4...
claude-profiler is not installed on m4.
Install it there with npm now? [y/N]
```

Two things that catch people out:

- The remote needs `node` and `npm` on the PATH of a **login** shell. A
  non-interactive `ssh host command` on macOS reads no profile at all, so
  commands are run through `zsh -lc` to get the PATH a terminal there would
  have.
- A machine whose name is also a file in the working directory is read as the
  file. Use `--host` to say you meant the machine.

The profile is built on the remote and served from this machine, so the
profiler front end fetches it from a local address as usual — no port
forwarding, and nothing listening on the remote.

### Options

| | |
|---|---|
| `--size` | Profile what fills the context window, instead of the session timeline. With no file given, starts the session list with its checkbox already ticked. |
| `--at peak\|last` | Which API call's window to profile, with `--size`. Defaults to `peak`. |
| `--host <name>` | Treat the argument as an ssh host, even when a file of that name exists. |
| `--profiler-origin <url>` | Front end to open, and the origin allowed to fetch the profile. Defaults to `https://profiler.firefox.com`, or `$PROFILER_ORIGIN` if set. |
| `--json <command>` | Answer in JSON on stdout instead of opening anything: `probe`, `list`, `stamp <id>`, or `profile <id>`. This is how a `claude-profiler` driving another one over ssh talks to it, and is not meant to be typed. |

The profile is served with an `Access-Control-Allow-Origin` header for that
origin, since the front end fetches it from the browser.

If the hosted profiler fails to load the profile, use a local checkout of the
[profiler front end](https://github.com/firefox-devtools/profiler) instead
(`yarn start`, which serves on port 4242):

```sh
claude-profiler <jsonl-file> --profiler-origin http://localhost:4242
```

A browser or extension that blocks page requests to loopback addresses will
break the hosted flow; a front end on localhost is not subject to that.

## Profiling what filled the context window

`--size` builds a size profile instead of a timeline: bytes go on the time axis
and in the sample weights, the same shape as an allocation profile, so the
**flame graph** and the call tree answer "what is taking up the window".

```sh
claude-profiler <jsonl-file> --size
```

The stack is what produced the bytes rather than a code path, and a Bash call is
broken down into the commands inside it:

```
Bash (output) / profiler-cli thread markers / head -30
Bash (output) / for loop / sed -n 20430,20500p
Bash (call)   / cat
Read (output) / browser/components/sidebar/sidebar-main.mjs
```

One call often runs several commands, so a single `Bash` frame would say
nothing. The agent's habit of writing `echo "=== something ==="` between
commands is what makes the split possible: that text is the only marker that
survives into the output, so bytes printed between two markers are attributed to
the commands in between. Pipeline stages get their own frame, since `| head -30`
is the reason the output is the size it is. Commands inside a loop aggregate
under the loop, whose `echo` repeats once per iteration.

`--at last` profiles the window at the session's final API call instead of at
its peak. Sub-agents each get their own track, as in the timeline profile.

### Bytes and tokens

Sample weights are bytes, counted exactly. Tokens are reported alongside them,
derived by fitting `tokens ≈ overhead + bytes / bytesPerToken` against the token
counts the API itself reported for every call in the session:

```
796KB of context ≈ 349,201 tokens, API reported 394,696 (call 375/375)
calibrated at 2.34 bytes/token over 374 calls, median error 0.6%
```

There is no offline tokenizer for these models — the only exact count is the
API's own `count_tokens`, which is a network call per request — so calibrating
against the counts already in the log is both dependency-free and
self-correcting. It also beats a fixed rule of thumb: tool output is dense log
and JSON text that runs about 2.3 bytes per token rather than the ~4 of prose.

The fit's intercept is the part of the window that never appears in the log at
all — the system prompt, the tool schemas and CLAUDE.md — which is why the
profile has a `System prompt + tool schemas (not logged)` frame. Without it the
tree would silently be missing about 30k tokens.

### How the window is reconstructed

The window is not the whole log. Content leaves it when the conversation is
compacted, and each sub-agent has a window of its own, so accumulating every
logged byte overstates a long session's window by more than 2x. What is resident
at a given API call is the chain of messages leading to it, which the log records
through `parentUuid`; the profile walks that chain back from a call and stops at
the most recent `compact_boundary` entry.

## Reading the output in the source view

Both profiles carry the context window as text, so double-clicking a frame in the
call tree or the flame graph opens the source view scrolled to the content that
frame is about — the question "was that command's output worth its bytes?" is one
double-click from the frame that raised it. The gutter shows how many bytes each
line contributed, since line hits are the sample weights, so a long run of
near-identical lines reads as exactly that.

The document is the window and nothing else: every line is text the model was
actually sent, in order, with one blank line between blocks. Nothing is added for
readability — no timestamps, no sizes, no separators, no shell prompts. Such a
line would sit between lines that are in the context, shifting everything below
it away from what the profile measured, and its weight in the gutter would belong
to nothing. A Bash call appears as its command text, since that is what occupies
the window; other tools appear as the JSON they were sent.

Transcripts are embedded in the profile itself, in the sources table's `content`
column, so the source view needs no symbol server and a saved or shared profile
stays readable on its own. This is what fixes both profiles at format version
64: earlier versions have that table rebuilt by the front end's upgraders, which
would drop the embedded text.

The `--size` document covers only what was resident in the profiled window; the
timeline's covers the whole track.

## What the Claude profile contains

One process track per agent: the main conversation first, then one per
sub-agent, ordered by when they started. Sub-agent transcripts are picked up
automatically from `<session-id>/subagents/` next to the session file. Tracks are
named after the session title Claude Code generates, and sub-agent tracks after
their task description.

Markers on each track:

| Marker | What it shows |
|---|---|
| `user` / `assistant` | Message text, searchable. |
| Model name | One interval per API response, with effort, stop reason, output tokens and iteration count. Covers queueing, inference and streaming. |
| `Turn` | Wall-clock turn duration, as measured and logged by Claude Code. |
| `User intervention` | Denied tool calls and feedback attached to a tool result. |
| Tool name | One interval per call, from request to result, with the call detail, output size and status. Failed and interrupted calls are red. |
| `Subagent` | On the spawning track, spanning the lifetime of the sub-agent's own track. |

Samples carry what each message added to the window — stack is what produced
the bytes, weight is how many — so the call tree and the flame graph work on the
timeline profile too, as they would for an allocation profile. Selecting a range
shows what filled the window during it.

Time when neither the model nor a tool was running — the agent waiting for its
user — is sampled into an `Idle` category, which the front end draws as nothing.
Without it the activity graph stretches the last sample before a gap across all
of it, and a session that spent hours waiting looks busy throughout: the 9.4 hour
session above reads as 65% empty rather than 100% active.

Counter graphs, sampled at every API call: `Context Size`, `Input Tokens`,
`Output Tokens`, `Cache Read Tokens`, `Cache Creation Tokens`, `Cost ($)`,
`Agent Cost ($)` — plus `Total Cost ($)` on the main track, sampled across every
agent's calls so the line is continuous rather than a staircase.

Costs are computed from the token counts in the log and the price table in
`index.js`, which needs updating when prices change. They will not match `/cost`
exactly; see [Known Limitations](JSONL_FORMAT.md#known-limitations).

### Codex profiles

A Codex profile has one track for the root thread and one for every spawned
agent. It includes logged turn spans, user and agent messages, reasoning,
commands, MCP calls, file changes and other tool activity. It supports both the
current item-completion format and older Codex event logs.

As with Claude, the context and output-token graphs are sampled at every model
response. Context distinguishes cached from uncached input, and model markers
carry model, effort, input, cached-input, output and reasoning-token counts.
Transcript contributions are source-linked weighted samples, so the call tree,
flame graph, source view and idle-gap treatment work on Codex tracks too.

`Response Cost ($)` shows individual responses, `Thread Cost ($)` shows the
running cost on every track, and `Total Cost ($)` combines the root and spawned
agents on the root track. Their endpoints
are the exact backend dollar amounts; their distribution over time follows
the cumulative usage snapshots recorded in the rollout. Token and credit
details stay inside profile markers rather than adding columns to the compact
session table.

## Use as a library

```js
const {
  readJsonlFile,
  readSubagents,
  readSubagentsForSession,
  createFirefoxProfile,
  createSizeProfile
} = require('claude-profiler');

const entries = readJsonlFile(jsonlPath);
const subagents = readSubagents(jsonlPath);

const timeline = createFirefoxProfile(entries, subagents);
const size = createSizeProfile(entries, subagents, { at: 'peak' });
```

`createFirefoxProfile(entries, subagents)` returns a
[processed profile](https://github.com/firefox-devtools/profiler/blob/main/src/types/profile.js)
object, ready to be serialized as JSON. Omitting `subagents` looks them up from
the session id, so callers that only have the main transcript don't silently
lose everything the sub-agents did; pass `[]` to opt out.

Serve it with an `Access-Control-Allow-Origin` header for the front end's origin
and open `<origin>/from-url/<encoded url>?thread=0`. The `thread=0` parameter
makes the front end take the track order from the URL instead of re-sorting
tracks by activity score.

[claude-dashboard](https://github.com/fqueze/claude-dashboard) uses it this way,
to add a profiler button to each session row.

## Files

- `index.js` — the CLI, the session list server and the timeline profile builder.
- `claude-backend.js` / `codex-backend.js` — find and summarize each provider's
  sessions.
- `codex-profile.js` — builds Codex activity timelines.
- `session-index.js` — renders the shared session-list page.
- `remote.js` — driving another machine's `claude-profiler` over ssh: probing
  for it, offering to install it, and fetching its listings and profiles.
- `context-size.js` — context window reconstruction, calibration and the size
  profile.
- `size-profile.js` — attribution of bytes to stacks, and the profile tables.
- `transcript.js` — renders a window as the text document the source view shows,
  and records which line each piece of content is on.
- `shell-parse.js` — enough shell parsing to split a Bash call into the commands
  that produced its output.
- [`JSONL_FORMAT.md`](JSONL_FORMAT.md) — the session log format: entry types,
  usage objects, sub-agent layout, cost formula and known limitations.

`npm test` covers the shell parsing, the output attribution, the window
reconstruction, the calibration, the transcript line mapping, the session list
and the remote protocol.
