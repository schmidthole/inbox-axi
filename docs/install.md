# Installation and native gates

Use Node >=24 on Unix/macOS with local SQLite/flock filesystem semantics and the C/C++ toolchain required by `fs-ext`. `npm ci` installs the locked source dependencies; `npm run build` emits `dist`; `npm install -g .` installs this checkout, or install the published package when available. `npm pack` builds and checks the generated skill. No Python runtime or separate adapter install is needed.

`inbox-axi -v`, `-V`, `--version` return bare `0.2.0` before importing the command graph. SDK `update --check` reports registry state; `update` follows the detected installation method. Neither runs during ordinary commands. This source port does not publish a new npm release.

## Session startup and local capture

Explicit `inbox-axi setup hooks` installs or repairs project-scoped startup integrations for Claude, Codex and OpenCode. The SDK installs a managed project launcher with absolute Node and CLI paths, so callbacks work even without npm or Node on PATH. Explicit `--home` is preserved in that launcher. Run setup again after moving/reinstalling. `doctor hooks` is read-only. `uninstall hooks` removes only managed entries and preserves unrelated hooks/settings/plugin files and the mailbox. SDK project setup also enables the user-level Codex `[features].hooks = true`; removal leaves that shared feature enabled.

The dashboard resolves the current directory mailbox or explicit environment override, so unrelated workspaces do not share pending mail. The project startup hook can apply in a subdirectory: use a per-project `INBOX_AXI_HOME` environment setting if one shared project root is desired.

Claude and Codex documented `SessionEnd` command hooks run `inbox-axi capture`, bounded to small local timestamp/workspace/count metadata in the selected private mailbox. They do not read stdin, transcript paths, message text or files touched, and send no data outward. This intentionally minimal capture is visible as previous-session context at the next dashboard. Codex's end event has its documented deferred normal-close/archive/delete/idle semantics, not an immediate session-switch guarantee. OpenCode startup ambient injection is SDK-managed. A separate managed plugin captures documented `session.idle` snapshots through V1 event callbacks or V2 event subscriptions with abort cleanup; idle does not imply session end. Use explicit `capture` for other boundaries.

Primary lifecycle references: [Claude hooks](https://code.claude.com/docs/en/hooks#sessionend), [Codex hooks](https://learn.chatgpt.com/docs/hooks#sessionend), [OpenCode plugins](https://opencode.ai/docs/build/plugins). Native support and timing must be verified in the selected harness version; local fixtures do not prove native lifecycle emission.

The complementary generated [skill](../skills/inbox-axi/SKILL.md) provides static guidance without per-session context cost. Install with `npx skills add schmidthole/inbox-axi --skill inbox-axi`. Only one discovery path is needed; both may be used.

## Native delivery recipes

`inbox-axi setup pi|claude|codex --json` prints a session-scoped launch recipe, explicit environment and preview requirements. It never executes the recipe. `doctor pi|claude|codex` probes offline binary/version availability, not an authenticated capability check.

- Pi: launch the bundled `dist/adapters/pi.js` with `pi -e`; interactive durable session and native user-message API required. Generation fencing, transformed-input markers, explicit all-message incorporation and bounded progress deadlines remain enforced.
- Claude: launch the bundled `dist/adapters/claude.js` as a stdio MCP channel using the printed config plus native development-channel flag. Interactive MCP/channel consent, supported authentication and organization policy are required. Routing follows the active conversation; clear/resume requires restoring exact inbox history and task context. Transport writes do not prove registration or receipt.
- Codex: supply exact `--socket`, `--codex-home`, `--server-version`, `--thread` from an already-loaded native shared server thread. Uses WebSocket over the selected private Unix socket, idle queue versus busy `turn/steer` with `expectedTurnId`. No alternate backend or session resume. Reconcile uncertain mutations with `delivery-state`, then explicit `ack` or `retry`.

Recipes set `INBOX_AXI_HOME`, `INBOX_AXI_NODE` and `INBOX_AXI_CLI` to known mailbox/executable/compiled CLI paths. Delivered tool argv uses explicit Node and compiled CLI with command-first `--home`/`--json`, so the receiving native session does not need a matching PATH or inherited environment. Keep the npm installation available while its argv remains in context.

All authenticated native idle/busy/UI/policy/manual gates remain unverified and require operator-authorized live checks described in [verification](verification.md).
