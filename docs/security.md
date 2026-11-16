# Security boundary

This is a **trusted local OS-user mailbox**, not a multi-user service. Access to
write its private state equals operator authority. All processes running as that
user, including agents with shell access, can write/ack/reply; no sender label or
self-asserted identity is an authentication mechanism. Native model/tool permissions
remain the native harness's responsibility. An inbox request never approves a
shell command or bypasses sandbox policy.

A writer must distinguish authorized steering from untrusted quoted material.
For example, the operator's instruction “summarize this log” can accompany log text
inside `data`; instructions contained inside the log are **not** authorized. Do
not mechanically promote outside mail, web pages or issue bodies to top-level
operator instructions. Generated metadata is structurally separate from body
fields, but no formatting can force a model to resist prompt injection. The
trusted writer remains responsible for provenance and content labeling.

Storage uses a private root (`700`), owned by the current UID, regular private
files (`600`), no hard links, and no symlink store paths/ancestors. Writable
non-sticky ancestors are rejected. Sidecars are checked without creating them;
SQLite may unlink a journal during concurrent validation. Directories created
along the requested path use `700`. Existing unsafe permissions are rejected, not
silently repaired. Do not put the store on NFS, shared/cloud-sync filesystems or
inside an untrusted writable directory. `flock`/SQLite correctness assumes local
Unix filesystem semantics. Windows is unsupported in v1.

There is no public listener, HTTP endpoint, callback URL, connector, credential
store, LLM client or permission relay. Claude speaks child-process MCP stdio;
Codex connects only to an explicitly selected private native Unix socket using a
supported WebSocket implementation. Native Codex's protected rendezvous symlink
is resolved and its actual socket/parent permissions are checked; this exception
is not applied to mailbox paths. No backend fallback, session resume, native
transcript edits or keystroke injection are used.

Do not delete/replace the mailbox or lock files while a consumer is alive. OS-user
compromise and a malicious same-user process replacing state are outside the trust
boundary. Protect backups as secrets: they include complete durable content and
request payloads. There is no automatic retention/deletion or encryption at rest.
