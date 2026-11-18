import { constants, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { Store, privateFile } from "./store.js";
import { ConsumerBusy, InboxError, validation } from "./errors.js";
import type { Message } from "./types.js";
export { ConsumerBusy } from "./errors.js";
const { flockSync } = createRequire(import.meta.url)("fs-ext") as {
  flockSync(fd: number, flags: string): void;
};
export class Consumer {
  private fd: number | null = null;
  constructor(private readonly store: Store) {
    const path = join(store.root, "consumer.lock");
    privateFile(path);
    try {
      this.fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
      flockSync(this.fd, "exnb");
    } catch (e) {
      if (this.fd !== null) closeSync(this.fd);
      this.fd = null;
      if (
        ["EAGAIN", "EWOULDBLOCK"].includes(
          (e as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw new ConsumerBusy();
      throw new InboxError(
        "unable to acquire the private consumer lock",
        "LOCK_ERROR",
      );
    }
    try {
      store.db
        .exec(`pragma temp_store=file; drop table if exists temp.consumer_offers;
      create temp table consumer_offers(message_id text primary key,due real not null,attempts integer not null);
      create index temp.consumer_offer_due on consumer_offers(due);`);
    } catch {
      closeSync(this.fd);
      this.fd = null;
      throw new InboxError(
        "unable to initialize consumer retry state",
        "STORE_ERROR",
      );
    }
  }
  close(): void {
    if (this.fd !== null) {
      const fd = this.fd;
      this.fd = null;
      try {
        if (this.store.db.isOpen)
          this.store.db.exec("drop table if exists temp.consumer_offers");
      } finally {
        closeSync(fd);
      }
    }
  }
  poll(now = performance.now() / 1000): Message[] {
    if (this.fd === null) throw new InboxError("consumer is closed");
    if (
      typeof now !== "number" ||
      !Number.isFinite(now) ||
      now < 0 ||
      now > Number.MAX_SAFE_INTEGER - 300
    )
      validation("poll time must be a finite nonnegative number");
    return this.store.transaction(() => {
      this.store.db.exec(
        "delete from consumer_offers where exists (select 1 from messages m where m.id=consumer_offers.message_id and m.acked_at is not null)",
      );
      const withheld =
        "not exists(select 1 from delivery_blocks b where b.message_id=m.id) and not exists(select 1 from delivery_submissions s where s.message_id=m.id)";
      const fresh = this.store
        .all(`select m.*,0 as attempts from messages m left join consumer_offers o on o.message_id=m.id
        where m.direction='inbound' and m.acked_at is null and o.message_id is null
        and ${withheld} order by m.seq limit 8`);
      const retries = this.store.all(
        `select m.*,o.attempts from consumer_offers o join messages m on m.id=o.message_id
        where m.acked_at is null and o.due<=? and ${withheld}
        order by o.due,m.seq limit ?`,
        now,
        8 - Math.min(4, fresh.length),
      );
      const selected = [...fresh.slice(0, 8 - retries.length), ...retries].sort(
        (a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0),
      );
      for (const row of selected) {
        const delay = Math.min(300, 30 * 2 ** Math.min(row.attempts, 4));
        this.store.db
          .prepare("insert or replace into consumer_offers values (?,?,?)")
          .run(row.id, now + delay, row.attempts + 1);
      }
      return selected.map((row) => this.store.envelope(row));
    });
  }
}
export function active(store: Store): boolean {
  try {
    const consumer = new Consumer(store);
    consumer.close();
    return false;
  } catch (e) {
    if (e instanceof ConsumerBusy) return true;
    throw e;
  }
}
