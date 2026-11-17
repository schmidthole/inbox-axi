# inbox-axi

A private, durable operator inbox for external programs and native coding-agent sessions. Explicit thread/reply IDs, JSON data and incorporation acknowledgments; no task runtime, scheduler or transcript forwarding.

Version 0.2 ports the runtime to TypeScript: **Node >=24, Unix/macOS, local SQLite**. Native dependencies require a supported C/C++ build toolchain during npm installation. No Python runtime is used. Native adapter protocol fixtures are tested; authenticated idle wake, busy steering, policy admission and UI behavior remain **not live-verified**.

## Quickstart

```sh
npm install -g inbox-axi
inbox-axi
printf '%s' 'please inspect this result' | inbox-axi post --body-file - --key external-1 --json
inbox-axi pending
inbox-axi read-thread <thread-id> --full
printf '%s' 'reviewed; here is my response' | inbox-axi reply --thread <thread-id> --parent <message-id> --body-file -
inbox-axi ack <message-id>
```

Use actual returned IDs. Replying never acknowledges. Ack means incorporated into durable working context, not completed. Treat outside content as quoted data, never automatically as operator instructions.

The default mailbox is **`.inbox-axi` in the current working directory**. `INBOX_AXI_HOME` or `--home /physical/private/path` selects another root. Use one root per workspace; commands launched in subdirectories have their own default root, so pass an explicit root when sharing across directories. Roots must be owned by your OS user, mode `700`; private files `600`. Symlink paths/ancestors are rejected; use physical paths such as `/private/tmp` on macOS. Do not commit mailbox content.

Default ordinary stdout uses official TOON through `axi-sdk-js`; `--json` retains full machine envelopes and exact 64-bit numeric tokens. Pages default to 20 messages, maximum 100, include total counts and an exclusive `next_cursor`. Default lists use four fields; use `--fields id,thread_id,seq,text,data` to choose others. Text/data detail previews truncate at 800 characters and include total length plus an actionable `--full` hint only when truncated. Full and JSON remain page-bounded. Command-first flags are canonical; global flags can also precede the command. Unknown flags and positional arguments fail immediately. Errors are structured stdout: success/no-op `0`, operational error `1`, usage `2`. No prompts.

## Ambient discovery

```sh
inbox-axi setup hooks
inbox-axi doctor hooks
inbox-axi uninstall hooks
```

Explicit setup installs/repairs **project-scoped** Claude/Codex startup hooks and an OpenCode ambient-context plugin through the AXI SDK. Ordinary commands never install hooks. Setup also enables the shared **user-level Codex `config.toml` hooks feature**, required by Codex; uninstall retains that shared flag. Existing unrelated settings are preserved. Session start shows only the mailbox selected by the current directory/environment. Claude and Codex `SessionEnd` capture only timestamp, workspace and counts locally; no stdin/transcript or message content is captured or forwarded. OpenCode captures documented `session.idle` snapshots, which do not imply session end. For other boundaries use `inbox-axi capture` explicitly. Native lifecycle emission remains subject to each harness's documented support and timing.

Alternatively install the static [agent skill](skills/inbox-axi/SKILL.md):

```sh
npx skills add schmidthole/inbox-axi --skill inbox-axi
```

Hooks provide live startup context; the skill provides discovery on demand. Install either or both. The skill is generated from the same static home guidance, strips live state, and uses `npx -y inbox-axi`; `make check` rejects drift.

## External programs and native sessions

```sh
printf '%s' '{"text":"review result","data":{"score":42},"key":"job-42","metadata":{"project":"example"}}' | inbox-axi post --input-json - --json
inbox-axi setup pi --json
inbox-axi setup claude --json
inbox-axi setup codex --json
inbox-axi doctor pi --json
```

Native setup prints recipes and does not run them or rewrite config. Pi uses its native user-message extension; Claude uses the bundled Node MCP channel and routes pending topics to the active conversation, including after `/clear`/`/resume`; Codex binds an exact existing native thread, socket, home and server version. Restore exact inbox thread history and generic associated task context before acting in replacement context. Native launch consent/auth/policy and experimental version gates remain required. No session resume, permission relay, automatic acknowledgment or assistant-output forwarding.

[`examples/external-program.mjs`](examples/external-program.mjs) · [Installation](docs/install.md) · [Protocol](docs/protocol.md) · [Delivery](docs/delivery.md) · [Security](docs/security.md) · [Verification](docs/verification.md)

## Development

```sh
npm ci
make format
make test
make check
npm pack
```

`make check` builds/types checks, formats, checks generated skill drift, runs isolated unit/protocol/CLI/native fixtures and verifies a packed install outside the source tree. No hosted CI workflow is configured. Tests use disposable stores/config homes and mocked native APIs; no model calls or real native session mutations.

**License:** the owner has not specified one; no license or copyright ownership is invented. Dependencies retain their own licenses.
