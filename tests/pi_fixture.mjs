import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../src/inbox_axi/adapters/pi.ts";

const home = realpathSync(mkdtempSync(join(tmpdir(), "inbox-pi-")));
const root = join(home, "mailbox");
const python = process.env.INBOX_AXI_PYTHON || "python3";
process.env.INBOX_AXI_HOME = root;
process.env.INBOX_AXI_PYTHON = python;
const events = new Map();
const messages = [];
const errors = [];
const statuses = [];
let idle = false;
const pi = {
  on(name, callback) {
    events.set(name, callback);
  },
  sendUserMessage(text, options) {
    messages.push({ text, options });
    idle = false;
  },
};
const ctx = {
  mode: "tui",
  isIdle: () => idle,
  hasPendingMessages: () => false,
  sessionManager: {
    getSessionId: () => "fixture-session",
    getSessionFile: () => "/fixture/session.jsonl",
  },
  ui: {
    notify(message, level) {
      if (level === "error") errors.push(message);
    },
    setStatus(_name, value) {
      statuses.push(value);
    },
  },
};
function cli(args, input) {
  const result = spawnSync(
    python,
    ["-m", "inbox_axi", "--home", root, "--json", ...args],
    { input, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
async function until(test) {
  for (let count = 0; count < 100; count++) {
    if (test()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("fixture timed out");
}
try {
  extension(pi);
  await assert.rejects(
    async () => events.get("session_start")({}, { ...ctx, mode: "rpc" }),
    /interactive/,
  );
  const first = cli(["post", "--body-file", "-"], "operator request");
  events.get("session_start")({}, ctx);
  await until(() => messages.length > 0);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].options, {
    deliverAs: "steer",
    expandPromptTemplates: false,
  });
  assert.ok(messages[0].text.includes(first.id));
  assert.equal(cli(["pending"]).messages[0].id, first.id);
  assert.ok(cli(["status"]).consumer_active);
  assert.ok(statuses.some((value) => value.includes("active")));
  const second = cli(
    ["post", "--body-file", "-"],
    "second steering input during the same busy run",
  );
  cli(["ack", first.id]);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(messages.length, 1);
  const observe = (text, role = "user", context = ctx) =>
    events.get("message_start")(
      { message: { role, content: [{ type: "text", text }] } },
      context,
    );
  observe("unrelated user input mentioning " + first.id);
  observe(messages[0].text, "assistant");
  observe(messages[0].text, "user", {
    ...ctx,
    sessionManager: {
      ...ctx.sessionManager,
      getSessionId: () => "other-session",
    },
  });
  assert.equal(messages.length, 1);
  observe(messages[0].text);
  await until(() => messages.length === 2);
  assert.equal(idle, false);
  assert.ok(messages[1].text.includes(second.id));
  assert.deepEqual(messages[1].options, {
    deliverAs: "steer",
    expandPromptTemplates: false,
  });
  assert.equal(cli(["pending"]).messages[0].id, second.id);
  const third = cli(
    ["post", "--body-file", "-"],
    "third steering input without settlement",
  );
  await new Promise((resolve) => setTimeout(resolve, 1200));
  observe(messages[0].text);
  assert.equal(messages.length, 2);
  cli(["ack", second.id]);
  observe(messages[1].text);
  await until(() => messages.length === 3);
  assert.ok(messages[2].text.includes(third.id));
  assert.equal(idle, false);
  assert.equal(cli(["pending"]).messages[0].id, third.id);
  const oldOffer = messages[2].text;
  await events.get("session_shutdown")();
  assert.equal(cli(["status"]).consumer_active, false);
  events.get("session_start")({}, ctx);
  await until(() => messages.length === 4);
  assert.ok(messages[3].text.includes(third.id));
  assert.notEqual(messages[3].text, oldOffer);
  const fourth = cli(["post", "--body-file", "-"], "new generation request");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  observe(oldOffer);
  assert.equal(messages.length, 4);
  cli(["ack", third.id]);
  observe(messages[3].text);
  await until(() => messages.length === 5);
  assert.ok(messages[4].text.includes(fourth.id));
  await events.get("session_shutdown")();
  observe(messages[4].text);
  assert.equal(messages.length, 5);
  assert.equal(cli(["pending"]).messages.length, 1);
  assert.deepEqual(errors, []);
  console.log("pi fixture passed; not a live native session");
} finally {
  await events.get("session_shutdown")?.();
  rmSync(home, { recursive: true, force: true });
}
