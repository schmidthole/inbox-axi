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
let idle = true;
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
  cli(["ack", first.id]);
  cli(["post", "--body-file", "-"], "must wait for safe settlement");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(messages.length, 1);
  events.get("agent_settled")();
  await events.get("session_shutdown")();
  assert.equal(cli(["status"]).consumer_active, false);
  events.get("session_start")({}, ctx);
  await until(() => messages.length === 2);
  await events.get("session_shutdown")();
  assert.equal(cli(["pending"]).messages.length, 1);
  assert.deepEqual(errors, []);
  console.log("pi fixture passed; not a live native session");
} finally {
  await events.get("session_shutdown")?.();
  rmSync(home, { recursive: true, force: true });
}
