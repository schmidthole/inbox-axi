# Verification evidence and remaining gates

Automated suite: SQLite invariants, transaction retries, concurrent processes,
CLI/stdin/JSON roundtrips, bounded input/pages, permissions/symlinks, consumer
exclusion/backoff, fair new-input admission beyond eight unacked messages, due
retries under continuing new input, crash/EOF release, stable-ID redelivery/no
auto-ack, transformed Pi input and handled-input/all-vs-partial explicit ack,
missing-progress deadline/shutdown recovery, repeated Pi steering during one
continuing busy run, and Codex local
WebSocket RPC identity/queue/steer/rejection/timeout/uncertainty/approval fixtures,
Codex delivered read-thread/reply/ack argv against a custom mailbox (source and
isolated installed npm package), shared uncertainty gating across consumer changes
and due retries,
Pi lifecycle/user-message API fixture, and official MCP SDK stdio Claude tools/
normal direct-entry channel notifications, explicit ack/reply, periodic polling,
consumer exclusion, shutdown/restart and simulated active-conversation replacement.
`npm ci` then `make check` runs TypeScript compilation, Prettier checks, generated-skill drift checks, unit/protocol/native fixtures, CLI conformance and packed npm contents/install checks. No hosted CI workflow is configured. No test spends
inference or touches real user threads. Native availability is an offline prerequisite, not a passing live check.

Observed during implementation: Pi1.5.2, Codex CLI0.167.0, running shared daemon
0.169.0, Claude Code2.1.325. Read-only WebSocket-over-Unix initialize against the
existing daemon confirmed framing/version/home without reading/changing threads.
Pi explicit extension offline list-models command returned successfully. These
are **not** proof of native idle/busy delivery, session switching, policy admission
or visible UI behavior. Mock APIs are labeled fixtures, not installed capability
verification. No authenticated/model session was exercised.

## AXI conformance checks

| principle          | local evidence                                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1: TOON boundary   | SDK dispatch and official serializer; CLI decode roundtrips; JSON/JSONL preserved                                                                               |
| 2: minimal schemas | four-field pending lists, explicit --fields, complete detail views                                                                                              |
| 3: truncation      | text/data previews, total lengths, conditional --full hints; full JSON retained                                                                                 |
| 4: aggregates      | total matching rows independent of cursor, cheap pending/thread/block counts                                                                                    |
| 5: empty states    | successful explicit zero for pending/thread views                                                                                                               |
| 6: errors          | strict per-command flags, no prompts, sanitized stdout, usage2/runtime1/noop0                                                                                   |
| 7: ambient context | opt-in SDK project hooks, PATH-independent launcher, explicit home retention, repair/removal preservation, Claude/Codex end capture and OpenCode idle snapshots |
| 8: live home       | no-argument pending content, counts and previous local capture                                                                                                  |
| 9: next steps      | selected home/IDs and next cursor carried forward; truncation hints retained                                                                                    |
| 10: help/version   | command help/defaults/examples, executable header, fast version against Node baseline, SDK update                                                               |

`test/cli` exercises the CLI and mocked lifecycle plugins, `test/core` includes exact integer and finite IEEE754 roundtrips, `test/adapters` covers native transport fixtures, and `test/package` installs a packed package outside the source checkout and runs with no Python on PATH. Stalled consumer stdout applies backpressure and parent EOF cancels the wait. The generated installable skill has a mandatory drift check in `make check`. Native lifecycle emission and authenticated behavior remain manual gates below; mock subscriptions are not native observations.

## Claude active-conversation routing

The inbox attaches to the native channel/launch rather than an immutable current
conversation. After `/clear` or `/resume`, pending topics may reach replacement
context; restore explicit thread history and associated generic task context before
processing. Stable message/thread IDs—not a harness-session assertion—control
reply/ack routing. `launch_id` identifies only the MCP process. This is the
operator-approved contract; immutable-conversation fencing is not required.

The direct-entry SDK fixture changes only its receiver's conversation label; it
does not claim to observe a real native lifecycle event. It proves metadata and
thread-history/reply routing remain valid for replacement context, while native
interactive switch/admission/model behavior remains untested. Development/MCP
consent, supported auth and organization policy remain real deployment gates.
The channel emits no notification receipt or registration acknowledgment, so
doctor and startup diagnostics keep those states unknown/unconfirmed.

## Manual native checklist (not run, not passed)

For each supported installed harness, with operator authorization:

1. Launch its documented adapter recipe in a disposable private workspace/store,
   intended native launch/thread, and ordinary permission mode. Confirm original
   native UI/messages and unrelated config are unchanged.
2. While idle post text+data; confirm an actual native user/channel event starts a
   turn. Note the stable mailbox ID. Do not infer from consumer/API write success.
3. During an executing native tool, post another message. Exercise input hooks
   that transform text or handle input, all-vs-partial explicit acknowledgment,
   and the bounded missing-progress failure/recovery path. Confirm delivery only at
   the documented native boundary and before subsequent processing, not keystroke
   injection or competing session resume. Check long tool/retry/compaction behavior.
4. Explicitly incorporate/ack and reply to exact IDs. Confirm reply persisted in
   the right thread, pending cleared only on ack, no transcript auto-forwarding.
5. Exercise a native approval wait; confirm the adapter cannot approve it, UI
   remains usable, and no sandbox/provider policy is relaxed.
6. Crash/restart adapter and switch/reload native sessions. Confirm exclusion,
   release, stable-ID redelivery, Pi generation isolation and Claude active-
   conversation context restoration. For Codex test a
   turn-race rejection and uncertain submission recovery without blind fallback.
7. Claude: test development/MCP consent and actual channel registration under the
   account/org policy, then `/clear`/`/resume` with pending topics. Restore thread
   and generic task context before acting/ack/reply. A policy-blocked channel is
   a deployment blocker, not a passing native check.

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
- MCP SDK v1.x README, docs/server.md, docs/protocol.md and installed SDK stdio
  transport contracts: https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x
- Codex rust-v0.167.0 `codex-rs/app-server/README.md`, app-server-client/README.md,
  app-server-daemon/README.md, cli/src/queue_cmd.rs, ext/queue/src/service.rs,
  app-server-transport/src/transport/unix_socket.rs and stdio.rs, plus generated
  turn-steer types and installed CLI-generated experimental schemas.
- Node `ws` WebSocket client API and `fs-ext` flock contracts from the pinned packages.

The native transports are experimental/version-sensitive. Failures must remain
visible; do not silently replace them with background model polling or PTY input.
