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
        self.inflight = {}

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def poll(self, now=None):
        if self.fd is None:
            raise InboxError("consumer is closed")
        now = time.monotonic() if now is None else now
        messages = self.store.page(pending=True, limit=8)["messages"]
        current = {message["id"] for message in messages}
        self.inflight = {
            key: value for key, value in self.inflight.items() if key in current
        }
        ready = []
        for message in messages:
            due, attempts = self.inflight.get(message["id"], (0, 0))
            if now >= due:
                ready.append(message)
                self.inflight[message["id"]] = (
                    now + min(300, 30 * 2 ** min(attempts, 4)),
                    attempts + 1,
                )
        return ready


def active(store):
    try:
        consumer = Consumer(store)
    except ConsumerBusy:
        return True
    consumer.close()
    return False
