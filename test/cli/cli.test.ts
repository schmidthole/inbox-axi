import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  statSync,
  realpathSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { decode } from "@toon-format/toon";
const BIN = resolve("bin/inbox-axi.js");
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "inbox-cli-"));
  const workspace = join(root, "workspace");
  const user = join(root, "user");
  mkdirSync(workspace);
  mkdirSync(user);
  return { root, workspace, user, home: join(root, "mailbox") };
}
function invoke(
  f: ReturnType<typeof fixture>,
  args: string[] = [],
  input?: string,
) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: f.workspace,
    input,
    encoding: "utf8",
    env: { ...process.env, HOME: f.user, INBOX_AXI_HOME: f.home },
  });
}
function json(f: ReturnType<typeof fixture>, args: string[], input?: string) {
  const result = invoke(f, [...args, "--json"], input);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}
function toon(
  f: ReturnType<typeof fixture>,
  args: string[],
  input?: string,
): any {
  const result = invoke(f, args, input);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return decode(result.stdout);
}
test("dashboard, definitive zero, minimal schema, fields, totals and pagination", () => {
  const f = fixture();
  try {
    const dashboard = toon(f, []);
    assert.equal(dashboard.counts.pending, 0);
    assert.match(dashboard.bin, /inbox-axi.js$/);
    assert.match(dashboard.description, /workspace/);
    assert.match(dashboard.result, /0 pending/);
    const first = json(f, ["post", "--body-file", "-"], "hello");
    json(f, ["post", "--thread", first.thread_id, "--body-file", "-"], "again");
    const page = toon(f, ["pending", "--limit", "1"]);
    assert.equal(page.total, 2);
    assert.equal(page.count, 1);
    assert.deepEqual(Object.keys(page.messages[0]), [
      "id",
      "thread_id",
      "direction",
      "text",
    ]);
    assert.match(
      page.help[1],
      new RegExp(`--home.*${f.home}.*pending --after`),
    );
    const fields = toon(f, ["pending", "--fields", "id,seq,data"]);
    assert.deepEqual(Object.keys(fields.messages[0]), ["id", "seq", "data"]);
    const next = json(f, ["pending", "--after", String(page.next_cursor)]);
    assert.equal(next.total, 2);
    assert.equal(next.messages.length, 1);
    assert.equal(next.next_cursor, null);
    const ack = json(f, ["ack", first.id]);
    assert.ok(ack);
    assert.deepEqual(json(f, ["ack", first.id]), ack);
    assert.equal(
      json(f, ["ack-status", first.id]).acknowledgments[0].incorporated,
      true,
    );
    const thread = json(f, ["read-thread", first.thread_id]);
    assert.equal(thread.messages.length, 2);
    const outbound = json(
      f,
      [
        "reply",
        "--thread",
        first.thread_id,
        "--parent",
        first.id,
        "--body-file",
        "-",
      ],
      "answer",
    );
    assert.equal(outbound.direction, "outbound");
    assert.equal(json(f, ["status"]).pending, 1);
    assert.equal(json(f, ["delivery-state", first.id]).block, null);
    assert.ok(json(f, ["retry", first.id]));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
test("previews show lengths, full escape and lossless data; json always full", () => {
  const f = fixture();
  try {
    const body = "😀".repeat(900);
    const request = `{"text":${JSON.stringify(body)},"data":{"number":9223372036854775807,"body":"${"x".repeat(900)}"}}`;
    const posted = toon(f, ["post", "--input-json", "-"], request);
    assert.equal(posted.text_length, 900);
    assert.ok(posted.data_length > 900);
    assert.ok(posted.help.some((x: string) => x.includes("--full")));
    const detail = toon(f, [
      "read-thread",
      posted.thread_id,
      "--fields",
      "id,text,data",
    ]);
    assert.equal(detail.messages[0].text_length, 900);
    assert.match(detail.messages[0].data, /truncated/);
    const full = toon(f, [
      "read-thread",
      posted.thread_id,
      "--fields",
      "id,text,data",
      "--full",
    ]);
    assert.equal(full.messages[0].text, body);
    assert.match(full.messages[0].data, /9223372036854775807/);
    assert.equal(full.messages[0].text_length, undefined);
    assert.equal(full.messages[0].help, undefined);
    const machine = invoke(f, [
      "read-thread",
      posted.thread_id,
      "--json",
      "--fields",
      "id",
    ]);
    assert.match(machine.stdout, /9223372036854775807/);
    assert.match(machine.stdout, /"text":/);
    const reply = toon(
      f,
      [
        "reply",
        "--thread",
        posted.thread_id,
        "--parent",
        posted.id,
        "--body-file",
        "-",
      ],
      body,
    );
    assert.ok(reply.help.some((x: string) => x.includes("--full")));
    assert.ok(!reply.help.some((x: string) => x.includes(" ack ")));
    const short = toon(f, ["post", "--body-file", "-"], "short");
    assert.equal(short.text_length, undefined);
    assert.ok(!short.help.some((x: string) => x.includes("--full")));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
test("strict flags, validation before store creation and sanitized stdout failures", () => {
  const f = fixture();
  try {
    for (const args of [
      ["pending", "--lim", "2"],
      ["pending", "--after", "-1"],
      ["pending", "--limit", "0"],
      ["status", "extra"],
      ["post"],
      ["codex"],
      ["post", "--body-file", "-", "--input-json", "-"],
      ["pending", "--fields", "bad"],
      ["--home"],
      ["no-such-command"],
      ["constructor"],
      ["toString", "--help"],
    ]) {
      const result = invoke(f, [...args, "--json"], "{}");
      assert.equal(result.status, 2, JSON.stringify({ args, ...result }));
      const value = JSON.parse(result.stdout);
      assert.equal(value.code, "VALIDATION_ERROR");
      assert.ok(value.help.length);
      assert.ok(!/node_modules|Error:| at /.test(result.stdout));
    }
    assert.deepEqual(readdirSync(f.user), []);
    assert.equal(statSync(f.workspace).isDirectory(), true);
    const missing = invoke(f, [
      "post",
      "--body-file",
      join(f.root, "missing"),
      "--json",
    ]);
    assert.equal(missing.status, 1);
    assert.equal(
      JSON.parse(missing.stdout).error,
      "unable to complete inbox operation",
    );
    for (const raw of [
      '{"text":"a","text":"a"}',
      '{"text":NaN}',
      '{"text":"a","id":"bad"}',
    ])
      assert.equal(
        invoke(f, ["post", "--input-json", "-", "--json"], raw).status,
        2,
      );
    assert.equal(
      invoke(f, ["post", "--body-file", "-", "--json"], "x".repeat(65537))
        .status,
      2,
    );
    const leading = invoke(f, ["--home", f.home, "--json", "pending"]);
    assert.equal(leading.status, 0);
    assert.equal(JSON.parse(leading.stdout).total, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
test("all command help is complete and version is bare with no config/store writes", () => {
  const f = fixture();
  try {
    for (const command of [
      "init",
      "post",
      "reply",
      "read-thread",
      "pending",
      "ack",
      "ack-status",
      "delivery-state",
      "retry",
      "codex",
      "status",
      "consume",
      "setup",
      "doctor",
      "uninstall",
      "capture",
      "update",
    ]) {
      const result = invoke(f, [command, "--help"]);
      assert.equal(result.status, 0, result.stdout);
      assert.match(result.stdout, /examples/);
      assert.match(result.stdout, /flags/);
    }
    for (const flag of ["-v", "-V", "--version"]) {
      const result = invoke(f, [flag]);
      assert.equal(result.status, 0);
      assert.equal(result.stdout, "0.2.0\n");
      assert.equal(result.stderr, "");
    }
    assert.deepEqual(readdirSync(f.workspace), []);
    assert.deepEqual(readdirSync(f.user), []);
    const before = performance.now();
    for (let i = 0; i < 4; i++)
      spawnSync(process.execPath, ["-e", "console.log(1)"]);
    const floor = (performance.now() - before) / 4;
    const start = performance.now();
    for (let i = 0; i < 4; i++) invoke(f, ["--version"]);
    assert.ok(
      (performance.now() - start) / 4 < floor * 8 + 25,
      "version should stay close to node startup",
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
test("workspace hooks opt in, repair, scope, capture and uninstall preserve unrelated config", () => {
  const f = fixture();
  try {
    json(f, ["status"]);
    assert.deepEqual(readdirSync(f.workspace), []);
    mkdirSync(join(f.workspace, ".claude"));
    writeFileSync(
      join(f.workspace, ".claude", "settings.json"),
      JSON.stringify({
        unrelated: 42,
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "echo keep" }] },
          ],
          SessionEnd: [{ hooks: [{ type: "command", command: "echo end" }] }],
        },
      }),
    );
    const installed = json(f, ["setup", "hooks", "--home", f.home]);
    assert.ok(installed.hooks.claude.installed);
    assert.ok(installed.hooks.codex.installed);
    assert.ok(installed.hooks.opencode.installed);
    const config = () =>
      JSON.parse(
        readFileSync(join(f.workspace, ".claude", "settings.json"), "utf8"),
      );
    const first = readFileSync(
      join(f.workspace, ".claude", "settings.json"),
      "utf8",
    );
    json(f, ["setup", "hooks", "--home", f.home]);
    assert.equal(
      readFileSync(join(f.workspace, ".claude", "settings.json"), "utf8"),
      first,
    );
    const command = config()
      .hooks.SessionStart.flatMap((g: any) => g.hooks)
      .find((h: any) => h.command.includes("inbox-axi")).command;
    const callback = spawnSync("/bin/sh", ["-c", command], {
      cwd: f.workspace,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: f.user,
        PATH: "/nonexistent",
        INBOX_AXI_HOME: join(f.root, "wrong"),
      },
    });
    assert.equal(callback.status, 0, callback.stdout + callback.stderr);
    assert.equal((decode(callback.stdout) as any).home, f.home);
    const end = config()
      .hooks.SessionEnd.flatMap((g: any) => g.hooks)
      .find((h: any) => h.command.includes("inbox-axi")).command;
    const captured = spawnSync("/bin/sh", ["-c", end], {
      cwd: f.workspace,
      encoding: "utf8",
      input: '{"transcript_path":"/never-read"}',
      env: { ...process.env, HOME: f.user, PATH: "/nonexistent" },
    });
    assert.equal(captured.status, 0, captured.stdout + captured.stderr);
    const context = JSON.parse(
      readFileSync(join(f.home, "session-context.json"), "utf8"),
    );
    assert.equal(context.boundary, "session-end");
    assert.equal(context.transcript_path, undefined);
    assert.equal(context.text, undefined);
    assert.equal(
      statSync(join(f.home, "session-context.json")).mode & 0o777,
      0o600,
    );
    assert.equal(toon(f, []).previous_session.boundary, "session-end");
    const repaired = config();
    repaired.hooks.SessionStart.find((g: any) =>
      g.hooks.some((h: any) => h.command.includes("inbox-axi")),
    ).hooks[0].command = "/old/inbox-axi";
    writeFileSync(
      join(f.workspace, ".claude", "settings.json"),
      JSON.stringify(repaired),
    );
    json(f, ["setup", "hooks", "--home", f.home]);
    assert.ok(
      !readFileSync(
        join(f.workspace, ".claude", "settings.json"),
        "utf8",
      ).includes("/old/inbox-axi"),
    );
    const removed = json(f, ["uninstall", "hooks"]);
    assert.equal(removed.hooks.claude.installed, false);
    assert.equal(config().unrelated, 42);
    assert.equal(config().hooks.SessionStart[0].hooks[0].command, "echo keep");
    assert.equal(config().hooks.SessionEnd[0].hooks[0].command, "echo end");
    assert.match(
      readFileSync(join(f.user, ".codex", "config.toml"), "utf8"),
      /hooks = true/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
test("tilde homes expand for recipes, hook launchers and the mailbox", () => {
  const f = fixture();
  try {
    assert.equal(
      json(f, ["setup", "pi", "--home", "~"]).environment.INBOX_AXI_HOME,
      f.user,
    );
    assert.equal(
      json(f, ["setup", "codex", "--home", "~/mailbox"]).environment
        .INBOX_AXI_HOME,
      join(f.user, "mailbox"),
    );
    assert.equal(
      json(f, ["setup", "claude", "--home", "~mailbox"]).environment
        .INBOX_AXI_HOME,
      join(f.workspace, "~mailbox"),
    );
    const posted = json(
      f,
      ["post", "--home", "~/mailbox", "--body-file", "-"],
      "tilde",
    );
    assert.equal(posted.text, "tilde");
    assert.equal(existsSync(join(f.user, "mailbox", "inbox.sqlite3")), true);
    assert.equal(existsSync(join(f.workspace, "~")), false);
    json(f, ["setup", "hooks", "--home", "~/mailbox"]);
    const launcher = readFileSync(
      join(f.workspace, ".inbox-axi-hooks", "inbox-axi"),
      "utf8",
    );
    assert.ok(launcher.includes(join(f.user, "mailbox")));
    assert.equal(launcher.includes("/~/"), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
test("native recipes preserve custom home and bundle compiled assets without executing them", () => {
  const f = fixture();
  try {
    for (const harness of ["pi", "claude", "codex"]) {
      const value = json(f, ["setup", harness, "--home", f.home]);
      assert.equal(value.writes_config, false);
      assert.equal(value.capability_verified, false);
      assert.equal(value.environment.INBOX_AXI_HOME, f.home);
      assert.equal(value.environment.INBOX_AXI_NODE, process.execPath);
      assert.match(value.environment.INBOX_AXI_CLI, /dist\/cli.js$/);
      assert.ok(!JSON.stringify(value).includes("python"));
      assert.equal(json(f, ["doctor", harness]).capability_verified, false);
    }
    assert.ok(json(f, ["uninstall"]).instructions);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
test("consume parent eof releases consumer and emits only stable json-lines", async () => {
  const f = fixture();
  try {
    json(f, ["post", "--body-file", "-"], "consume me");
    const child = spawn(
      process.execPath,
      [BIN, "consume", "--home", f.home, "--parent-pipe"],
      { cwd: f.workspace, stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes('"messages"')) child.stdin.end();
    });
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0, output);
    const frames = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(frames[0], { event: "ready", version: 1 });
    assert.equal(frames[1].messages[0].text, "consume me");
    assert.equal(json(f, ["status"]).consumer_active, false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("opencode capture plugin supports idle snapshots and v2 abort cleanup", async () => {
  const f = fixture();
  try {
    json(f, ["setup", "hooks", "--home", f.home]);
    const path = join(
      f.workspace,
      ".opencode",
      "plugins",
      "inbox-axi-capture.js",
    );
    const plugin = (await import("file://" + path)).default;
    const server = await plugin.server({ directory: f.workspace });
    await server.event({ event: { type: "session.idle" } });
    const contextPath = join(f.home, "session-context.json");
    for (let n = 0; n < 50; n++) {
      try {
        if (
          JSON.parse(readFileSync(contextPath, "utf8")).boundary ===
          "session-idle"
        )
          break;
      } catch {}
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(
      JSON.parse(readFileSync(contextPath, "utf8")).boundary,
      "session-idle",
    );
    let signal: AbortSignal | undefined;
    const cleanup = await plugin.setup({
      location: { directory: f.workspace },
      event: {
        async *subscribe(options: { signal: AbortSignal }) {
          signal = options.signal;
          yield { type: "session.idle" };
          await new Promise<void>((r) =>
            signal!.addEventListener("abort", () => r(), { once: true }),
          );
        },
      },
    });
    await new Promise((r) => setTimeout(r, 100));
    cleanup();
    assert.equal(signal?.aborted, true);
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test(
  "consume cancels stdout backpressure on parent eof without polling more batches",
  { timeout: 10000 },
  async () => {
    const f = fixture();
    try {
      const { Store } = await import("../../src/store.js");
      const store = new Store(f.home);
      for (let n = 0; n < 20; n++) store.post({ text: "x".repeat(16000) });
      store.close();
      const child = spawn(
        process.execPath,
        [BIN, "consume", "--home", f.home, "--parent-pipe"],
        { cwd: f.workspace, stdio: ["pipe", "pipe", "pipe"] },
      );
      child.stdout.pause();
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stdout.pause();
      const exited = new Promise<number | null>((r) => child.once("exit", r));
      await new Promise((r) => setTimeout(r, 250));
      child.stdin.end();
      const code = await Promise.race([
        exited,
        new Promise<string>((r) => setTimeout(() => r("timeout"), 3000)),
      ]);
      assert.equal(code, 0);
      child.stdout.resume();
      await new Promise((r) => child.once("close", r));
      const frames = output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((x) => JSON.parse(x));
      assert.equal(frames[0].event, "ready");
      assert.ok(frames.filter((x) => x.messages).length <= 1);
      assert.equal(json(f, ["status"]).consumer_active, false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

function executeHint(f: ReturnType<typeof fixture>, command: string): any {
  const path = join(f.root, "bin");
  mkdirSync(path, { recursive: true });
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const wrapper = join(path, "inbox-axi");
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(BIN)} "$@"\n`,
  );
  chmodSync(wrapper, 0o700);
  const result = spawnSync("/bin/sh", ["-c", command], {
    cwd: f.workspace,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: f.user,
      PATH: path,
      INBOX_AXI_HOME: join(f.root, "different-mailbox"),
    },
  });
  assert.equal(
    result.status,
    0,
    command + "\n" + result.stdout + result.stderr,
  );
  return decode(result.stdout);
}
function fullHint(value: { help: string[] }): string {
  const command = value.help.find((line) => line.includes("--full"));
  assert.ok(command, "truncated content must provide a full command");
  return command;
}
function continuation(value: { help: string[] }): string {
  const command = value.help.find((line) => line.includes("--after"));
  assert.ok(command, "a partial page must provide a continuation command");
  return command;
}
function expanded(
  f: ReturnType<typeof fixture>,
  preview: { help: string[] },
  id: string,
  text: string,
  data: unknown,
) {
  const page = executeHint(f, fullHint(preview));
  assert.equal(page.count, 1);
  assert.equal(page.messages[0].id, id);
  assert.equal(page.messages[0].text, text);
  assert.deepEqual(JSON.parse(page.messages[0].data), data);
  assert.equal(page.messages[0].text_length, undefined);
  assert.equal(page.messages[0].data_length, undefined);
}
test("executed full hints reach later-page post reply pending and thread content across sequence gaps", async () => {
  const f = fixture();
  f.home = join(f.root, "mailbox with 'quotes' $cash `literal`");
  try {
    const { Store } = await import("../../src/store.js");
    const store = new Store(f.home);
    const first = store.post({ text: "short 0" });
    let previous = first;
    for (let n = 1; n < 20; n++) {
      store.post({ text: "another thread" });
      previous = store.post({ thread_id: first.thread_id, text: `short ${n}` });
    }
    store.close();
    const text = "later-page text ".repeat(90);
    const data = { body: "later-page data ".repeat(90) };
    const posted = toon(
      f,
      ["post", "--home", f.home, "--input-json", "-"],
      JSON.stringify({ thread_id: first.thread_id, text, data }),
    );
    expanded(f, posted, posted.id, text, data);
    const reply = toon(
      f,
      ["reply", "--home", f.home, "--input-json", "-"],
      JSON.stringify({
        thread_id: first.thread_id,
        parent_id: posted.id,
        text,
        data,
      }),
    );
    expanded(f, reply, reply.id, text, data);
    const pending = toon(f, [
      "pending",
      "--home",
      f.home,
      "--after",
      String(previous.seq),
      "--fields",
      "text,data",
    ]);
    assert.equal(pending.messages.length, 1);
    assert.equal(pending.messages[0].seq, undefined);
    expanded(f, pending.messages[0], posted.id, text, data);
    const detail = toon(f, [
      "read-thread",
      first.thread_id,
      "--home",
      f.home,
      "--after",
      String(previous.seq),
      "--fields",
      "text,data",
    ]);
    assert.equal(detail.messages.length, 2);
    for (const [n, id] of [posted.id, reply.id].entries())
      expanded(f, detail.messages[n], id, text, data);
    const machine = json(f, [
      "read-thread",
      first.thread_id,
      "--after",
      String(previous.seq),
      "--fields",
      "id",
    ]);
    assert.equal(machine.messages[0].text, text);
    assert.deepEqual(machine.messages[0].data, data);
    for (const selector of [["read-thread", first.thread_id], ["pending"]]) {
      const firstPage = toon(f, [
        ...selector,
        "--home",
        f.home,
        "--limit",
        "20",
        "--full",
        "--fields",
        "id,text,data",
      ]);
      const nextPage = executeHint(f, continuation(firstPage));
      assert.equal(nextPage.count, selector[0] === "pending" ? 20 : 2);
      const target = nextPage.messages.find(
        (message: { id: string }) => message.id === posted.id,
      );
      assert.ok(target);
      assert.deepEqual(Object.keys(target), ["id", "text", "data"]);
      assert.equal(target.text, text);
      assert.deepEqual(JSON.parse(target.data), data);
      assert.equal(target.help, undefined);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
test("executed full and continuation hints preserve exact signed64 cursors with seq omitted", async () => {
  const f = fixture();
  try {
    const { Store } = await import("../../src/store.js");
    const store = new Store(f.home);
    const first = store.post({ text: "first" });
    store.db
      .prepare("update sqlite_sequence set seq=? where name=?")
      .run(9223372036854775804n, "messages");
    store.post({ text: "unrelated thread" });
    store.close();
    const text = "large cursor text ".repeat(90),
      data = { body: "large cursor data ".repeat(90) };
    const posted = toon(
      f,
      [
        "post",
        "--home",
        f.home,
        "--fields",
        "id,text,data",
        "--input-json",
        "-",
      ],
      JSON.stringify({ thread_id: first.thread_id, text, data }),
    );
    assert.equal(posted.seq, undefined);
    expanded(f, posted, posted.id, text, data);
    const reply = toon(
      f,
      [
        "reply",
        "--home",
        f.home,
        "--fields",
        "id,text,data",
        "--input-json",
        "-",
      ],
      JSON.stringify({
        thread_id: first.thread_id,
        parent_id: posted.id,
        text,
        data,
      }),
    );
    expanded(f, reply, reply.id, text, data);
    const pending = toon(f, [
      "pending",
      "--home",
      f.home,
      "--after",
      "9223372036854775805",
      "--fields",
      "text,data",
    ]);
    expanded(f, pending.messages[0], posted.id, text, data);
    const page = toon(f, [
      "read-thread",
      first.thread_id,
      "--home",
      f.home,
      "--after",
      "1",
      "--limit",
      "1",
      "--full",
      "--fields",
      "id,text,data",
    ]);
    assert.equal(page.next_cursor, "9223372036854775806");
    const next = executeHint(f, continuation(page));
    assert.equal(next.count, 1);
    assert.equal(next.messages[0].id, reply.id);
    assert.equal(next.messages[0].text, text);
    assert.deepEqual(JSON.parse(next.messages[0].data), data);
    assert.deepEqual(Object.keys(next.messages[0]), ["id", "text", "data"]);
    const detail = toon(f, [
      "read-thread",
      first.thread_id,
      "--home",
      f.home,
      "--after",
      "9223372036854775806",
      "--fields",
      "text,data",
    ]);
    expanded(f, detail.messages[0], reply.id, text, data);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
