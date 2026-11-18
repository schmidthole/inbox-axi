import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import extension from "../../dist/adapters/pi.js";

const home = mkdtempSync(join(tmpdir(), "inbox-pi-boundary-"));
process.env.INBOX_AXI_HOME = home;
process.env.INBOX_AXI_NODE = process.execPath;
process.env.INBOX_AXI_CLI = resolve("test/adapters/mock-consumer.mjs");
const events = new Map();
const errors = [];
const offers = [];
const pi = {
  on(name, callback) {
    events.set(name, callback);
  },
  sendUserMessage(text) {
    offers.push(text);
  },
  async exec() {
    throw new Error("no receipt may acknowledge");
  },
};
const context = {
  mode: "tui",
  sessionManager: {
    getSessionId: () => "fixture",
    getSessionFile: () => "/fixture/durable.jsonl",
  },
  hasPendingMessages: () => false,
  ui: {
    setStatus() {},
    notify(message, level) {
      if (level === "error") errors.push(message);
    },
  },
};
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((accept) => setTimeout(accept, 25));
  }
  throw new Error("fixture timed out");
}
try {
  extension(pi);
  assert.throws(
    () =>
      events.get("session_start")(
        {},
        {
          ...context,
          sessionManager: {
            getSessionId: () => "fixture",
            getSessionFile: () => undefined,
          },
        },
      ),
    /durable/,
  );
  for (const mode of ["eof", "malformed"]) {
    process.env.INBOX_FIXTURE_MODE = mode;
    process.env.INBOX_FIXTURE_PID = join(home, mode);
    events.get("session_start")({}, context);
    assert.throws(
      () => events.get("session_start")({}, context),
      /already active/,
    );
    await until(() =>
      errors.some((message) =>
        mode === "eof"
          ? message.includes("output closed")
          : message.includes("duplicate json object key"),
      ),
    );
    const pid = Number(readFileSync(process.env.INBOX_FIXTURE_PID, "utf8"));
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    await events.get("session_shutdown")();
  }
  assert.equal(offers.length, 0);
  console.log(
    "pi boundaries fixture passed; eof child liveness and malformed protocol fail closed",
  );
} finally {
  await events.get("session_shutdown")?.();
  rmSync(home, { recursive: true, force: true });
}
