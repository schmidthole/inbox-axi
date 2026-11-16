"""shared-server websocket fixtures; no native sessions or model calls."""

import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from websockets.sync.server import unix_serve

from inbox_axi.adapters.codex import RPC, RpcError, deliver, thread_state
from inbox_axi.store import InboxError, Store


THREAD = "019a7d37-3067-7000-8000-000000000001"
TURN = "019a7d37-3067-7000-8000-000000000002"


class CodexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / "inbox"
        self.store = Store(self.root)
        self.addCleanup(self.store.close)
        self.calls = []
        self.mode = "idle"
        self.reject = False
        self.approval = False
        self.malformed = False
        self.socket = self.base / "s"
        self.server = unix_serve(self.handle, str(self.socket))
        os.chmod(self.socket, 0o600)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)
        self.rpc = RPC(self.socket)
        self.addCleanup(self.rpc.close)
        self.rpc.initialize(self.base, "0.169.0")

    def stop_server(self):
        self.server.shutdown()
        self.thread.join(timeout=5)

    def handle(self, ws):
        for raw in ws:
            req = json.loads(raw)
            self.calls.append(req)
            method = req["method"]
            if "id" not in req:
                continue
            result = {}
            if method == "initialize":
                result = {
                    "userAgent": "codex-tui/0.169.0 fixture",
                    "codexHome": str(self.base),
                }
            elif method == "thread/read":
                result = {
                    "thread": {
                        "id": THREAD,
                        "ephemeral": False,
                        "canAcceptDirectInput": self.mode != "unloaded",
                        "status": {"type": self.mode},
                    }
                }
            elif method == "thread/turns/list":
                result = {
                    "data": [
                        {
                            "id": TURN,
                            "status": (
                                "inProgress"
                                if self.mode == "active"
                                else (
                                    self.mode
                                    if self.mode == "interrupted"
                                    else "completed"
                                )
                            ),
                        }
                    ]
                }
            elif method in ("turn/steer", "thread/queue/add"):
                if self.reject:
                    ws.send(
                        json.dumps(
                            {
                                "id": req["id"],
                                "error": {"code": -32600, "message": "turn changed"},
                            }
                        )
                    )
                    continue
                result = (
                    {"turnId": TURN}
                    if method == "turn/steer"
                    else {"queuedSubmission": {"id": "native-queue-id"}}
                )
                if self.malformed:
                    result = {}
            if self.approval and method == "fixture/approval":
                ws.send(
                    json.dumps(
                        {
                            "id": "approval-1",
                            "method": "item/commandExecution/requestApproval",
                            "params": {},
                        }
                    )
                )
                continue
            if method == "fixture/timeout":
                continue
            ws.send(json.dumps({"id": req["id"], "result": result}))

    def test_idle_queue_and_busy_steer_with_stable_client_id(self):
        message = self.store.post(text="operator")
        queued = deliver(self.store, self.rpc, THREAD, "fixture", message)
        self.assertEqual(queued["method"], "thread/queue/add")
        first = self.calls[-1]["params"]
        self.mode = "active"
        steered = deliver(self.store, self.rpc, THREAD, "fixture", message)
        self.assertEqual(steered["method"], "turn/steer")
        second = self.calls[-1]["params"]
        self.assertEqual(first["clientUserMessageId"], second["clientUserMessageId"])
        self.assertEqual(second["expectedTurnId"], TURN)
        self.assertEqual(self.store.page(pending=True)["messages"], [message])
        self.assertIsNone(self.store.delivery_block(message["id"]))
        self.assertFalse(
            any(
                call["method"] in ("thread/resume", "turn/start") for call in self.calls
            )
        )

    def test_rejection_never_blindly_falls_back_to_queue(self):
        self.mode = "active"
        self.reject = True
        message = self.store.post()
        with self.assertRaises(RpcError):
            deliver(self.store, self.rpc, THREAD, "fixture", message)
        self.assertIsNone(self.store.delivery_block(message["id"]))
        self.assertFalse(
            any(call["method"] == "thread/queue/add" for call in self.calls)
        )

    def test_uncertain_persisted_and_explicit_retry(self):
        message = self.store.post()
        self.malformed = True
        with self.assertRaisesRegex(InboxError, "uncertain"):
            deliver(self.store, self.rpc, THREAD, "fixture", message)
        count = len(self.calls)
        with self.assertRaisesRegex(InboxError, "blocked"):
            deliver(self.store, self.rpc, THREAD, "fixture", message)
        self.assertEqual(len(self.calls), count)
        reopened = Store(self.root)
        self.addCleanup(reopened.close)
        self.assertIsNotNone(reopened.delivery_block(message["id"]))
        self.assertEqual(reopened.status()["blocked_deliveries"], 1)
        reopened.retry(message["id"])
        self.assertIsNone(self.store.delivery_block(message["id"]))
        self.assertEqual(self.store.status()["pending"], 1)

    def test_timeout_never_acknowledges(self):
        with self.assertRaisesRegex(InboxError, "uncertain"):
            self.rpc.call("fixture/timeout", {}, timeout=0.05)

    def test_native_approvals_are_never_answered(self):
        self.approval = True
        with self.assertRaisesRegex(InboxError, "will not answer"):
            self.rpc.call("fixture/approval", {})
        self.assertFalse(any("result" in call for call in self.calls))

    def test_binding_mismatch_fails_closed(self):
        for home, version in ((self.base, "0.167.0"), (self.base / "other", "0.169.0")):
            with (
                self.subTest(home=home, version=version),
                self.assertRaisesRegex(InboxError, "mismatch"),
            ):
                self.rpc.initialize(home, version)
        self.mode = "unloaded"
        with self.assertRaisesRegex(InboxError, "not loaded"):
            thread_state(self.rpc, THREAD)

    def test_missing_optional_dependency_is_clear(self):
        with patch.dict("sys.modules", {"websockets.sync.client": None}):
            with self.assertRaisesRegex(InboxError, "extra"):
                RPC(self.socket)
