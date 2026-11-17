import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  RPC,
  RpcError,
  deliver,
  deliveryInput,
  threadState,
  run,
} from "../../dist/adapters/codex.js";
import { Store } from "../../src/store.js";
import { canonical, parseJson } from "../../src/codec.js";
import { batchFrame, cliBinding } from "../../dist/adapters/runtime.js";

const thread = "019a7d37-3067-7000-8000-000000000001";
const turn = "019a7d37-3067-7000-8000-000000000002";
async function fixture(t: TestContext) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "inbox-codex-")));
  const store = new Store(join(home, "mailbox"));
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const socket = join(home, "s");
  const calls: Array<Record<string, any>> = [];
  const state = {
    mode: "idle",
    reject: false,
    malformed: false,
    disconnect: false,
    beforeMutation: () => {},
  };
  wss.on("connection", (ws) =>
    ws.on("message", (raw) => {
      const request = JSON.parse(raw.toString());
      calls.push(request);
      const { method, id } = request;
      if (id === undefined) return;
      let result: unknown = {};
      if (method === "initialize")
        result = { userAgent: "codex-tui/0.169.0 fixture", codexHome: home };
      else if (method === "thread/read")
        result = {
          thread: {
            id: thread,
            ephemeral: false,
            canAcceptDirectInput: state.mode !== "unloaded",
            status: { type: state.mode },
          },
        };
      else if (method === "thread/turns/list")
        result = {
          data: [
            {
              id: turn,
              status: state.mode === "active" ? "inProgress" : "completed",
            },
          ],
        };
      else if (method === "turn/steer" || method === "thread/queue/add") {
        state.beforeMutation();
        if (state.disconnect) {
          ws.terminate();
          return;
        }
        if (state.reject) {
          ws.send(
            canonical({ id, error: { code: -32600, message: "turn changed" } }),
          );
          return;
        }
        result = state.malformed
          ? {}
          : method === "turn/steer"
            ? { turnId: turn }
            : { queuedSubmission: { id: "native-queue-id" } };
      } else if (method === "fixture/approval") {
        ws.send(
          canonical({
            id: "approval-1",
            method: "item/commandExecution/requestApproval",
            params: {},
          }),
        );
        return;
      } else if (method === "fixture/timeout") return;
      else if (method === "fixture/duplicate") {
        ws.send('{"id":1,"id":2,"result":{}}');
        return;
      }
      ws.send(canonical({ id, result }));
    }),
  );
  let rpc: RPC | undefined;
  t.after(async () => {
    rpc?.close();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((accept) => wss.close(() => accept()));
    await new Promise<void>((accept) => server.close(() => accept()));
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(socket, accept);
  });
  chmodSync(socket, 0o600);
  rpc = new RPC(socket);
  await rpc.initialize(home, "0.169.0");
  return { home, store, rpc, state, calls, socket };
}

test("codex idle queue and active steer preserve ids and never acknowledge", async (t) => {
  const f = await fixture(t);
  const message = f.store.post({ text: "operator" });
  f.state.beforeMutation = () =>
    assert.ok(
      f.store.deliveryBlock(message.id),
      "block must commit before native mutation",
    );
  assert.equal(
    (await deliver(f.store, f.rpc, thread, "fixture", message)).method,
    "thread/queue/add",
  );
  const first = f.calls.at(-1)!.params;
  f.state.mode = "active";
  assert.equal(
    (await deliver(f.store, f.rpc, thread, "fixture", message)).method,
    "turn/steer",
  );
  const second = f.calls.at(-1)!.params;
  assert.equal(first.clientUserMessageId, second.clientUserMessageId);
  assert.equal(second.expectedTurnId, turn);
  assert.deepEqual(f.store.page({ pending: true }).messages, [message]);
  assert.equal(f.store.deliveryBlock(message.id), null);
  assert.ok(
    !f.calls.some((call) =>
      ["thread/resume", "turn/start"].includes(call.method),
    ),
  );
});

test("codex definite rejection clears block without fallback or acknowledgment", async (t) => {
  const f = await fixture(t);
  f.state.mode = "active";
  f.state.reject = true;
  const message = f.store.post({});
  await assert.rejects(
    deliver(f.store, f.rpc, thread, "fixture", message),
    RpcError,
  );
  assert.equal(f.store.deliveryBlock(message.id), null);
  assert.ok(!f.calls.some((call) => call.method === "thread/queue/add"));
  assert.equal(f.store.status().pending, 1);
});

