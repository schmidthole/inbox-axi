# Delivery and recovery

One private mailbox root represents one inbox/workspace. Exactly one active
consumer (Pi, Codex, Claude or manual consume) holds a
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
adapter-outstanding native batch and at most one deferred batch. Input reads pause
behind that bounded slot. A native `message_start` user event releases the slot
when it contains the generated delivery UUID marker and all original message IDs,
under the current durable session ID/file and generation. Whole-text equality is
not required: hooks can prepend/append/reformat text while preserving those IDs.
Unrelated messages, wrong markers and stale observations cannot release the slot.
The next deferred batch can steer during the same continuing busy run.

A one-second, single-flight check also reads `ack-status` for at most eight
outstanding IDs through a five-second/8-KiB bounded CLI call. Explicit incorporation
ack of **all** IDs is trusted operator authority to retire that adapter batch;
partial ack does not release it. The native queue must also be empty as a
conservative guard. This supports hooks that handle input without emitting a user
message, or transformations that remove markers, once the operator explicitly
incorporates the batch. Observation never auto-acks and queue emptiness alone
never proves incorporation, hook completion or delivery.

An async input hook can still be in preflight after an explicit external ack;
Pi's public API does not expose handled/preflight completion. Ack authorizes
progress under the trusted-writer contract, **does not cancel that preflight**, and
is not proof it drained. False/premature ack is caller misuse, not an exactly-once
guarantee. Without a matching observation or all-message explicit ack, five
minutes triggers an actionable error/inactive status, stops the consumer and
releases ownership rather than freezing silently or blindly adding native input.
The bounded status check/shutdown can add up to their timeouts. Pending mail is
retained; native queued/preflight input is not canceled. Inspect pending IDs,
resolve input hooks, explicitly ack only incorporated messages, then relaunch.

Neither an idle flag nor final settlement substitutes for these signals.
Shutdown clears the progress timer, increments the generation fence, kills its
child and discards deferred input, preventing stale callbacks from targeting a
replacement runtime. Ephemeral/noninteractive modes fail.

Claude's normal entry declares the native MCP channel capability and starts the
same deterministic consumer after MCP initialization. It sends bounded native
notifications in order for the active conversation; busy events may batch on its
next native turn, without interrupting an executing tool. The mailbox attaches
to the channel launch, **not** an immutable Claude conversation UUID. After
`/clear` or `/resume`, the new/current conversation may receive the same pending
topics. This is the intended routing contract, not a failed session fence.

Every event preserves generated `thread_id`, `message_id`, `seq` and routing
metadata. `launch_id` identifies only the MCP process and is stable while that
process survives conversation changes; it is not a current-session assertion.
Before acting or replying, restore the relevant thread history (using the explicit
read-thread CLI argv carried in the event), page until `next_cursor` is null, and
restore any generic associated task context from operator metadata. A coordinator
may associate a topic with a task, but inbox-axi neither imports a task database
nor automatically maps identifiers to a lifecycle. Replies require exact thread
and parent IDs, never most-recent conversation/topic selection.

There is **no native notification receipt or channel-registration acknowledgment**.
A successful write proves transport output only; missing development/MCP consent,
auth or organization policy can cause silent native drops. Startup diagnostics
report local consumer readiness with registration/receipt unconfirmed. Check the
native channel notice, `/mcp` and policy/auth diagnostics. Pending input remains
until explicit incorporation ack, and retries/restart can redeliver stable IDs.
Replacement context must restore state before acknowledging; reply does not ack.
Native tool approvals remain in force and no permission relay is declared.

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
