# inbox-axi

A private, durable operator inbox for external programs and native coding-agent
sessions. Threads, explicit replies, JSON data, and incorporation acknowledgments;
not a connector, task manager, scheduler, or agent runtime.

**v0.1:** Python ≥3.9, Unix/macOS, local SQLite. Default runtime has no dependencies.
Native adapters are opt-in. Their protocol fixtures pass, but authenticated native
idle-wake/busy-steering/UI behavior is **not live-verified**. **Claude automatic
push is disabled:** native session switching cannot be atomically fenced. Its
normal adapter is tools-only MCP (explicit ack/reply plus manual CLI reads), not
full native push support. This is an outstanding v1 acceptance blocker.

## Quickstart

```sh
python3 -m venv .venv
.venv/bin/python -m pip install .
.venv/bin/inbox-axi init
printf '%s' 'please inspect this result' | .venv/bin/inbox-axi --json post --body-file - --key external-1
.venv/bin/inbox-axi pending
.venv/bin/inbox-axi --json read-thread thr_REPLACE_WITH_32_HEX_DIGITS
printf '%s' 'reviewed; here is my response' | .venv/bin/inbox-axi --json reply \
  --thread thr_REPLACE_WITH_32_HEX_DIGITS --parent msg_REPLACE_WITH_32_HEX_DIGITS --body-file -
.venv/bin/inbox-axi ack msg_REPLACE_WITH_32_HEX_DIGITS
```

Use the actual returned IDs, never “latest”. Replying does **not** ack. Ack means
incorporated into durable working context, not that work is complete.

Default storage: `$XDG_STATE_HOME/inbox-axi`, otherwise
`~/.local/state/inbox-axi`, outside the repository. `INBOX_AXI_HOME` or global
`--home /physical/private/path` selects another store. Use a separate root per
workspace. Roots must be owned by your OS user and mode `700`; private files `600`.
Symlink store paths are rejected, including symlink ancestors; use a physical path
(e.g. macOS `/private/tmp/...` rather than `/tmp/...`).

Global options go **before** the command: `--home`, `--json`, `--full`.
Default reads show at most 20 messages and 160 text characters each, with escaped
terminal controls. `--full` shows full bodies/data; `--json` always returns full
machine-readable envelopes. Both remain page-bounded. Continue with `--after` and
`--limit 1..100` until `next_cursor` is null. No history expiry or depth limit.

## External programs

```sh
printf '%s' '{"text":"review result","data":{"score":42},"key":"job-42","metadata":{"project":"example"}}' \
  | inbox-axi --json post --input-json -
```

`--input-json FILE|-` accepts `text`, `data`, `thread_id`, `parent_id`, `key`, and
new-thread-only `metadata`. `reply` requires both reference IDs and fixes direction
outbound. `ack-status ID [ID ...]` reads incorporation flags for up to eight
explicit IDs without acknowledging them. Generated ID/order/time/direction/version fields are rejected in requests.
Text can instead use `--body-file FILE|-`, with optional `--data-json FILE` and
`--metadata-json FILE`. See [the subprocess example](examples/external_program.py).

## Native sessions

```sh
inbox-axi --json setup pi
inbox-axi --json setup claude
inbox-axi --json setup codex
inbox-axi --json doctor pi
```

Setup **prints**, never executes, session-scoped launch recipes; no global/project
harness config is rewritten. Inspect and run the returned recipe yourself.

- **Pi:** bundled native extension uses `sendUserMessage`, wakes idle sessions and
  queues busy input with native `steer` semantics. Requires a durable interactive
  session; transformed marker observations or all-message explicit ack reopen a
  bounded steering slot. Missing progress fails visibly after five minutes rather
  than stalling silently. No prompt expansion or automatic output forwarding.
- **Claude:** bundled Node ≥24 MCP SDK channel, launched by Claude over stdio.
  Install its optional Node dependencies using the printed `npm ci` recipe.
  **Tools-only by default:** explicit ack/reply, manual CLI read-thread. Automatic
  channel push remains disabled because `/clear` can route queued events into a
  replacement session. An experimental channel factory is exercised only by
  offline fixtures; no setup flag enables it. No HTTP listener or permission relay.
- **Codex:** `pip install '.[codex]'`, then bind an exact native thread UUID,
  shared private socket, Codex home and server version. Uses supported WebSocket
  library over the native Unix control socket. Idle `thread/queue/add`, busy
  `turn/steer` with `expectedTurnId`. Never resumes or starts another native
  session. **CLI queue alone is not busy steering.**

[Installation and harness gates](docs/install.md) · [Protocol](docs/protocol.md) ·
[Delivery](docs/delivery.md) · [Security](docs/security.md) ·
[Verification and manual checklist](docs/verification.md)

All local OS-user writers are operator-authorized. Do not expose this inbox to
untrusted programs or ingest outside content as instructions: quote it as data.
A sender string would not authenticate anything; there is no sender-auth field.

## Development

```sh
python3 -m venv .venv
.venv/bin/python -m pip install '.[codex,dev]'
npm ci --ignore-scripts --prefix src/inbox_axi/adapters
make format
make test
make lint
make test-install
```

Tests use temporary private stores, mock native APIs and local WebSocket/stdio
fixtures only: no model calls or existing native session mutations.
`make test` requires the opt-in adapter test dependencies and Node ≥24. The dev
extra includes `setuptools>=61` and `wheel`, required by the isolated wheel check
that intentionally builds without build isolation. CI uses this same dev setup.

**License:** the owner has not specified a license. No license or copyright
ownership is invented here. Resolve licensing before distribution. Implementation
is original; optional dependencies retain their own licenses (MCP SDK MIT,
websockets BSD-3-Clause; see their distributions).