for (const failure of ["malformed", "disconnect"] as const) {
  test(`codex ${failure} persists uncertainty across store reopen and blocks resend`, async (t) => {
    const f = await fixture(t);
    f.state[failure] = true;
    const message = f.store.post({});
    await assert.rejects(
      deliver(f.store, f.rpc, thread, "fixture", message),
      /uncertain/,
    );
    const count = f.calls.length;
    await assert.rejects(
      deliver(f.store, f.rpc, thread, "fixture", message),
      /blocked/,
    );
    assert.equal(f.calls.length, count);
    const reopened = new Store(f.store.root);
    try {
      assert.ok(reopened.deliveryBlock(message.id));
      assert.equal(reopened.status().blocked_deliveries, 1);
      reopened.retry(message.id);
    } finally {
      reopened.close();
    }
    assert.equal(f.store.deliveryBlock(message.id), null);
    assert.equal(f.store.status().pending, 1);
  });
}

test("codex approvals are never answered and timeout fails closed", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.rpc.call("fixture/approval", {}), /will not answer/);
  assert.ok(!f.calls.some((call) => "result" in call));
  const other = new RPC(f.socket);
  try {
    await assert.rejects(other.call("fixture/timeout", {}, 0.02), /uncertain/);
  } finally {
    other.close();
  }
});

test("codex exact private binding and loaded thread gates", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.rpc.initialize(f.home, "0.167.0"), /mismatch/);
  await assert.rejects(
    f.rpc.initialize(join(f.home, "other"), "0.169.0"),
    /mismatch/,
  );
  f.state.mode = "unloaded";
  await assert.rejects(threadState(f.rpc, thread), /not loaded/);
  chmodSync(f.socket, 0o666);
  assert.throws(() => new RPC(f.socket), /private/);
  await assert.rejects(
    run(f.store, {
      thread: thread.toUpperCase(),
      socket: f.socket,
      codexHome: f.home,
      serverVersion: "0.169.0",
    }),
    /lowercase/,
  );
});

test("codex generated argv restores every history page and exact threaded reply", async (t) => {
  const f = await fixture(t);
  const first = f.store.post({
    text: "first",
    metadata: { task: "generic-task" },
  });
  let message = first;
  for (let i = 0; i < 21; i++)
    message = f.store.post({
      thread_id: first.thread_id,
      parent_id: message.id,
      text: "next",
    });
  const input = deliveryInput(f.store, message);
  const binding = JSON.parse(input.split("\n")[1]!);
  assert.match(input, /before acting, replying or acknowledging/);
  assert.match(input, /until next_cursor is null/);
  assert.match(input, /generic associated task context/);
  assert.match(input, /never automatically forward assistant transcripts/);
  const command = (argv: string[], body?: string) => {
    assert.deepEqual(argv.slice(0, 3), [
      process.execPath,
      resolve("dist/cli.js"),
      argv[2],
    ]);
    const result = spawnSync(argv[0]!, argv.slice(1), {
      input: body,
      encoding: "utf8",
      cwd: f.home,
      env: {
        ...process.env,
        PATH: "",
        HOME: join(f.home, "unused"),
        INBOX_AXI_HOME: "",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const argv = binding.mailbox.read_thread_argv;
  let page = command(argv);
  assert.deepEqual(page.metadata, { task: "generic-task" });
  const history = page.messages;
  while (page.next_cursor !== null) {
    page = command([...argv, "--after", String(page.next_cursor)]);
    history.push(...page.messages);
  }
  assert.equal(history.length, 22);
  const reply = command(binding.mailbox.reply_argv, "explicit reply");
  assert.equal(reply.thread_id, message.thread_id);
  assert.equal(reply.parent_id, message.id);
  assert.equal(reply.direction, "outbound");
  assert.equal(f.store.status().pending, 22);
  assert.ok(command(binding.mailbox.ack_argv).incorporated);
  assert.equal(f.store.status().pending, 21);
});

test("adapter frame codec retains full 64-bit sequences and rejects corrupt framing", () => {
  const frame = batchFrame(
    '{"version":1,"messages":[{"version":1,"id":"msg_00000000000000000000000000000001","thread_id":"thr_00000000000000000000000000000001","seq":9223372036854775807}]}',
  );
  assert.ok("messages" in frame);
  if ("messages" in frame)
    assert.equal(frame.messages[0]!.seq, 9223372036854775807n);
  assert.throws(
    () => batchFrame('{"version":1,"version":1,"messages":[]}'),
    /unique|duplicate/,
  );
  assert.throws(
    () => batchFrame('{"version":1,"messages":[{"id":"spoof"}]}'),
    /invalid/,
  );
  assert.throws(() => cliBinding("relative"), /absolute/);
});
