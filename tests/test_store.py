"""mailbox invariants, concurrent writers, validation and private paths."""

import concurrent.futures
import os
import tempfile
import unittest
from pathlib import Path

from inbox_axi.delivery import Consumer, active
from inbox_axi.store import InboxError, Store


def write_message(root, key):
    store = Store(root)
    try:
        return store.post(text="concurrent", key=key)
    finally:
        store.close()


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve() / "inbox"
        self.store = Store(self.root)
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self.store.close)

    def test_create_thread_retry_and_changed_payload(self):
        first = self.store.post(
            text="hello",
            data={"answer": 42},
            metadata={"task": "optional"},
            key="request-1",
        )
        self.assertEqual(
            first,
            self.store.post(
                text="hello",
                data={"answer": 42},
                metadata={"task": "optional"},
                key="request-1",
            ),
        )
        with self.assertRaises(InboxError):
            self.store.post(text="changed", key="request-1")
        self.assertEqual(self.store.status()["threads"], 1)
        self.assertEqual(self.store.status()["messages"], 1)

    def test_explicit_replies_and_cross_thread_parent(self):
        first = self.store.post(text="first")
        other = self.store.post(text="other")
        with self.assertRaisesRegex(InboxError, "same thread"):
            self.store.post(thread_id=first["thread_id"], parent_id=other["id"])
        with self.assertRaises(InboxError):
            self.store.post(direction="outbound")
        reply = self.store.post(
            thread_id=first["thread_id"],
            parent_id=first["id"],
            direction="outbound",
            data=[1, True],
        )
        self.assertEqual(reply["parent_id"], first["id"])
        self.assertGreater(reply["seq"], other["seq"])
        self.assertEqual(self.store.page(pending=True)["messages"], [first, other])
        self.store.ack(first["id"])
        self.store.ack(first["id"])
        self.assertEqual(self.store.page(pending=True)["messages"], [other])
        self.assertEqual(
            len(self.store.page(thread_id=first["thread_id"])["messages"]), 2
        )
        with self.assertRaises(InboxError):
            self.store.ack(reply["id"])

    def test_unbounded_depth_and_paginated_history(self):
        first = self.store.post()
        parent = first
        for _ in range(150):
            parent = self.store.post(
                thread_id=first["thread_id"], parent_id=parent["id"]
            )
        cursor, messages = 0, []
        while True:
            page = self.store.page(thread_id=first["thread_id"], after=cursor, limit=17)
            messages.extend(page["messages"])
            if page["next_cursor"] is None:
                break
            cursor = page["next_cursor"]
        self.assertEqual(len(messages), 151)
        self.assertEqual(len({item["id"] for item in messages}), 151)

    def test_validation(self):
        for kwargs in (
            {"after": True},
            {"limit": False},
            {"limit": 101},
            {"after": -1},
            {"thread_id": "latest"},
            {"pending": 1},
            {"after": "1"},
        ):
            with self.subTest(kwargs=kwargs), self.assertRaises(InboxError):
                self.store.page(**kwargs)
        for kwargs in (
            {"text": True},
            {"text": "x" * 16385},
            {"data": "x" * 16384},
            {"data": float("nan")},
            {"metadata": []},
            {"key": True},
            {"key": ""},
            {"parent_id": "msg_" + "a" * 32},
            {"thread_id": False},
            {"text": "\ud800"},
        ):
            with self.subTest(kwargs=kwargs), self.assertRaises(InboxError):
                self.store.post(**kwargs)
        self.assertEqual(self.store.status()["messages"], 0)

    def test_concurrent_processes_ordering_and_idempotency(self):
        with concurrent.futures.ProcessPoolExecutor(max_workers=6) as executor:
            results = list(
                executor.map(
                    write_message,
                    [str(self.root)] * 30,
                    [f"key-{i}" for i in range(30)],
                )
            )
            retries = list(
                executor.map(write_message, [str(self.root)] * 12, ["same-key"] * 12)
            )
        self.assertEqual(len({item["seq"] for item in results}), 30)
        self.assertEqual(sorted(item["seq"] for item in results), list(range(1, 31)))
        self.assertEqual(len({item["id"] for item in retries}), 1)
        self.assertEqual(self.store.status()["messages"], 31)
        self.assertEqual(self.store.status()["threads"], 31)

    def test_consumer_exclusion_backoff_and_ack(self):
        first = self.store.post()
        consumer = Consumer(self.store)
        self.addCleanup(consumer.close)
        self.assertTrue(active(self.store))
        with self.assertRaises(InboxError):
            Consumer(self.store)
        self.assertEqual(consumer.poll(now=0), [first])
        self.assertEqual(consumer.poll(now=29), [])
        self.assertEqual(consumer.poll(now=30), [first])
        self.assertEqual(consumer.poll(now=89), [])
        self.assertEqual(consumer.poll(now=90), [first])
        self.store.ack(first["id"])
        self.assertEqual(consumer.poll(now=1000), [])
        consumer.close()
        self.assertFalse(active(self.store))

    def test_consumer_batch_bounded_and_restart_redelivery(self):
        for _ in range(20):
            self.store.post()
        consumer = Consumer(self.store)
        first = consumer.poll(now=0)
        self.assertEqual(len(first), 8)
        following = consumer.poll(now=1)
        self.assertEqual([item["seq"] for item in following], list(range(9, 17)))
        self.assertEqual(len(consumer.poll(now=2)), 4)
        self.assertEqual(consumer.poll(now=3), [])
        consumer.close()
        second = Consumer(self.store)
        self.addCleanup(second.close)
        self.assertEqual(second.poll(now=0), first)
        for message in first:
            self.store.ack(message["id"])
        self.assertEqual(len(second.poll(now=1)), 8)

    def test_private_paths(self):
        self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.root / "inbox.sqlite3").stat().st_mode & 0o777, 0o600)
        link = self.root.parent / "link"
        link.symlink_to(self.root)
        with self.assertRaises(InboxError):
            Store(link)
        unsafe = self.root.parent / "unsafe"
        unsafe.mkdir(mode=0o755)
        with self.assertRaises(InboxError):
            Store(unsafe)
        second = self.root.parent / "second"
        second.mkdir(mode=0o700)
        (second / "inbox.sqlite3").symlink_to(self.root / "inbox.sqlite3")
        with self.assertRaises(OSError):
            Store(second)
        os.chmod(self.root / "inbox.sqlite3", 0o644)
        with self.assertRaises(InboxError):
            Store(self.root)

    def test_concurrent_first_initialization(self):
        fresh = str(self.root.parent / "fresh")
        with concurrent.futures.ProcessPoolExecutor(max_workers=6) as executor:
            results = list(executor.map(write_message, [fresh] * 20, ["same"] * 20))
        self.assertEqual(len({item["id"] for item in results}), 1)
        reopened = Store(fresh)
        self.addCleanup(reopened.close)
        self.assertEqual(reopened.status()["threads"], 1)

    def test_future_schema_rejected(self):
        self.store.db.execute("pragma user_version=2")
        with self.assertRaisesRegex(InboxError, "unsupported database version"):
            Store(self.root)

    def test_status_never_mistakes_unsafe_lock_for_active_consumer(self):
        self.assertFalse(active(self.store))
        os.chmod(self.root / "consumer.lock", 0o644)
        with self.assertRaisesRegex(InboxError, "unsafe private file"):
            active(self.store)

    def test_consumer_ninth_message_does_not_wait_for_ack(self):
        messages = [self.store.post() for _ in range(9)]
        consumer = Consumer(self.store)
        self.addCleanup(consumer.close)
        self.assertEqual(consumer.poll(now=0), messages[:8])
        self.assertEqual(consumer.poll(now=1), messages[8:])
        self.assertEqual(self.store.status()["pending"], 9)
        self.store.ack(messages[0]["id"])
        self.store.ack(messages[8]["id"])
        self.assertEqual(consumer.poll(now=30), messages[1:8])

    def test_consumer_fair_new_admission_and_retries_under_continuing_input(self):
        initial = [self.store.post() for _ in range(8)]
        consumer = Consumer(self.store)
        self.addCleanup(consumer.close)
        self.assertEqual(consumer.poll(now=0), initial)
        admitted = []
        retried = set()
        for now in range(30, 40):
            for _ in range(8):
                self.store.post()
            batch = consumer.poll(now=now)
            self.assertLessEqual(len(batch), 8)
            new = [item["seq"] for item in batch if item["seq"] > 8]
            admitted.extend(new)
            retried.update(item["seq"] for item in batch if item["seq"] <= 8)
            self.assertGreaterEqual(len(new), 4)
            if now == 31:
                self.assertEqual(retried, set(range(1, 9)))
        self.assertEqual(admitted, list(range(9, 9 + len(admitted))))
        while True:
            batch = consumer.poll(now=40)
            if not batch:
                break
            self.assertLessEqual(len(batch), 8)
            admitted.extend(item["seq"] for item in batch if item["seq"] > 8)
        self.assertEqual(admitted, list(range(9, 89)))
        for message in initial:
            self.store.ack(message["id"])
        self.assertTrue(all(item["seq"] > 8 for item in consumer.poll(now=1000)))

    def test_ack_status_is_bounded_read_only_and_explicit(self):
        first, second = self.store.post(), self.store.post()
        ids = [first["id"], second["id"]]
        self.assertEqual(
            self.store.ack_status(ids),
            {
                "acknowledgments": [
                    {"id": first["id"], "incorporated": False},
                    {"id": second["id"], "incorporated": False},
                ]
            },
        )
        self.store.ack(first["id"])
        self.assertEqual(
            self.store.ack_status(ids)["acknowledgments"],
            [
                {"id": first["id"], "incorporated": True},
                {"id": second["id"], "incorporated": False},
            ],
        )
        self.assertEqual(self.store.status()["pending"], 1)
        for invalid in ([], ids * 5, [False], ["latest"], ["msg_" + "a" * 32], True):
            with self.subTest(invalid=invalid), self.assertRaises(InboxError):
                self.store.ack_status(invalid)
