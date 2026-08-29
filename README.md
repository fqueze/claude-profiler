# claude-profiler

Turns a Claude Code session log into a [Firefox Profiler](https://profiler.firefox.com)
profile, so a conversation can be read as a timeline: what the model was doing,
which tools ran and for how long, what the sub-agents were up to, and where the
tokens and the money went.

Claude Code writes every session to a [JSONL file](JSONL_FORMAT.md) under
`~/.claude/projects/`. Those files hold timestamps, token usage and tool calls,
but reading them by hand doesn't show how a session actually unfolded. The
profiler already knows how to display concurrent tracks, interval markers and
counter graphs over a shared timeline, which is exactly the shape of this data.

## Install

Requires Node.js. There are no runtime dependencies.

```sh
git clone https://github.com/fqueze/claude-profiler
cd claude-profiler
npm link          # makes the `claude-profiler` command available
```

Or run it straight out of the checkout without installing anything:

```sh
node /path/to/claude-profiler/index.js <jsonl-file>
```

## Usage

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

To profile the most recent session of the current project:

```sh
claude-profiler "$(ls -t ~/.claude/projects/"${PWD//\//-}"/*.jsonl | head -1)"
```

### Options

| | |
|---|---|
| `--size` | Profile what fills the context window, instead of the session timeline. |
| `--at peak\|last` | Which API call's window to profile, with `--size`. Defaults to `peak`. |
| `--profiler-origin <url>` | Front end to open, and the origin allowed to fetch the profile. Defaults to `https://profiler.firefox.com`, or `$PROFILER_ORIGIN` if set. |

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

Both profiles carry the session transcript, so double-clicking a frame in the
call tree or the flame graph opens the source view scrolled to the output that
frame is about — the question "was that command's output worth its bytes?" is
one double-click from the frame that raised it. The gutter shows how many bytes
each line contributed, since line hits are the sample weights, so a long run of
near-identical lines reads as exactly that.

A tool call is written the way a terminal would show it: the command, then what
it printed. There is nothing in between to skip past, because the view scrolls
to the right line by itself.

```
21:16:53 $ cd /Users/me/firefox/artifacts; mkdir -p sbfail && mv WqG3Pv_* sbfail/ …
  (10.2 KB, 3.4 s)
18987:[task 2026-08-28T19:37:10.760+00:00] INFO - TEST-START | browser/…
18996:[task 2026-08-28T19:37:13.122+00:00] INFO - TEST-PASS | browser/…
```

The size note appears once the output is worth wondering about, from 4 KB up.
Its duration is the gap between the request and its result: both log entries are
written when the message is logged, so neither timestamp alone says how long a
command took.

The `--size` transcript covers only what was resident in the profiled window;
the timeline's covers the whole track.

Transcripts are embedded in the profile itself, in the sources table's `content`
column, so the source view needs no symbol server and a saved or shared profile
stays readable on its own. This is what fixes both profiles at format version
64: earlier versions have that table rebuilt by the front end's upgraders, which
would drop the embedded text.

## What the profile contains

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

Counter graphs, sampled at every API call: `Context Size`, `Input Tokens`,
`Output Tokens`, `Cache Read Tokens`, `Cache Creation Tokens`, `Cost ($)`,
`Agent Cost ($)` — plus `Total Cost ($)` on the main track, sampled across every
agent's calls so the line is continuous rather than a staircase.

Costs are computed from the token counts in the log and the price table in
`index.js`, which needs updating when prices change. They will not match `/cost`
exactly; see [Known Limitations](JSONL_FORMAT.md#known-limitations).

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

- `index.js` — the CLI and the timeline profile builder.
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
reconstruction, the calibration and the transcript line mapping.
