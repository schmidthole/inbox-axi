# Installation and reversible native setup

Install into a private virtualenv, not global Python. Python ≥3.9 on macOS/Linux
is supported; Node ≥24 is required for bundled Node/Pi fixture execution. Use
`pip install .` for the default dependency-free mailbox; `pip install '.[codex]'`
adds websockets ≥15,<16 (15 supports Python 3.9). Development additionally uses
Black 25.11.0 and Prettier 3.6.2. The Python dev extra also installs
`setuptools>=61` and `wheel` so `make test-install` can build without build isolation
in a fresh virtualenv; CI and the README use the same `.[codex,dev]` setup.
Claude's SDK 1.32.1 is isolated in the adapter asset directory with a lockfile. `setup claude` prints the exact local `npm ci
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
callbacks. The adapter requires bounded native `pi.exec` for read-only explicit
ack-status checks. A missing native observation/all-message explicit incorporation
ack fails visibly after five minutes and stops polling; see [delivery](delivery.md)
for recovery and async input-hook semantics. Offline list-models loading and mock lifecycle tests are not live
native delivery certification.

## Claude Code

`setup claude` prints an inline session-scoped `--mcp-config` and the native
`--dangerously-load-development-channels server:inbox` flag. The normal entry
advertises `claude/channel`, polls pending input automatically after initialization,
and provides explicit ack/reply tools. It writes no files in `~/.claude*` or
`.mcp.json` and does not disable unrelated configuration or permissions. There is
no additional inbox enablement flag, immutable session UUID binding or auto-resume.
Use ordinary native conversation/resume controls; the channel routes to the
active conversation of that launch, including after `/clear` or `/resume`.

Generated thread/message IDs remain authoritative across these changes. Each
notification tells the receiving conversation to restore thread history and
associated generic task context with explicit `read-thread` CLI argv before
acting/replying. `launch_id` is a process diagnostic only, never the current
conversation UUID. The coordinator owns any topic/task association; inbox-axi
has no task database/lifecycle integration.

Native channels are a research preview. Custom channels are not on the public
allowlist, so the documented development-channel flag requires local interactive
confirmation. It bypasses only the native allowlist, **not** org policy or tool
permissions. Accept applicable MCP consent too. Preview flags do not appear in
help and the development flag is ignored for `-p`/Agent SDK. Supported upstream
auth is claude.ai or Console API key, not Bedrock/Vertex/Foundry; Team/Enterprise
and managed Console organizations need channels enabled by policy.

Check the native startup channel notice and `/mcp`; connected tools alone do not
prove admission. SDK1.32.1 uses protocol ≤2025-11-25, avoiding the documented v2
registration issue at protocol2026-07-28. The adapter cannot confirm native
registration or receipt from a write: diagnostics explicitly say unconfirmed,
and mail remains pending until explicit incorporation ack. Live native admission,
UI behavior and model processing have not been tested.

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
incorporation. For Claude, `mechanism_supported` and `automatic_push_enabled`
describe the bundled adapter default, not a running/admitted native instance;
`configuration_scope` identifies that distinction. `channel_registration` and
`harness_active` stay unknown. No doctor command invokes a model or changes harness configuration.
