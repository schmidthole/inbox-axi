# Installation and native gates

inbox-axi is installed from a checkout of this repository. It is not published to the npm registry. `npm install -g inbox-axi`, `npx inbox-axi`, and `npm install -g git+https://github.com/schmidthole/inbox-axi.git` do not work. npm runs a global git install's dependency step with the global flag still set, so the build cannot see a local toolchain.

Use Node >=24 on Unix/macOS. The mailbox uses local SQLite and `flock`. `fs-ext` compiles a native addon during installation, which needs python3, make, and a C++ compiler (`g++`, or the Xcode command-line tools on macOS). No Python runtime is used after that build, and there is no separate adapter install.

```sh
git clone https://github.com/schmidthole/inbox-axi.git
cd inbox-axi
npm ci
npm run build
npm install -g .
```

`npm ci` installs the locked dependencies, including the native addon. `npm run build` emits `dist`. `prepare` runs that same build when dependencies are already installed, and does not run the skill check. `npm install -g .` installs this checkout. A packed tarball already contains `dist` and does not build again. Update by pulling the same repository and installing again. `npm pack` builds a local tarball for the install check; it does not publish. `dist/` is not committed.

`inbox-axi -v`, `-V`, `--version` return bare `0.2.0` before importing the command graph. SDK `update --check` reports registry state; `update` follows the detected installation method. Neither runs during ordinary commands. There is no npm registry release for that update command to install.

## Session startup and local capture

Explicit `inbox-axi setup hooks` installs or repairs project-scoped startup integrations for Claude, Codex and OpenCode. The SDK installs a managed project launcher with absolute Node and CLI paths, so callbacks work even without npm or Node on PATH. Explicit `--home` is preserved in that launcher. Run setup again after moving/reinstalling. `doctor hooks` is read-only. `uninstall hooks` removes only managed entries and preserves unrelated hooks/settings/plugin files and the mailbox. SDK project setup also enables the user-level Codex `[features].hooks = true`; removal leaves that shared feature enabled.

The dashboard resolves the current directory mailbox or explicit environment override, so unrelated workspaces do not share pending mail. The project startup hook can apply in a subdirectory: use a per-project `INBOX_AXI_HOME` environment setting if one shared project root is desired.

Claude and Codex documented `SessionEnd` command hooks run `inbox-axi capture`, bounded to small local timestamp/workspace/count metadata in the selected private mailbox. They do not read stdin, transcript paths, message text or files touched, and send no data outward. This intentionally minimal capture is visible as previous-session context at the next dashboard. Codex's end event has its documented deferred normal-close/archive/delete/idle semantics, not an immediate session-switch guarantee. OpenCode startup ambient injection is SDK-managed. A separate managed plugin captures documented `session.idle` snapshots through V1 event callbacks or V2 event subscriptions with abort cleanup; idle does not imply session end. Use explicit `capture` for other boundaries.

Primary lifecycle references: [Claude hooks](https://code.claude.com/docs/en/hooks#sessionend), [Codex hooks](https://learn.chatgpt.com/docs/hooks#sessionend), [OpenCode plugins](https://opencode.ai/docs/build/plugins). Native support and timing must be verified in the selected harness version; local fixtures do not prove native lifecycle emission.

The complementary generated [skill](../skills/inbox-axi/SKILL.md) provides static guidance without per-session context cost. It runs the installed `inbox-axi` command, not `npx`. Copy that skill into the agent, or add only the skill file with `npx skills add schmidthole/inbox-axi --skill inbox-axi`. The skills CLI does not install the inbox-axi command. Only one discovery path is needed; both may be used.

## Native delivery recipes

`inbox-axi setup pi|claude|codex --json` prints a session-scoped launch recipe, explicit environment and preview requirements. It never executes the recipe. `doctor pi|claude|codex` probes offline binary/version availability, not an authenticated capability check.

- Pi: launch the bundled `dist/adapters/pi.js` with `pi -e`; interactive durable session and native user-message API required. Generation fencing, transformed-input markers, explicit all-message incorporation and bounded progress deadlines remain enforced.
- Claude: launch the bundled `dist/adapters/claude.js` as a stdio MCP channel using the printed config plus native development-channel flag. Interactive MCP/channel consent, supported authentication and organization policy are required. Routing follows the active conversation; clear/resume requires restoring exact inbox history and task context. Transport writes do not prove registration or receipt.
- Codex: supply exact `--socket`, `--codex-home`, `--server-version`, `--thread` from an already-loaded native shared server thread. Uses WebSocket over the selected private Unix socket, idle queue versus busy `turn/steer` with `expectedTurnId`. No alternate backend or session resume. A confirmed submission is recorded and is not offered again until explicit `ack` or `retry`. Reconcile uncertain mutations with `delivery-state`, then explicit `ack` or `retry`.

Recipes set `INBOX_AXI_HOME`, `INBOX_AXI_NODE` and `INBOX_AXI_CLI` to known mailbox/executable/compiled CLI paths. `~` and `~/...` in `--home` expand to the current user's home before that path is recorded. Delivered tool argv uses explicit Node and compiled CLI with command-first `--home`/`--json`, so the receiving native session does not need a matching PATH or inherited environment. Keep this installation available while its argv remains in context.
