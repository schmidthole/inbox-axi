import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "../src/inbox_axi/adapters/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../src/inbox_axi/adapters/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import { z } from "../src/inbox_axi/adapters/node_modules/zod/index.js";

const home = realpathSync(mkdtempSync(join(tmpdir(), "inbox-claude-")));
const root = join(home, "mailbox");
const python = process.env.INBOX_AXI_PYTHON || "python3";
const notices = [];
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("tests/claude_fixture_server.mjs")],
  env: {
    ...process.env,
    INBOX_AXI_HOME: root,
    INBOX_AXI_PYTHON: python,
    INBOX_AXI_SESSION: "019a7d37-3067-7000-8000-000000000001",
  },
  stderr: "pipe",
});
const client = new Client(
  { name: "inbox-fixture", version: "0.1.0" },
  { capabilities: {} },
);
let errors = "";
transport.stderr.on("data", (data) => {
  errors += data;
});
client.setNotificationHandler(
  z.object({
    method: z.literal("notifications/claude/channel"),
    params: z.object({
      content: z.string(),
      meta: z.record(z.string(), z.string()),
    }),
  }),
  async (event) => {
    notices.push(event.params);
  },
);
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
  throw new Error("fixture timed out: " + errors);
}
try {
  const first = cli(
    ["post", "--input-json", "-"],
    JSON.stringify({
      text: "authorized request",
      data: { message_id: "spoof" },
    }),
  );
  await client.connect(transport);
  assert.deepEqual(client.getServerCapabilities().experimental, {
    "claude/channel": {},
  });
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    ["ack", "reply"],
  );
  await until(() => notices.length > 0);
  assert.equal(notices[0].meta.message_id, first.id);
  assert.equal(JSON.parse(notices[0].content).data.message_id, "spoof");
  assert.equal(cli(["pending"]).messages[0].id, first.id);
  let result = await client.callTool({
    name: "reply",
    arguments: {
      thread_id: first.thread_id,
      parent_id: first.id,
      text: "explicit",
      key: "fixture-reply",
    },
  });
  assert.ok(!result.isError);
  const reply = JSON.parse(result.content[0].text);
  assert.equal(reply.parent_id, first.id);
  const retried = await client.callTool({
    name: "reply",
    arguments: {
      thread_id: first.thread_id,
      parent_id: first.id,
      text: "explicit",
      key: "fixture-reply",
    },
  });
  assert.equal(JSON.parse(retried.content[0].text).id, reply.id);
  result = await client.callTool({
    name: "reply",
    arguments: {
      thread_id: first.thread_id,
      parent_id: first.id,
      text: "invalid",
      direction: "inbound",
    },
  });
  assert.ok(result.isError);
  result = await client.callTool({
    name: "ack",
    arguments: { message_id: false },
  });
  assert.ok(result.isError);
  result = await client.callTool({
    name: "ack",
    arguments: { message_id: first.id },
  });
  assert.ok(!result.isError);
  assert.equal(cli(["pending"]).messages.length, 0);
  await client.close();
  await until(() => !cli(["status"]).consumer_active);
  assert.equal(errors, "");
  const manual = cli(["post", "--body-file", "-"], "manual only");
  const safeTransport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("src/inbox_axi/adapters/claude.mjs")],
    env: {
      ...process.env,
      INBOX_AXI_HOME: root,
      INBOX_AXI_PYTHON: python,
      INBOX_AXI_SESSION: "019a7d37-3067-7000-8000-000000000001",
    },
    stderr: "pipe",
  });
  let blocker = "";
  safeTransport.stderr.on("data", (data) => {
    blocker += data;
  });
  const safeClient = new Client(
    { name: "safe-entry-fixture", version: "0.1.0" },
    { capabilities: {} },
  );
  try {
    await safeClient.connect(safeTransport);
    assert.equal(safeClient.getServerCapabilities().experimental, undefined);
    await until(() => blocker.includes("native_session_fencing unsupported"));
    assert.equal(cli(["status"]).consumer_active, false);
    assert.equal(cli(["pending"]).messages[0].id, manual.id);
    const ack = await safeClient.callTool({
      name: "ack",
      arguments: { message_id: manual.id },
    });
    assert.ok(!ack.isError);
  } finally {
    await safeClient.close();
  }
  console.log(
    "claude sdk stdio fixture passed; admission and live delivery not verified",
  );
} finally {
  await client.close();
  rmSync(home, { recursive: true, force: true });
}
