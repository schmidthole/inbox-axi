import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  chmodSync,
  symlinkSync,
  linkSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { Store, defaultRoot } from "../../src/store.js";
import { Consumer, active } from "../../src/delivery.js";
import { canonical, parseJson } from "../../src/codec.js";
import { InboxError } from "../../src/errors.js";
function fixture(t: any) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "inbox-core-")));
  const root = join(base, "store");
  const store = new Store(root);
  t.after(() => {
    store.close();
    rmSync(base, { recursive: true, force: true });
  });
  return { store, root, base };
}
test("strict lossless json rejects ambiguous input and preserves integer data", () => {
  for (const text of [
    '{"x":1,"x":2}',
    "[NaN]",
    "1e999",
    "01",
    "[1,]",
    '{"a":1,}',
    "true false",
    '"\\ud800"',
    '"\u0001"',
  ])
    assert.throws(() => parseJson(text), InboxError);
  assert.equal(
    canonical(parseJson('{"n":9223372036854775807,"z":-0,"x":1.0}')),
    '{"n":9223372036854775807,"x":1,"z":0}',
  );
  assert.throws(() => canonical({ n: NaN }), InboxError);
  assert.throws(() => canonical({ text: "\ud800" }), InboxError);
  assert.equal(
    canonical(parseJson('{"__proto__":true,"a":"é😀"}')),
    '{"__proto__":true,"a":"é😀"}',
  );
});
test("idempotency, explicit replies, pagination and incorporation", (t) => {
  const { store } = fixture(t);
  const first = store.post({
    text: "hello",
    data: { n: 42 },
    metadata: { task: "a" },
    key: "a",
  });
  assert.deepEqual(
    store.post({
      text: "hello",
      data: { n: 42 },
      metadata: { task: "a" },
      key: "a",
    }),
    first,
  );
  assert.throws(() => store.post({ text: "changed", key: "a" }), InboxError);
  const other = store.post();
  assert.throws(
    () => store.post({ thread_id: first.thread_id, parent_id: other.id }),
    /same thread/,
  );
  assert.throws(() => store.post({ direction: "outbound" }), InboxError);
  const reply = store.post({
    thread_id: first.thread_id,
    parent_id: first.id,
    direction: "outbound",
  });
  assert.throws(() => store.ack(reply.id), InboxError);
  assert.equal(store.page({ limit: 1 }).total, 3);
  assert.equal(store.page({ after: first.seq, limit: 1 }).total, 3);
  assert.equal(store.page({ thread_id: first.thread_id }).total, 2);
  assert.deepEqual(
    store
      .ackStatus([first.id, other.id])
      .acknowledgments.map((x) => x.incorporated),
    [false, false],
  );
  store.ack(first.id);
  store.ack(first.id);
  assert.deepEqual(store.page({ pending: true }).messages, [other]);
  assert.deepEqual(store.ackStatus([first.id]).acknowledgments, [
    { id: first.id, incorporated: true },
  ]);
});
test("finite input bounds and atomic validation", (t) => {
  const { store } = fixture(t);
  for (const options of [
    { text: true },
    { text: "x".repeat(16385) },
    { text: "\ud800" },
    { data: NaN },
    { metadata: [] },
    { key: "" },
    { parent_id: "msg_" + "a".repeat(32) },
    { thread_id: false },
  ])
    assert.throws(() => store.post(options as any), InboxError);
  for (const options of [
    { after: true },
    { after: -1 },
    { after: 9007199254740992 },
    { limit: 101 },
    { pending: 1 },
    { limit: 1n },
  ])
    assert.throws(() => store.page(options as any), InboxError);
  for (const ids of [[], Array(9).fill("msg_" + "a".repeat(32)), [true]])
    assert.throws(() => store.ackStatus(ids as any), InboxError);
  assert.equal(store.status().messages, 0);
});
test("full signed sqlite cursor and JSON integer precision", (t) => {
  const { store } = fixture(t);
  const first = store.post();
  store.db
    .prepare("update sqlite_sequence set seq=? where name=?")
    .run(9223372036854775805n, "messages");
  const large = store.post({ data: parseJson('{"n":9223372036854775807}') });
  const last = store.post();
  assert.equal(large.seq, 9223372036854775806n);
  assert.equal(last.seq, 9223372036854775807n);
  assert.equal(canonical(large.data), '{"n":9223372036854775807}');
  assert.equal(
    store.page({ after: first.seq, limit: 1 }).next_cursor,
    large.seq,
  );
  assert.deepEqual(store.page({ after: large.seq }).messages, [last]);
});
test("bounded fair FIFO retry scheduling and blocks survive restart", (t) => {
  const { store, root } = fixture(t);
  const initial = Array.from({ length: 8 }, () => store.post());
  const c = new Consumer(store);
  assert.equal(active(store), true);
  assert.throws(() => new Consumer(store), InboxError);
  assert.deepEqual(c.poll(0), initial);
  assert.deepEqual(c.poll(29), []);
  initial
    .slice(0, 4)
    .forEach((m) => store.blockDelivery(m.id, "codex", "uncertain"));
  const fresh = Array.from({ length: 8 }, () => store.post());
  assert.deepEqual(c.poll(30), [...initial.slice(4), ...fresh.slice(0, 4)]);
  assert.deepEqual(c.poll(31), fresh.slice(4));
  assert.equal(store.status().pending, 16);
  assert.equal(store.status().blocked_deliveries, 4);
  store.retry(initial[0].id);
  store.ack(initial[1].id);
  assert.deepEqual(c.poll(32), [initial[0]]);
  c.close();
  assert.equal(active(store), false);
  const reopened = new Store(root);
  const next = new Consumer(reopened);
  try {
    assert.deepEqual(next.poll(0), [
      initial[0],
      ...initial.slice(4),
      ...fresh.slice(0, 3),
    ]);
    assert.equal(reopened.deliveryBlock(initial[2].id)?.reason, "uncertain");
  } finally {
    next.close();
    reopened.close();
  }
});
test("private paths, files, links, permissions and future schema", (t) => {
  const { store, root, base } = fixture(t);
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal(statSync(join(root, "inbox.sqlite3")).mode & 0o777, 0o600);
  symlinkSync(root, join(base, "link"));
  assert.throws(() => new Store(join(base, "link")), InboxError);
  mkdirSync(join(base, "unsafe"), 0o755);
  assert.throws(() => new Store(join(base, "unsafe")), InboxError);
  mkdirSync(join(base, "hard"), 0o700);
  linkSync(join(root, "inbox.sqlite3"), join(base, "hard", "inbox.sqlite3"));
  assert.throws(() => new Store(join(base, "hard")), InboxError);
  rmSync(join(base, "hard"), { recursive: true });
  assert.equal(active(store), false);
  chmodSync(join(root, "consumer.lock"), 0o644);
  assert.throws(() => active(store), /unsafe private file/);
  store.db.exec("pragma user_version=2");
  assert.throws(() => new Store(root), /unsupported database version/);
  assert.equal(store.get("pragma user_version")?.user_version, 2);
});
test("bounded nesting and finite IEEE754 float parsing", (t) => {
  const { store } = fixture(t);
  for (const depth of [200, 300]) {
    const encoded = "[".repeat(depth) + "1" + "]".repeat(depth);
    const value = parseJson(encoded);
    assert.equal(canonical(store.post({ data: value }).data), encoded);
  }
  for (const text of [
    "0.12345678901234567890123456789",
    "9007199254740993.125",
  ])
    assert.equal(canonical(parseJson(text)), JSON.stringify(Number(text)));
  assert.throws(() => parseJson('{"x":1,"x":1}'), {
    message: "duplicate json object key",
  });
  assert.throws(() => parseJson("[".repeat(1001) + "1" + "]".repeat(1001)), {
    message: "json nesting is too deep",
  });
  assert.throws(() => parseJson('"\\ud800"'), {
    message: "text must be valid utf-8",
  });
  assert.throws(() => parseJson("1e999"), {
    message: "nonfinite json number",
  });
});
test("workspace scoped defaults and explicit root override", (t) => {
  const original = process.env.INBOX_AXI_HOME;
  t.after(() => {
    if (original === undefined) delete process.env.INBOX_AXI_HOME;
    else process.env.INBOX_AXI_HOME = original;
  });
  delete process.env.INBOX_AXI_HOME;
  assert.equal(defaultRoot(), join(process.cwd(), ".inbox-axi"));
  process.env.INBOX_AXI_HOME = "/explicit/mailbox";
  assert.equal(defaultRoot(), "/explicit/mailbox");
});
test("process writers serialize first initialization and idempotency", async (t) => {
  const { base } = fixture(t);
  const root = join(base, "concurrent");
  const code = `import {Store} from ${JSON.stringify(new URL("../../src/store.ts", import.meta.url).href)}; const s=new Store(process.argv[1]); const m=s.post({key:process.argv[2]}); console.log(m.id);s.close()`;
  async function run(key: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", code, root, key],
        { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "",
        err = "";
      child.stdout.on("data", (b) => (out += b));
      child.stderr.on("data", (b) => (err += b));
      child.on("error", reject);
      child.on("exit", (status) =>
        status === 0 ? resolve(out.trim()) : reject(new Error(err)),
      );
    });
  }
  const identical = await Promise.all(
    Array.from({ length: 6 }, () => run("same")),
  );
  assert.equal(new Set(identical).size, 1);
  await Promise.all(Array.from({ length: 6 }, (_, i) => run("different" + i)));
  const s = new Store(root);
  try {
    assert.equal(s.status().messages, 7);
    assert.deepEqual(
      s.page().messages.map((m) => m.seq),
      [1, 2, 3, 4, 5, 6, 7],
    );
  } finally {
    s.close();
  }
});
test("OS consumer lock releases after a crashed process", async (t) => {
  const { store, root } = fixture(t);
  const code = `import {Store} from ${JSON.stringify(new URL("../../src/store.ts", import.meta.url).href)}; import {Consumer} from ${JSON.stringify(new URL("../../src/delivery.ts", import.meta.url).href)}; const s=new Store(process.argv[1]);new Consumer(s);console.log('ready');setInterval(()=>{},10000)`;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", code, root],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
    child.once("exit", (status) => {
      if (status !== null) reject(new Error("child exited before ready"));
    });
  });
  assert.equal(active(store), true);
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(active(store), false);
});
test("continuing input preserves four retry slots, FIFO admission and capped backoff", (t) => {
  const { store } = fixture(t);
  const initial = Array.from({ length: 8 }, () => store.post());
  const c = new Consumer(store);
  t.after(() => c.close());
  assert.deepEqual(c.poll(0), initial);
  const retried = new Set<string>();
  const admitted: number[] = [];
  for (let now = 30; now < 40; now++) {
    for (let i = 0; i < 8; i++) store.post();
    const batch = c.poll(now);
    assert.ok(batch.length <= 8);
    const fresh = batch.filter((m) => Number(m.seq) > 8);
    assert.ok(fresh.length >= 4);
    admitted.push(...fresh.map((m) => Number(m.seq)));
    batch.filter((m) => Number(m.seq) <= 8).forEach((m) => retried.add(m.id));
    if (now === 31) assert.equal(retried.size, 8);
  }
  assert.deepEqual(
    admitted,
    Array.from({ length: admitted.length }, (_, i) => i + 9),
  );
  assert.throws(() => c.poll(NaN), InboxError);
});
test("thread history has no reply depth limit and paginates without omissions", (t) => {
  const { store } = fixture(t);
  const first = store.post();
  let parent = first;
  for (let i = 0; i < 150; i++)
    parent = store.post({ thread_id: first.thread_id, parent_id: parent.id });
  let after: number | bigint = 0;
  const ids: string[] = [];
  for (;;) {
    const page = store.page({ thread_id: first.thread_id, after, limit: 17 });
    assert.equal(page.total, 151);
    ids.push(...page.messages.map((m) => m.id));
    if (page.next_cursor === null) break;
    after = page.next_cursor;
  }
  assert.equal(ids.length, 151);
  assert.equal(new Set(ids).size, 151);
});
test("special object keys and float spellings preserve request identity", (t) => {
  const { store } = fixture(t);
  const data = parseJson(
    '{"__proto__":{"safe":true},"constructor":1,"prototype":2,"decimal":1.234567890123456789e0}',
  );
  const first = store.post({ data, key: "special" });
  assert.equal(Object.getPrototypeOf(first.data), Object.prototype);
  assert.equal(
    canonical(first.data),
    '{"__proto__":{"safe":true},"constructor":1,"decimal":1.2345678901234567,"prototype":2}',
  );
  assert.deepEqual(
    store.post({
      data: parseJson(
        '{"decimal":1.234567890123456789,"prototype":2,"constructor":1,"__proto__":{"safe":true}}',
      ),
      key: "special",
    }),
    first,
  );
});
test("retry delay doubles to the five minute cap without implicit incorporation", (t) => {
  const { store } = fixture(t);
  const message = store.post();
  const c = new Consumer(store);
  try {
    for (const [offered, due] of [
      [0, 30],
      [30, 90],
      [90, 210],
      [210, 450],
      [450, 750],
      [750, 1050],
    ]) {
      assert.deepEqual(c.poll(offered), [message]);
      assert.deepEqual(c.poll(due - 1), []);
    }
    assert.equal(store.status().pending, 1);
    assert.equal(
      store.ackStatus([message.id]).acknowledgments[0].incorporated,
      false,
    );
  } finally {
    c.close();
  }
});
test("decimal and exponent idempotency roundtrips through the CLI", (t) => {
  const { store, root } = fixture(t);
  const rawValues = [
    '{"v":0.12345678901234567890}',
    '{"v":9007199254740993.0}',
    '{"v":9007199254740993e0}',
    '{"v":1e-999}',
    '{"v":1e20}',
    '{"v":1.0000000000000001e21}',
    '{"v":9007199254740993}',
  ];
  const messages = rawValues.map((raw, i) =>
    store.post({ data: parseJson(raw), key: "float-" + i }),
  );
  rawValues.forEach((raw, i) => {
    const first = store.post({ data: parseJson(raw), key: "float-" + i });
    assert.equal(first.id, messages[i].id);
    const cli = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve("src/cli.ts"),
        "post",
        "--home",
        root,
        "--json",
        "--input-json",
        "-",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        input: '{"data":' + raw + ',"key":"float-' + i + '"}',
      },
    );
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    assert.throws(
      () => store.post({ data: { v: 7 }, key: "float-" + i }),
      /different payload/,
    );
  });
  assert.equal(
    canonical(store.message(messages[1].id).data),
    '{"v":9007199254740992}',
  );
  assert.equal(
    canonical(store.message(messages[6].id).data),
    '{"v":9007199254740993}',
  );
  assert.throws(
    () =>
      store.post({ data: parseJson('{"v":9007199254740993}'), key: "float-1" }),
    /different payload/,
  );
  const fresh = store.post({
    data: parseJson('{"v":9007199254740993.0}'),
    key: "new-float",
  });
  assert.throws(
    () =>
      store.post({
        data: parseJson('{"v":9007199254740993}'),
        key: "new-float",
      }),
    /different payload/,
  );
  assert.equal(
    fresh.id,
    store.post({
      data: parseJson('{"v":9007199254740992.0}'),
      key: "new-float",
    }).id,
  );
});
test("confirmed submission stays pending and is excluded from later offers", (t) => {
  const { store, root } = fixture(t);
  const message = store.post({ text: "keep" });
  const consumer = new Consumer(store);
  try {
    assert.deepEqual(consumer.poll(0), [message]);
    store.blockDelivery(
      message.id,
      "codex",
      "submission in progress or uncertain: thread/queue/add",
    );
    assert.deepEqual(consumer.poll(30), []);
    store.recordSubmission(message.id, "codex", "thread/queue/add");
    assert.equal(store.deliveryBlock(message.id), null);
    assert.equal(store.submission(message.id)?.method, "thread/queue/add");
    assert.equal(store.status().pending, 1);
    assert.equal(store.status().blocked_deliveries, 0);
    assert.equal(
      store.ackStatus([message.id]).acknowledgments[0].incorporated,
      false,
    );
    assert.deepEqual(consumer.poll(30), []);
    assert.deepEqual(consumer.poll(1000), []);
    const reply = store.post({
      direction: "outbound",
      thread_id: message.thread_id,
      parent_id: message.id,
      text: "reply",
    });
    assert.equal(reply.parent_id, message.id);
    assert.equal(
      store.ackStatus([message.id]).acknowledgments[0].incorporated,
      false,
    );
  } finally {
    consumer.close();
  }
  const reopened = new Store(root);
  const next = new Consumer(reopened);
  try {
    assert.deepEqual(next.poll(0), []);
    assert.ok(reopened.submission(message.id));
    reopened.retry(message.id);
    assert.equal(reopened.submission(message.id), null);
    assert.equal(reopened.deliveryBlock(message.id), null);
    assert.deepEqual(next.poll(0), [reopened.message(message.id)]);
  } finally {
    next.close();
    reopened.close();
  }
});
