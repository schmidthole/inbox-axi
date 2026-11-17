import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

const home = realpathSync(mkdtempSync(join(tmpdir(), "inbox-claude-")));
const root = join(home, "mailbox");
const node = process.execPath;
const cliPath = resolve("dist/cli.js");
const clients = [];
// this receiver label simulates replacement context, not a native lifecycle signal.
let activeConversation = "initial-fixture-conversation";
const notificationSchema = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z.object({
    content: z.string(),
    meta: z.record(z.string(), z.string()),
  }),
});
function launch() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/adapters/claude.js")],
    env: {
      ...process.env,
      INBOX_AXI_HOME: root,
      INBOX_AXI_NODE: node,
      INBOX_AXI_CLI: cliPath,
    },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "inbox-fixture", version: "0.1.0" },
    { capabilities: {} },
  );
  const state = { client, transport, notices: [], errors: "" };
  clients.push(client);
  transport.stderr.on("data", (data) => {
    state.errors += data;
  });
  client.setNotificationHandler(notificationSchema, async ({ params }) => {
    const [instructions, json] = params.content.split("\n");
    assert.ok(instructions.includes("before acting or replying"));
    state.notices.push({
      ...params,
      message: JSON.parse(json),
      conversation: activeConversation,
      instructions,
    });
    if (state.replaceAfterEight && state.notices.length === 8)
      activeConversation = "replacement-fixture-conversation";
  });
  return state;
}
function cli(args, input) {
  const result = spawnSync(
    node,
    [cliPath, args[0], "--home", root, "--json", ...args.slice(1)],
    { input, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
async function until(test) {
  for (let count = 0; count < 120; count++) {
    if (test()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("fixture timed out");
}
function restoreThread(notice) {
  const argv = JSON.parse(notice.instructions.split("cli argv: ")[1]);
  assert.deepEqual(argv, [
    node,
    cliPath,
    "read-thread",
    "--home",
    root,
    "--json",
    notice.meta.thread_id,
  ]);
  const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
try {
  const first = cli(
    ["post", "--input-json", "-"],
    JSON.stringify({
      text: "authorized request",
      metadata: { topic: "example", task_ref: "operator-owned-context" },
      data: { message_id: "spoof", session_id: "untrusted-body-claim" },
    }),
  );
  const input = [first];
  for (let index = 1; index < 9; index++) {
    input.push(
      cli(
        ["post", "--input-json", "-"],
        JSON.stringify({
          thread_id: first.thread_id,
          parent_id: first.id,
          text: "followup " + index,
        }),
      ),
    );
  }
  const main = launch();
  main.replaceAfterEight = true;
  await main.client.connect(main.transport);
  assert.deepEqual(main.client.getServerCapabilities().experimental, {
    "claude/channel": {},
  });
  assert.ok(main.client.getInstructions().includes("active conversation"));
  assert.ok(
    main.client.getInstructions().includes("restore relevant thread history"),
  );
  const tools = await main.client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    ["ack", "reply"],
  );
  await until(() => main.notices.length >= 8);
  assert.deepEqual(
    main.notices.slice(0, 8).map((notice) => notice.message.id),
    input.slice(0, 8).map((message) => message.id),
  );
  await until(() => main.notices.length === 9);
  assert.equal(main.notices[8].conversation, activeConversation);
  assert.equal(main.notices[8].meta.thread_id, first.thread_id);
  assert.equal(main.notices[0].meta.message_id, first.id);
  assert.equal(main.notices[0].message.data.message_id, "spoof");
  assert.equal(main.notices[0].message.data.session_id, "untrusted-body-claim");
  const launchId = main.notices[0].meta.launch_id;
  assert.match(launchId, /^[0-9a-f-]{36}$/);
  for (const notice of main.notices) {
    assert.equal(notice.meta.launch_id, launchId);
    assert.equal(notice.meta.routing, "active_conversation");
    assert.equal(notice.meta.session_id, undefined);
    assert.equal(notice.meta.message_id, notice.message.id);
    assert.equal(notice.meta.thread_id, notice.message.thread_id);
    assert.equal(notice.meta.seq, String(notice.message.seq));
  }
  const restored = restoreThread(main.notices[8]);
  assert.deepEqual(restored.metadata, {
    topic: "example",
    task_ref: "operator-owned-context",
  });
  assert.deepEqual(restored.messages, input);
  assert.equal(cli(["pending"]).messages.length, 9);
  await until(() =>
    main.errors.includes("registration and receipt unconfirmed"),
  );
  assert.ok(!main.errors.includes("inactive"));

  const competing = launch();
  try {
    await competing.client.connect(competing.transport);
    await until(() => competing.errors.includes("already active"));
    assert.equal(competing.notices.length, 0);
    assert.ok(cli(["status"]).consumer_active);
  } finally {
    await competing.client.close();
  }

  const parent = input[8];
  const args = {
    thread_id: first.thread_id,
    parent_id: parent.id,
    text: "reply after restoring replacement context",
    key: "fixture-reply",
  };
  let result = await main.client.callTool({ name: "reply", arguments: args });
  assert.ok(!result.isError);
  const reply = JSON.parse(result.content[0].text);
  assert.equal(reply.thread_id, first.thread_id);
  assert.equal(reply.parent_id, parent.id);
  result = await main.client.callTool({ name: "reply", arguments: args });
  assert.equal(JSON.parse(result.content[0].text).id, reply.id);
  assert.equal(cli(["pending"]).messages.length, 9);
  const other = cli(["post", "--body-file", "-"], "another topic");
  for (const invalid of [
    { ...args, parent_id: other.id, key: "cross-thread-invalid" },
    { ...args, text: false },
    { thread_id: first.thread_id, parent_id: first.id },
    { ...args, direction: "inbound" },
    { ...args, key: null },
  ]) {
    result = await main.client.callTool({ name: "reply", arguments: invalid });
    assert.ok(result.isError);
  }
  for (const invalid of [
    { message_id: false },
    { message_id: "latest" },
    { message_id: first.id, extra: true },
  ]) {
    result = await main.client.callTool({ name: "ack", arguments: invalid });
    assert.ok(result.isError);
  }
  result = await main.client.callTool({
    name: "ack",
    arguments: { message_id: first.id },
  });
  assert.ok(!result.isError);
  assert.equal(cli(["pending"]).messages.length, 9);
  await main.client.close();
  await until(() => !cli(["status"]).consumer_active);

  activeConversation = "relaunched-fixture-conversation";
  const restarted = launch();
  await restarted.client.connect(restarted.transport);
  await until(() => restarted.notices.length >= 1);
  assert.equal(restarted.notices[0].message.id, input[1].id);
  assert.equal(restarted.notices[0].meta.seq, String(input[1].seq));
  assert.notEqual(restarted.notices[0].meta.launch_id, launchId);
  assert.equal(restarted.notices[0].meta.session_id, undefined);
  assert.equal(
    restoreThread(restarted.notices[0]).messages.at(-1).id,
    reply.id,
  );
  for (const message of [...input.slice(1), other]) {
    result = await restarted.client.callTool({
      name: "ack",
      arguments: { message_id: message.id },
    });
    assert.ok(!result.isError);
  }
  assert.equal(cli(["pending"]).messages.length, 0);
  const pending = cli(["post", "--body-file", "-"], "retain on shutdown");
  await until(() =>
    restarted.notices.some((notice) => notice.message.id === pending.id),
  );
  await restarted.client.close();
  await until(() => !cli(["status"]).consumer_active);
  assert.deepEqual(cli(["pending"]).messages, [pending]);
  console.log(
    "claude direct-entry channel fixture passed; conversation replacement simulated, native admission/live delivery unverified",
  );
} finally {
  for (const client of clients) await client.close();
  rmSync(home, { recursive: true, force: true });
}
