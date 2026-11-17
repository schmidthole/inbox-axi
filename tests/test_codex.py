"""shared-server websocket fixtures; no native sessions or model calls."""

import json
import os
import subprocess
import sys
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

    def test_delivered_mailbox_commands_restore_history_reply_and_ack(self):
        first = self.store.post(text="first", metadata={"task": "generic-task"})
        message = first
        for _ in range(21):
            message = self.store.post(
                thread_id=first["thread_id"], parent_id=message["id"], text="next"
            )
        deliver(self.store, self.rpc, THREAD, "fixture", message)
        text = self.calls[-1]["params"]["input"][0]["text"]
        binding = json.loads(text.split("\n", 1)[1])
        self.assertEqual(binding["message"], message)
        mailbox = binding["mailbox"]
        self.assertEqual(mailbox["home"], str(self.root))
        self.assertIn("before acting, replying or acknowledging", text)
        self.assertIn("until next_cursor is null", text)
        self.assertIn("generic associated task context", text)
        self.assertIn("never automatically forward assistant transcripts", text)
        env = dict(os.environ)
        env.pop("INBOX_AXI_HOME", None)
        env["PATH"] = ""
        env["HOME"] = str(self.base / "unused-home")
        env["XDG_STATE_HOME"] = str(self.base / "unused-state")
        # source tests select candidate code; wheel coverage needs no pythonpath.
        env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1] / "src")

        def run(argv, body=None):
            self.assertEqual(argv[:3], [sys.executable, "-m", "inbox_axi"])
            result = subprocess.run(
                argv,
                input=body,
                text=True,
                capture_output=True,
                cwd=str(self.base),
                env=env,
                timeout=15,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)

        argv = mailbox["read_thread_argv"]
        page = run(argv)
        self.assertEqual(page["metadata"], {"task": "generic-task"})
        history = page["messages"]
        self.assertIsNotNone(page["next_cursor"])
        while page["next_cursor"] is not None:
            page = run([*argv, "--after", str(page["next_cursor"])])
            history.extend(page["messages"])
        self.assertEqual(len(history), 22)
        self.assertEqual(history[0], first)
        self.assertEqual(history[-1], message)
        reply = run(mailbox["reply_argv"], "explicit reply")
        self.assertEqual(reply["thread_id"], message["thread_id"])
        self.assertEqual(reply["parent_id"], message["id"])
        self.assertEqual(reply["direction"], "outbound")
        self.assertEqual(self.store.status()["pending"], 22)
        self.assertTrue(run(mailbox["ack_argv"])["incorporated"])
        self.assertEqual(self.store.status()["pending"], 21)
        self.assertFalse(Path(env["XDG_STATE_HOME"]).exists())
        self.assertFalse((Path(env["HOME"]) / ".local/state/inbox-axi").exists())

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
