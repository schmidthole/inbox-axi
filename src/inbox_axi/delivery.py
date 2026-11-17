"""single-consumer, bounded, at-least-once delivery on local unix filesystems."""

import fcntl
import os
import time

from .store import InboxError, private_file


class ConsumerBusy(InboxError):
    pass


class Consumer:
    def __init__(self, store):
        self.store = store
        path = store.root / "consumer.lock"
        private_file(path)
        self.fd = os.open(str(path), os.O_RDWR | os.O_NOFOLLOW)
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            os.close(self.fd)
            self.fd = None
            if isinstance(exc, BlockingIOError):
                raise ConsumerBusy("an inbox consumer is already active") from exc
            raise
        try:
            # retry state ends with this consumer; restart deliberately redelivers.
            self.store.db.execute("pragma temp_store=file")
            self.store.db.executescript(
                """
                drop table if exists temp.consumer_offers;
                create temp table consumer_offers (
                    message_id text primary key, due real not null, attempts integer not null
                );
                create index temp.consumer_offer_due on consumer_offers(due);
            """
            )
        except BaseException:
            os.close(self.fd)
            self.fd = None
            raise

    def close(self):
        if self.fd is not None:
            self.store.db.execute("drop table if exists temp.consumer_offers")
            os.close(self.fd)
            self.fd = None

    def poll(self, now=None):
        if self.fd is None:
            raise InboxError("consumer is closed")
        now = time.monotonic() if now is None else now
        self.store.db.execute("begin immediate")
        try:
            self.store.db.execute(
                """
                delete from consumer_offers where exists (
                    select 1 from messages m
                    where m.id=consumer_offers.message_id and m.acked_at is not null
                )
            """
            )
            # reserve half the batch for each class, sharing unused capacity.
            new = self.store.db.execute(
                """
                select m.*, 0 as attempts from messages m
                left join consumer_offers o on o.message_id=m.id
                where m.direction='inbound' and m.acked_at is null and o.message_id is null
                and not exists (select 1 from delivery_blocks b where b.message_id=m.id)
                order by m.seq limit 8
            """
            ).fetchall()
            retries = self.store.db.execute(
                """
                select m.*, o.attempts from consumer_offers o
                join messages m on m.id=o.message_id
                where m.acked_at is null and o.due<=?
                and not exists (select 1 from delivery_blocks b where b.message_id=m.id)
                order by o.due, m.seq limit ?
            """,
                (now, 8 - min(4, len(new))),
            ).fetchall()
            selected = sorted(
                new[: 8 - len(retries)] + retries, key=lambda row: row["seq"]
            )
            for row in selected:
                delay = min(300, 30 * 2 ** min(row["attempts"], 4))
                self.store.db.execute(
                    "insert or replace into consumer_offers values (?,?,?)",
                    (row["id"], now + delay, row["attempts"] + 1),
                )
            self.store.db.execute("commit")
            return [self.store.envelope(row) for row in selected]
        except BaseException:
            self.store.db.execute("rollback")
            raise


def active(store):
    try:
        consumer = Consumer(store)
    except ConsumerBusy:
        return True
    consumer.close()
    return False
