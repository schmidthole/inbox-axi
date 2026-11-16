# Installation and reversible native setup

Install into a private virtualenv, not global Python. Python ≥3.9 on macOS/Linux
is supported; Node ≥24 is required for bundled Node/Pi fixture execution. Use
`pip install .` for the default dependency-free mailbox; `pip install '.[codex]'`
adds websockets ≥15,<16 (15 supports Python 3.9). Development additionally uses
Black 25.11.0 and Prettier 3.6.2. Claude's SDK 1.32.1 is isolated in the adapter
asset directory with a lockfile. `setup claude` prints the exact local `npm ci
--omit=dev --ignore-scripts --prefix ...` command for an installed package.
No dependency installer is executed by the CLI itself.

`setup HARNESS` prints a recipe with the current interpreter, absolute assets and
store. It neither writes harness config nor launches models. Review its JSON or
shell recipe; do not evaluate untrusted shell output. Keep that virtualenv intact
while the session is open. Do not load two adapters for the same mailbox root.
`uninstall` prints removal instructions and never deletes data/config. Stop the
adapter/session, relaunch native CLI without extension/channel flags, then remove
the virtualenv or uninstall its package. Optional npm dependencies live beside the
assets; deleting them removes those dependencies. Unrelated config is untouched.

## Pi

Run the `setup pi` recipe: explicit native `pi -e ABSOLUTE_ASSET` plus
`INBOX_AXI_HOME` and `INBOX_AXI_PYTHON`. Use a durable interactive session, not
`--no-session`, print/JSON/RPC mode. Normal Pi UI, messages, input hooks, tools and
permission extensions stay active. The extension never expands injected slash
commands/templates and never rewrites the transcript. Session new/resume/fork/
reload use native shutdown/start lifecycle; generation fencing disables old
callbacks. Offline list-models loading and mock lifecycle tests are not live
native delivery certification.

## Claude Code

`setup claude [--session UUID]` generates a fresh explicit session UUID if omitted,
inline session-scoped `--mcp-config` and `--session-id`. The normal entry provides
ack/reply tools only; use `inbox-axi read-thread` manually to read requests. It does
not declare a channel capability, spawn a polling consumer or enable a native
channel flag. No files in `~/.claude*` or `.mcp.json` are written. Use a fresh
session ID or deliberately choose an explicit existing UUID with the appropriate
native resume command, never most-recent.

**Automatic push is disabled, with an actionable stderr capability warning.**
Native channel notifications carry no target-session precondition/receipt. Native
`/clear` hooks run in background and cannot atomically prevent already queued
notifications reaching replacement context. The metadata retains the original
intended binding, but metadata is not native delivery enforcement. No runtime or
setup flag enables the experimental channel factory; fixtures invoke it directly
for protocol tests only. Full Claude deterministic delivery remains blocked.

Even if that session-fencing blocker is resolved, custom preview channels are not
publicly allowlisted. An enabled deployment would require local development/MCP
consent, supported Anthropic auth and organization channel policy. Preview flags
do not appear in help and are ignored for `-p`/Agent SDK. Claude.ai/Console auth is
supported upstream, not Bedrock/Vertex/Foundry; Team/Enterprise and managed Console
organizations need channels enabled by policy. MCP connection alone does not prove
channel admission. SDK1.32.1 uses protocol ≤2025-11-25, avoiding the documented v2
registration issue at protocol2026-07-28. Notification write is never a receipt.

## Codex

Open an explicitly selected durable thread in the ordinary native CLI, sharing
its server. Obtain the exact thread UUID, native server home, control socket and
running version using native diagnostics. Installed CLI and managed daemon
versions can differ. Example with placeholders, **not an auto-discovered target**:

```sh
inbox-axi --home /physical/private/inbox codex \
  --socket /physical/private/codex-control.sock \
  --codex-home /physical/codex-home --server-version 0.169.0 \
  --thread 019a7d37-3067-7000-8000-000000000001
```

This command runs alongside the native UI, not a second conversation runner. It
never starts/resumes a thread/server, changes provider/model/approval/sandbox
settings, or silently connects elsewhere. It requires native paginated turn
reads, `canAcceptDirectInput`, queue and expected-turn steering capability. Missing
capabilities error, leaving pending input intact. Native implicit daemon attachment
may fall back to an embedded server; if the TUI is not on the selected server,
binding fails rather than guessing. Recheck capabilities after daemon upgrades.
A manual interrupted session must be recovered in the native UI, not force-woken.

## Doctor is deliberately conservative

Doctor reports executable/version availability, optional dependency presence,
mailbox lock activity, and session-scoped configuration uncertainty separately.
A lock can belong to any harness; it is not proof of a specific native session.
`capability_verified` stays false: version/help, installed files and fixtures do not
prove native UI idle wake/busy steering, channel admission, approvals or model
incorporation. No doctor command invokes a model or changes harness configuration.
