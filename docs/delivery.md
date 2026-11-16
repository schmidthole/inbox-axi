# Delivery and recovery

One private mailbox root represents one inbox/workspace. Exactly one active
consumer (Pi, Codex, experimental Claude fixture or manual consume) holds a
nonblocking exclusive OS `flock` on `consumer.lock`. A competing consumer errors; its writes/pending/read
commands remain usable. Shutdown closes the descriptor; the OS releases it after
crash. Lockfiles remain on disk; their existence does not mean active ownership.
Pi/Claude child consumers also watch a dedicated stdin pipe: parent death/EOF
stops them within one polling interval, even with no pending messages.

The deterministic consumer checks once per second, independent of model turns.
At most eight oldest pending messages form the in-flight window. Per-message
redelivery waits 30, 60, 120, 240, then at most 300 seconds. Explicit incorporation
ack removes an item from the window; subsequent input advances. **An unacked
oldest window intentionally blocks later messages** rather than allowing an
unbounded native queue. Inspect `pending --after ...` to see later input. Restart
may immediately redeliver the same stable IDs; deduplicate IDs in working context.
There is no exactly-once claim and no real-time scheduling guarantee.

Pipe/API write success, observed native receipt, incorporation ack, reply, and
completion are distinct facts. This version retains mailbox pending state until
explicit `ack`. It does not infer model receipt from write success or auto-forward
transcripts. A process crash after submission can duplicate delivery. Ack only
after persisting enough working context to survive your own session reset.

## Native boundaries

Pi's native user-message API wakes idle sessions; busy `steer` delivery waits for
the current assistant turn's tool calls before another model request. While busy,
at most one inbox batch is queued between `agent_settled` events. If a native input
hook handles the message without starting a run, idle polling can retry it rather
than waiting forever for a nonexistent settled event. Suppressed repeats remain
pending and retry later. Shutdown increments a generation fence before killing
its child, so stale callbacks cannot target a replacement runtime. Binding data
contains the exact durable session ID/file; ephemeral/noninteractive modes fail.
Native input handlers may transform/handle messages; no false receipt is asserted.

Claude automatic push is **disabled in the normal entry**. The native MCP channel
protocol lacks an atomic target-session precondition. `/clear` SessionStart hooks
run in the background; checking a hook-updated fence before writing cannot stop a
queued event crossing into a replacement session. `/resume` hook ordering alone
cannot fence all transitions. There is no invented hook synchronization protocol
or silent automatic retargeting. Setup launches tools-only MCP; manually read via
CLI and explicitly call ack/reply. Doctor reports `native_session_fencing:
unsupported`, `automatic_push_enabled: false`. This is a delivery capability
blocker, not merely a missing live test.

The bundled experimental channel factory is tested directly in an offline
fixture, never enabled by normal setup/entry. Its notifications retain original
binding/message/thread metadata and never auto-ack. Channel events queue in order
for the next native turn, potentially batched while busy; executing tools are not
interrupted. There is **no native inbound receipt**. Consent/policy failures can
silently drop notifications. A future enabled deployment must resolve atomic
session fencing or receive explicit operator acceptance of that product risk;
transport fixtures cannot establish it. Tools retain ordinary native approvals;
no remote approval capability is declared.

Codex binds an exact UUID plus socket/home/version; the native TUI must already
have loaded that same thread on that same shared server. Metadata and a one-turn
page select native idle queue versus active `turn/steer`, guarded by
`expectedTurnId` and a stable `clientUserMessageId` derived from the mailbox ID.
Interrupted, unavailable, ephemeral or unsupported threads fail closed. Native
permission requests are not answered by this adapter. No `thread/resume`,
`turn/start`, CLI queue retry with fresh IDs, or alternate backend fallback.
Read/steer races fail visibly and can be relaunched after resolving native state;
there is no immediate queue fallback, even after a definite rejection.

Before a Codex mutating RPC, a durable delivery block is stored. A definitive
JSON-RPC rejection clears it; a matching successful response clears it but does
**not** ack. Timeout, disconnect, malformed response or crash leaves uncertainty
blocked across restarts. `status` counts blocked pending items. Inspect
`delivery-state MESSAGE_ID`; reconcile in the native UI, then either explicitly
`ack MESSAGE_ID` if incorporated, or `retry MESSAGE_ID` to authorize resubmission
and relaunch the adapter. Retry can duplicate an already-applied request; it is
not evidence that the first submission failed. Stable IDs aid deduplication but
are not a promise of native exactly-once semantics.
