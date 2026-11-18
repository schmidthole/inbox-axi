import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { InboxError, validation } from "./errors.js";
import { bounded, canonical, identifier, integer, parseJson } from "./codec.js";
import { expandHome } from "./paths.js";
import type {
  Message,
  Page,
  PageOptions,
  PostOptions,
  Sequence,
} from "./types.js";
export { InboxError } from "./errors.js";
type Row = Record<string, any>;
export function defaultRoot(): string {
  return process.env.INBOX_AXI_HOME ?? join(process.cwd(), ".inbox-axi");
}
function operational(error: unknown): never {
  if (error instanceof InboxError) throw error;
  throw new InboxError(
    "unable to access the private inbox store",
    "STORE_ERROR",
    ["check the store path, ownership, permissions and available disk space"],
  );
}
export function privateFile(path: string, create = true): void {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDWR |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        (create ? constants.O_CREAT : 0),
      0o600,
    );
  } catch (e) {
    if (!create && (e as NodeJS.ErrnoException).code === "ENOENT") return;
    return operational(e);
  }
  try {
    const s = fstatSync(fd);
    if (
      !s.isFile() ||
      s.uid !== process.getuid!() ||
      s.mode & 0o077 ||
      !(create ? s.nlink === 1 : s.nlink <= 1)
    )
      throw new InboxError(
        "unsafe private file ownership, type or permissions",
      );
  } finally {
    closeSync(fd);
  }
}
export function privateRoot(input: string): string {
  if (typeof input !== "string" || input.length === 0)
    validation("store path must be text");
  const root = expandHome(input);
  const ancestors: string[] = [];
  for (let part = root; ; part = dirname(part)) {
    ancestors.unshift(part);
    if (dirname(part) === part) break;
  }
  try {
    for (const part of ancestors) {
      let s;
      try {
        s = lstatSync(part);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        try {
          mkdirSync(part, { mode: 0o700 });
        } catch (e2) {
          if ((e2 as NodeJS.ErrnoException).code !== "EEXIST") throw e2;
        }
        s = lstatSync(part);
      }
      if (s.isSymbolicLink())
        throw new InboxError(
          "symlink paths are not supported; use a physical path",
        );
      if (!s.isDirectory())
        throw new InboxError("store path must be a directory");
      if (part === root) {
        if (s.uid !== process.getuid!() || s.mode & 0o077)
          throw new InboxError(
            "store root must be owned by this user with mode 700",
          );
      } else if (
        ![0, process.getuid!()].includes(s.uid) ||
        (s.mode & 0o022 && !(s.mode & 0o1000))
      )
        throw new InboxError(
          "store ancestors must not be writable by other users",
        );
    }
    return root;
  } catch (e) {
    return operational(e);
  }
}
export class Store {
  readonly root: string;
  readonly db!: DatabaseSync;
  constructor(root = defaultRoot()) {
    this.root = privateRoot(root);
    const path = join(this.root, "inbox.sqlite3");
    privateFile(path);
    for (const suffix of ["-journal", "-wal", "-shm"])
      privateFile(path + suffix, false);
    try {
      this.db = new DatabaseSync(path, { timeout: 10000 });
      this.db.exec("pragma foreign_keys=on");
      const version = this.get("pragma user_version")!.user_version;
      if (version !== 0 && version !== 1) {
        this.db.close();
        throw new InboxError("unsupported database version");
      }
      this.db.exec(`begin immediate;
        create table if not exists threads (id text primary key, metadata text not null);
        create table if not exists messages (
          seq integer primary key autoincrement, id text unique not null,
          thread_id text not null references threads(id), parent_id text references messages(id),
          direction text not null check(direction in ('inbound','outbound')),
          text text not null, data text not null, created_at real not null, acked_at real);
        create index if not exists thread_order on messages(thread_id,seq);
        create index if not exists pending_order on messages(direction,acked_at,seq);
        create table if not exists requests (key text primary key,payload text not null,message_id text not null references messages(id));
        create table if not exists delivery_blocks (message_id text primary key references messages(id),target text not null,reason text not null);
        create table if not exists delivery_submissions (message_id text primary key references messages(id),target text not null,method text not null,submitted_at real not null);
        pragma user_version=1; commit;`);
    } catch (e) {
      try {
        this.db!.close();
      } catch {}
      operational(e);
    }
  }
  close(): void {
    this.db.close();
  }
  get(sql: string, ...args: SQLInputValue[]): Row | undefined {
    try {
      const stmt = this.db.prepare(sql);
      stmt.setReadBigInts(true);
      const row = stmt.get(...args) as Row | undefined;
      return row && this.numbers(row);
    } catch (e) {
      return operational(e);
    }
  }
  all(sql: string, ...args: SQLInputValue[]): Row[] {
    try {
      const stmt = this.db.prepare(sql);
      stmt.setReadBigInts(true);
      return (stmt.all(...args) as Row[]).map((row) => this.numbers(row));
    } catch (e) {
      return operational(e);
    }
  }
  private run(sql: string, ...args: SQLInputValue[]): void {
    try {
      this.db.prepare(sql).run(...args);
    } catch (e) {
      operational(e);
    }
  }
  private numbers(row: Row): Row {
    for (const key of Object.keys(row))
      if (
        typeof row[key] === "bigint" &&
        row[key] <= BigInt(Number.MAX_SAFE_INTEGER) &&
        row[key] >= BigInt(Number.MIN_SAFE_INTEGER)
      )
        row[key] = Number(row[key]);
    return row;
  }
  envelope(row: Row): Message {
    return {
      version: 1,
      id: row.id,
      thread_id: row.thread_id,
      seq: row.seq as Sequence,
      parent_id: row.parent_id,
      direction: row.direction,
      text: row.text,
      data: parseJson(row.data),
      created_at: row.created_at,
    };
  }
  message(id: string): Message {
    identifier(id, "msg");
    const row = this.get("select * from messages where id=?", id);
    if (!row) throw new InboxError("unknown message identifier", "NOT_FOUND");
    return this.envelope(row);
  }
  transaction<T>(work: () => T): T {
    try {
      this.db.exec("begin immediate");
    } catch (e) {
      return operational(e);
    }
    try {
      const result = work();
      this.db.exec("commit");
      return result;
    } catch (e) {
      try {
        this.db.exec("rollback");
      } catch {}
      return operational(e);
    }
  }
  post(options: PostOptions = {}): Message {
    const {
      text = "",
      data = null,
      thread_id = null,
      parent_id = null,
      direction = "inbound",
      metadata = null,
      key = null,
    } = options;
    bounded(text, 16384, "text");
    const encoded = bounded(canonical(data), 16384, "data");
    if (
      metadata !== null &&
      (typeof metadata !== "object" || Array.isArray(metadata))
    )
      validation("metadata must be an object");
    const meta = bounded(canonical(metadata ?? {}), 4096, "metadata");
    if (direction !== "inbound" && direction !== "outbound")
      validation("invalid direction");
    if (thread_id !== null) {
      identifier(thread_id, "thr");
      if (metadata !== null)
        validation("metadata is only accepted when creating a thread");
    }
    if (parent_id !== null) {
      identifier(parent_id, "msg");
      if (thread_id === null)
        validation("parent requires an explicit thread identifier");
    }
    if (direction === "outbound" && parent_id === null)
      validation("reply requires an explicit parent identifier");
    if (
      key !== null &&
      (typeof key !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(key))
    )
      validation("invalid idempotency key");
    const payload = canonical({
      text,
      data,
      thread_id,
      parent_id,
      direction,
      metadata,
    });
    return this.transaction(() => {
      if (key !== null) {
        const previous = this.get("select * from requests where key=?", key);
        if (previous) {
          if (previous.payload !== payload)
            throw new InboxError(
              "idempotency key already used for a different payload",
              "IDEMPOTENCY_CONFLICT",
            );
          return this.message(previous.message_id);
        }
      }
      let thread = thread_id;
      if (thread === null) {
        thread = "thr_" + randomUUID().replaceAll("-", "");
        this.db.prepare("insert into threads values (?,?)").run(thread, meta);
      } else if (!this.get("select 1 from threads where id=?", thread))
        throw new InboxError("unknown thread identifier", "NOT_FOUND");
      if (parent_id !== null && this.message(parent_id).thread_id !== thread)
        validation("parent must belong to the same thread");
      const id = "msg_" + randomUUID().replaceAll("-", "");
      this.db
        .prepare(
          "insert into messages (id,thread_id,parent_id,direction,text,data,created_at) values (?,?,?,?,?,?,?)",
        )
        .run(
          id,
          thread,
          parent_id,
          direction,
          text,
          encoded,
          Date.now() / 1000,
        );
      if (key !== null)
        this.db
          .prepare("insert into requests values (?,?,?)")
          .run(key, payload, id);
      return this.message(id);
    });
  }
  page({
    thread_id = null,
    pending = false,
    after = 0,
    limit = 20,
  }: PageOptions = {}): Page {
    integer(after, 0, 9223372036854775807n, "cursor");
    if (typeof limit !== "number")
      validation("limit must be an integer between 1 and 100");
    integer(limit, 1, 100, "limit");
    if (typeof pending !== "boolean") validation("pending must be boolean");
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    let metadata = null;
    if (thread_id !== null) {
      identifier(thread_id, "thr");
      const row = this.get(
        "select metadata from threads where id=?",
        thread_id,
      );
      if (!row) throw new InboxError("unknown thread identifier", "NOT_FOUND");
      metadata = parseJson(row.metadata);
      where.push("thread_id=?");
      args.push(thread_id);
    }
    if (pending) where.push("direction='inbound' and acked_at is null");
    const total = Number(
      this.get(
        "select count(*) as n from messages" +
          (where.length ? " where " + where.join(" and ") : ""),
        ...args,
      )!.n,
    );
    where.push("seq>?");
    args.push(after);
    const rows = this.all(
      "select * from messages where " +
        where.join(" and ") +
        " order by seq limit ?",
      ...args,
      limit + 1,
    );
    const messages = rows.slice(0, limit).map((row) => this.envelope(row));
    return {
      version: 1,
      messages,
      next_cursor: rows.length > limit ? messages.at(-1)!.seq : null,
      metadata,
      total,
    };
  }
  ack(id: string) {
    const message = this.message(id);
    if (message.direction !== "inbound")
      validation("only inbound messages can be acknowledged");
    this.run(
      "update messages set acked_at=coalesce(acked_at,?) where id=?",
      Date.now() / 1000,
      id,
    );
    return { id, incorporated: true };
  }
  ackStatus(ids: string[]) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 8)
      validation("ack-status requires between 1 and 8 message identifiers");
    const acknowledgments = ids.map((id) => {
      identifier(id, "msg");
      const row = this.get(
        "select direction,acked_at from messages where id=?",
        id,
      );
      if (!row) throw new InboxError("unknown message identifier", "NOT_FOUND");
      if (row.direction !== "inbound")
        validation("only inbound messages have incorporation acknowledgments");
      return { id, incorporated: row.acked_at !== null };
    });
    return { acknowledgments };
  }
  blockDelivery(id: string, target: string, reason: string): void {
    this.message(id);
    bounded(target, 4096, "target");
    bounded(reason, 4096, "reason");
    this.run(
      "insert or replace into delivery_blocks values (?,?,?)",
      id,
      target,
      reason,
    );
  }
  deliveryBlock(
    id: string,
  ): { message_id: string; target: string; reason: string } | null {
    this.message(id);
    return (
      (this.get("select * from delivery_blocks where message_id=?", id) as {
        message_id: string;
        target: string;
        reason: string;
      }) ?? null
    );
  }
  submission(id: string): {
    message_id: string;
    target: string;
    method: string;
    submitted_at: number;
  } | null {
    this.message(id);
    return (
      (this.get(
        "select * from delivery_submissions where message_id=?",
        id,
      ) as {
        message_id: string;
        target: string;
        method: string;
        submitted_at: number;
      }) ?? null
    );
  }
  recordSubmission(id: string, target: string, method: string): void {
    this.message(id);
    bounded(target, 4096, "target");
    bounded(method, 128, "method");
    const submittedAt = Date.now() / 1000;
    this.transaction(() => {
      this.run(
        "insert or replace into delivery_submissions (message_id,target,method,submitted_at) values (?,?,?,?)",
        id,
        target,
        method,
        submittedAt,
      );
      this.run("delete from delivery_blocks where message_id=?", id);
    });
  }
  retry(id: string) {
    this.message(id);
    this.transaction(() => {
      this.run("delete from delivery_blocks where message_id=?", id);
      this.run("delete from delivery_submissions where message_id=?", id);
    });
    return { id, retry_authorized: true };
  }
  status() {
    const count = (sql: string) => Number(this.get(sql)!.n);
    return {
      version: 1,
      root: this.root,
      blocked_deliveries: count(
        "select count(*) as n from delivery_blocks b join messages m on b.message_id=m.id where m.acked_at is null",
      ),
      threads: count("select count(*) as n from threads"),
      messages: count("select count(*) as n from messages"),
      pending: count(
        "select count(*) as n from messages where direction='inbound' and acked_at is null",
      ),
    };
  }
}
