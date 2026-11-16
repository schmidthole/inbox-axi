"""real cli pipes, crash recovery and generated envelope boundaries."""

import json
import os
import selectors
import signal
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class CliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = str(Path(self.temp.name).resolve() / "inbox")
        self.command = [
            sys.executable,
            "-m",
            "inbox_axi",
            "--home",
            self.root,
            "--json",
        ]

    def run_cli(self, *args, body=None, success=True):
        result = subprocess.run(
            [*self.command, *args],
            input=body,
            text=True,
            capture_output=True,
            timeout=15,
        )
        self.assertEqual(result.returncode, 0 if success else 2, result.stderr)
        if success:
            return json.loads(result.stdout)
        self.assertNotIn("traceback", result.stderr)
        return result

    def test_cli_roundtrip_json_reply_ack_and_pagination(self):
        first = self.run_cli(
            "post",
            "--input-json",
            "-",
            body=json.dumps(
                {
                    "text": "operator ' text\n",
                    "data": {"id": "cannot spoof envelope"},
                    "key": "example",
                }
            ),
        )
        self.assertNotEqual(first["id"], first["data"]["id"])
        reply = self.run_cli(
            "reply",
            "--input-json",
            "-",
            body=json.dumps(
                {
                    "thread_id": first["thread_id"],
                    "parent_id": first["id"],
                    "text": "explicit response",
                }
            ),
        )
        self.assertEqual(reply["direction"], "outbound")
        page = self.run_cli("read-thread", first["thread_id"], "--limit", "1")
        self.assertEqual(page["messages"], [first])
        self.assertEqual(
            self.run_cli(
                "read-thread", first["thread_id"], "--after", str(page["next_cursor"])
            )["messages"],
            [reply],
        )
        self.run_cli("ack", first["id"])
        self.assertEqual(self.run_cli("pending")["messages"], [])
        self.assertEqual(self.run_cli("status")["messages"], 2)

    def test_malformed_requests_are_useful_errors(self):
        for body in (
            "[]",
            "{",
            '{"seq": 8}',
            '{"direction":"outbound"}',
            '{"text":false}',
            '{"data":NaN}',
            '{"text":"a","text":"b"}',
        ):
            with self.subTest(body=body):
                self.run_cli("post", "--input-json", "-", body=body, success=False)
        self.run_cli(
            "reply", "--input-json", "-", body='{"text":"no parent"}', success=False
        )
        self.run_cli("post", "--body-file", "-", body="x" * 65537, success=False)
        self.run_cli("pending", "--after", "-1", success=False)
        self.run_cli("pending", "--limit", "0", success=False)
        self.run_cli("ack", "latest", success=False)

    def test_crash_releases_lock_and_pipe_does_not_ack(self):
        message = self.run_cli("post", "--body-file", "-", body="wake")

        def launch():
            process = subprocess.Popen(
                [*self.command, "consume"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            self.addCleanup(lambda: process.poll() is None and process.kill())
            return process

        def read_batch(process):
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                self.assertTrue(
                    selector.select(timeout=10), "consumer failed to deliver"
                )
            return json.loads(process.stdout.readline())["messages"]

        first = launch()
        self.assertEqual(read_batch(first), [message])
        self.run_cli("consume", success=False)
        self.assertTrue(self.run_cli("status")["consumer_active"])
        first.kill()
        first.communicate(timeout=10)
        second = launch()
        self.assertEqual(read_batch(second), [message])
        self.assertEqual(self.run_cli("pending")["messages"], [message])
        second.send_signal(signal.SIGTERM)
        second.communicate(timeout=10)
        self.assertEqual(second.returncode, 0)
        self.assertFalse(self.run_cli("status")["consumer_active"])

    def test_default_is_external_and_uninstall_preserves_other_files(self):
        env = dict(os.environ, INBOX_AXI_HOME=self.root)
        result = subprocess.run(
            [sys.executable, "-m", "inbox_axi", "--json", "init"],
            env=env,
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["root"], self.root)

    def test_parent_pipe_eof_releases_idle_consumer(self):
        process = subprocess.Popen(
            [*self.command, "consume", "--parent-pipe"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.addCleanup(lambda: process.poll() is None and process.kill())
        self.assertEqual(json.loads(process.stdout.readline())["event"], "ready")
        process.stdin.close()
        process.wait(timeout=5)
        self.assertEqual(process.returncode, 0)
        process.stdout.close()
        process.stderr.close()
        self.assertFalse(self.run_cli("status")["consumer_active"])

    def test_compact_defaults_and_full_json_escape(self):
        text = "quoted\x1b[31m\n" + "x" * 400
        first = self.run_cli("post", "--body-file", "-", body=text)
        command = [sys.executable, "-m", "inbox_axi", "--home", self.root]
        result = subprocess.run(
            [*command, "pending"], text=True, capture_output=True, timeout=10
        )
        self.assertEqual(result.returncode, 0)
        self.assertLess(len(result.stdout), 400)
        self.assertNotIn("\x1b", result.stdout)
        self.assertIn("\\u001b", result.stdout)
        self.assertEqual(
            self.run_cli("read-thread", first["thread_id"])["messages"][0]["text"], text
        )

    def test_setup_and_uninstall_never_rewrite_config(self):
        config = Path(self.temp.name) / ".mcp.json"
        config.write_text('{"unrelated":true}')
        for harness in ("pi", "codex", "claude"):
            recipe = self.run_cli("setup", harness)
            self.assertFalse(recipe["writes_config"])
            self.assertFalse(recipe["capability_verified"])
            if harness == "claude":
                self.assertFalse(recipe["automatic_push_enabled"])
                self.assertEqual(recipe["native_session_fencing"], "unsupported")
                self.assertNotIn(
                    "dangerously-load-development-channels", recipe["launch"]
                )
        self.run_cli("setup", "claude", "--session", "latest", success=False)
        self.run_cli("setup", "pi", "--session", "ignored", success=False)
        self.run_cli("uninstall")
        self.assertEqual(config.read_text(), '{"unrelated":true}')
        self.assertFalse(Path(self.root).exists())

    def test_aborted_sqlite_transaction_rolls_back(self):
        first = self.run_cli("post", "--body-file", "-", body="committed")
        code = (
            "import os,sys; from inbox_axi.store import Store; "
            "s=Store(sys.argv[1]); s.db.execute('begin immediate'); "
            "s.db.execute(\"insert into threads values (?,?)\", ('thr_'+'a'*32, '{}')); "
            "os._exit(0)"
        )
        result = subprocess.run([sys.executable, "-c", code, self.root], timeout=10)
        self.assertEqual(result.returncode, 0)
        status = self.run_cli("status")
        self.assertEqual(status["threads"], 1)
        self.assertEqual(status["messages"], 1)
        self.assertEqual(self.run_cli("pending")["messages"], [first])

    def test_human_init_and_status_counts_are_not_message_pages(self):
        command = [sys.executable, "-m", "inbox_axi", "--home", self.root]
        for name in ("init", "status"):
            result = subprocess.run(
                [*command, name], text=True, capture_output=True, timeout=10
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["messages"], 0)
