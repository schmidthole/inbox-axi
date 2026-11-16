# Delivery and recovery

One private mailbox root represents one inbox/workspace. Exactly one active
consumer (Pi, Codex, experimental Claude fixture or manual consume) holds a
nonblocking exclusive OS `flock` on `consumer.lock`. A competing consumer errors; its writes/pending/read
commands remain usable. Shutdown closes the descriptor; the OS releases it after
crash. Lockfiles remain on disk; their existence does not mean active ownership.
Pi/Claude child consumers also watch a dedicated stdin pipe: parent death/EOF
stops them within one polling interval, even with no pending messages.

The deterministic consumer checks once per second, independent of model turns.
Each offer contains at most eight messages. New pending input is admitted in FIFO
server order independently of older unacknowledged input. When both classes have
work, each poll reserves four slots for new input and four for due retries; either
class can use the other's unused slots. Retries are selected by earliest due time,
then server sequence, so continuing new traffic cannot starve them. The emitted
batch is ordered by server sequence. Old unacknowledged input no longer blocks
message nine or subsequent operator steering.

Per-message redelivery waits 30, 60, 120, 240, then at most 300 seconds. Scheduling
metadata lives in a connection-private, file-backed SQLite temporary table, with
one small record per offered pending message, not a growing in-memory batch or
native queue. Acked records are excluded and removed on the next poll. Only bounded
query pages/batches are loaded into Python memory. The table disappears on consumer
shutdown/crash; restart can immediately redeliver stable message IDs in FIFO order.
Deduplicate IDs in working context. There is no exactly-once claim, fixed delivery
latency under unlimited incoming traffic, or real-time scheduling guarantee.

Pipe/API write success, observed native receipt, incorporation ack, reply, and
completion are distinct facts. This version retains mailbox pending state until
explicit `ack`. It does not infer model receipt from write success or auto-forward
transcripts. A process crash after submission can duplicate delivery. Ack only
after persisting enough working context to survive your own session reset.

## Native boundaries

Pi's native user-message API wakes idle sessions; busy `steer` delivery waits for
the current assistant turn's tool calls before another model request. There is one
outstanding native batch and at most one deferred batch. Input reads pause behind
that bounded slot. A matching native `message_start` user event releases the slot
as soon as the batch is observed consumed, even while the same agent run remains
busy. Matching requires the exact injected text, including stable envelope IDs and
a fresh per-offer delivery UUID, plus the current durable session ID/file and
runtime generation. Unrelated messages and stale observations cannot release it.
The next deferred batch can then steer before the run finally settles.

Native observation is not incorporation: no automatic ack occurs. Pending input
still retries with consumer backoff. A genuinely idle session with no native
pending messages can also reopen the slot, including when an input hook handled a
message without starting a run. Input hooks that transform injected content can
prevent exact observation matching; the adapter does not mistake unrelated text
for receipt. Shutdown increments a generation fence before killing its child and
discarding deferred input, so callbacks cannot target a replacement runtime.
Ephemeral/noninteractive modes fail.

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
