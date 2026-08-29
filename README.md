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

`--profiler-origin <url>` sets the front end to open, and the origin allowed to
fetch the profile. Defaults to `https://profiler.firefox.com`, or
`$PROFILER_ORIGIN` if set.

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
  createFirefoxProfile
} = require('claude-profiler');

const entries = readJsonlFile(jsonlPath);
const profile = createFirefoxProfile(entries, readSubagents(jsonlPath));
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

- `index.js` — the CLI and the profile builder.
- [`JSONL_FORMAT.md`](JSONL_FORMAT.md) — the session log format: entry types,
  usage objects, sub-agent layout, cost formula and known limitations.
