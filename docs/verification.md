# Verification evidence and remaining gates

Automated suite: SQLite invariants, transaction retries, concurrent processes,
CLI/stdin/JSON roundtrips, bounded input/pages, permissions/symlinks, consumer
exclusion/backoff, crash/EOF release, stable-ID redelivery/no auto-ack, Codex local
WebSocket RPC identity/queue/steer/rejection/timeout/uncertainty/approval fixtures,
Pi lifecycle/user-message API fixture, and official MCP SDK stdio Claude tools/
notification fixture plus normal-entry automatic-push-disabled checks. CI is
configured for Python 3.9 and 3.13 with Node24; optional dependencies are installed
locally, then Black/Prettier checks, compile/lowercase checks, tests
and wheel contents/install checks. No test spends inference or touches real user
threads. Native availability is an offline prerequisite, not a passing live check.

Observed during implementation: Pi1.5.2, Codex CLI0.167.0, running shared daemon
0.169.0, Claude Code2.1.325. Read-only WebSocket-over-Unix initialize against the
existing daemon confirmed framing/version/home without reading/changing threads.
Pi explicit extension offline list-models command returned successfully. These
are **not** proof of native idle/busy delivery, session switching, policy admission
or visible UI behavior. Mock APIs are labeled fixtures, not installed capability
verification. No authenticated/model session was exercised.

## Outstanding acceptance blocker

Claude atomic native-session fencing is unsupported by the documented channel
contract. Automatic push is disabled in its normal entry/setup, while manual
mailbox CLI and explicit MCP ack/reply remain available. Experimental channel
transport fixtures do not satisfy the original three-harness automatic-delivery
criterion. Official hooks reference SessionStart documentation states startup and
`/clear` hooks run in background, so a hook-updated check cannot atomically fence
check→notification→native switch. No hooks were added or synchronization invented.
Resolve this product/capability gap before accepting full three-harness coverage.

## Manual native checklist (not run, not passed)

For each supported installed harness, with operator authorization:

1. Launch its documented adapter recipe in a disposable private workspace/store,
   exact durable native session, and ordinary permission mode. Confirm original
   native UI/messages and unrelated config are unchanged.
2. While idle post text+data; confirm an actual native user/channel event starts a
   turn. Note the stable mailbox ID. Do not infer from consumer/API write success.
3. During an executing native tool, post another message. Confirm delivery only at
   the documented native boundary and before subsequent processing, not keystroke
   injection or competing session resume. Check long tool/retry/compaction behavior.
4. Explicitly incorporate/ack and reply to exact IDs. Confirm reply persisted in
   the right thread, pending cleared only on ack, no transcript auto-forwarding.
5. Exercise a native approval wait; confirm the adapter cannot approve it, UI
   remains usable, and no sandbox/provider policy is relaxed.
6. Crash/restart adapter and switch/reload native sessions. Confirm exclusion,
   release, stable-ID redelivery and stale-session isolation. For Codex test a
   turn-race rejection and uncertain submission recovery without blind fallback.
7. Claude: first resolve the atomic session-fencing blocker; then test development/
   MCP consent and actual channel registration under the account/org policy. A blocked channel is a deployment blocker, not a pass.

Required live guarantees remain unavailable until these checks are authorized and
performed. Docs promise only documented native mechanisms under healthy/admitted
bindings, not unconditional wake, semantic handling, responses or exactly-once.

## Official implementation references (read in full for applicable APIs)

- Installed Pi `docs/extensions.md`, `examples/extensions/send-user-message.ts`
  and `file-trigger.ts` in `@earendil-works/pi-coding-agent`1.5.2.
- https://code.claude.com/docs/en/channels-reference.md
- https://code.claude.com/docs/en/channels.md
- Official fakechat README/server (reference only; no connector/UI code copied):
  https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/fakechat
- Claude hook ordering reviewed at https://code.claude.com/docs/en/hooks.md#sessionstart
  (relevant ordering sections; no hook implementation added).
- MCP SDK v1.x README, docs/server.md, docs/protocol.md and installed SDK stdio
  transport contracts: https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x
- Codex rust-v0.167.0 `codex-rs/app-server/README.md`, app-server-client/README.md,
  app-server-daemon/README.md, cli/src/queue_cmd.rs, ext/queue/src/service.rs,
  app-server-transport/src/transport/unix_socket.rs and stdio.rs, plus generated
  turn-steer types and installed CLI-generated experimental schemas.
- websockets15.0.1 sync client API documentation/docstrings for unix_connect,
  send, recv, close: https://websockets.readthedocs.io/en/15.0.1/reference/sync/client.html

The native transports are experimental/version-sensitive. Failures must remain
visible; do not silently replace them with background model polling or PTY input.
