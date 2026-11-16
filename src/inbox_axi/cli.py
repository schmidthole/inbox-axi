"""bounded local mailbox commands."""

import argparse
import json
import os
import signal
import select
import sqlite3
import sys
import time

from .delivery import Consumer, active
from .store import InboxError, Store, canonical


MAX_INPUT = 65536


def load_json(text):
    def reject_constant(value):
        raise InboxError("non-finite json numbers are not supported")

    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise InboxError("duplicate json object key")
            result[key] = value
        return result

    try:
        return json.loads(text, parse_constant=reject_constant, object_pairs_hook=pairs)
    except (ValueError, RecursionError) as exc:
        raise InboxError("invalid json input") from exc


def read_input(path):
    if path == "-":
        value = sys.stdin.buffer.read(MAX_INPUT + 1)
    else:
        with open(path, "rb") as handle:
            value = handle.read(MAX_INPUT + 1)
    if len(value) > MAX_INPUT:
        raise InboxError("input exceeds 65536 bytes")
    return value.decode("utf-8")


def emit(value, args):
    if args.json:
        print(canonical(value), flush=True)
        return
    if isinstance(value.get("messages"), list):
        for message in value["messages"]:
            emit(message, args)
        print("next_cursor=" + str(value["next_cursor"]))
    elif "text" in value:
        text = value["text"] if args.full else value["text"][:160]
        print(
            f'{value["id"]} thread={value["thread_id"]} seq={value["seq"]} {value["direction"]}'
        )
        print(json.dumps(text, ensure_ascii=True))
        if args.full:
            print("data=" + canonical(value["data"]))
    else:
        print(canonical(value))


def parser():
    result = argparse.ArgumentParser(
        prog="inbox-axi",
        description="private threaded operator inbox; local writers are authorized",
    )
    result.add_argument(
        "--home", help="private store root (default: inbox_axi_home or xdg state)"
    )
    result.add_argument(
        "--json",
        action="store_true",
        help="full machine-readable json, bounded by page size",
    )
    result.add_argument(
        "--full", action="store_true", help="show full message bodies and data"
    )
    commands = result.add_subparsers(dest="command", required=True)
    commands.add_parser("init", help="initialize a private mailbox")
    for name in ("post", "reply"):
        command = commands.add_parser(
            name, help="post inbound text or explicitly reply outbound"
        )
        command.add_argument("--thread")
        command.add_argument("--parent")
        command.add_argument("--key", help="transactional idempotency key")
        group = command.add_mutually_exclusive_group(required=True)
        group.add_argument("--body-file", help="utf-8 file or - for stdin")
        group.add_argument(
            "--input-json",
            help="request object file or - for stdin; cannot mix body fields",
        )
        command.add_argument("--data-json", help="json data file")
        if name == "post":
            command.add_argument(
                "--metadata-json", help="generic new-thread metadata file"
            )
    for name in ("read-thread", "pending"):
        command = commands.add_parser(name)
        if name == "read-thread":
            command.add_argument("thread")
        command.add_argument(
            "--after", type=int, default=0, help="exclusive server sequence cursor"
        )
        command.add_argument("--limit", type=int, default=20, help="1..100 messages")
    command = commands.add_parser(
        "ack", help="explicitly confirm incorporation, not completion"
    )
    command.add_argument("message")
    command = commands.add_parser(
        "ack-status",
        help="read incorporation flags for 1..8 explicit message ids; never acknowledges",
    )
    command.add_argument("messages", nargs="+")
    for name in ("delivery-state", "retry"):
        command = commands.add_parser(
            name, help="inspect uncertain delivery or explicitly authorize retry"
        )
        command.add_argument("message")
    command = commands.add_parser(
        "codex", help="bind to an existing native shared codex thread; never resumes"
    )
    command.add_argument("--socket", required=True)
    command.add_argument("--codex-home", required=True)
    command.add_argument("--server-version", required=True)
    command.add_argument("--thread", required=True)
    commands.add_parser("status")
    command = commands.add_parser(
        "consume", help="exclusive json-lines delivery until shutdown; never auto-acks"
    )
    command.add_argument(
        "--parent-pipe", action="store_true", help="stop on stdin eof (adapter use)"
    )
    command = commands.add_parser(
        "doctor", help="report harness availability without model calls"
    )
    command.add_argument("harness", choices=("pi", "codex", "claude"))
    command = commands.add_parser(
        "setup", help="print session-scoped adapter launch instructions"
    )
    command.add_argument("harness", choices=("pi", "codex", "claude"))
    commands.add_parser(
        "uninstall", help="explain reversible session-only removal; retain mailbox"
    )
    return result


def request(args):
    fields = {"thread_id": args.thread, "parent_id": args.parent, "key": args.key}
    if args.input_json:
        if (
            any(value is not None for value in fields.values())
            or args.data_json
            or getattr(args, "metadata_json", None)
        ):
            raise InboxError("input-json cannot be mixed with body fields")
        value = load_json(read_input(args.input_json))
        allowed = {"text", "data", "thread_id", "parent_id", "key", "metadata"}
        if not isinstance(value, dict) or set(value) - allowed:
            raise InboxError(
                "request must be an object containing only documented body fields"
            )
        fields = value
    else:
        fields["text"] = read_input(args.body_file)
        fields["data"] = (
            load_json(read_input(args.data_json)) if args.data_json else None
        )
        if getattr(args, "metadata_json", None):
            fields["metadata"] = load_json(read_input(args.metadata_json))
    if args.command == "reply":
        if not fields.get("thread_id") or not fields.get("parent_id"):
            raise InboxError("reply requires explicit thread_id and parent_id")
        fields["direction"] = "outbound"
    return fields


def consume(store, parent_pipe=False):
    consumer = Consumer(store)
    stopped = False

    def stop(_signal, _frame):
        nonlocal stopped
        stopped = True

    old = {
        number: signal.signal(number, stop)
        for number in (signal.SIGTERM, signal.SIGINT)
    }
    try:
        if parent_pipe:
            print(canonical({"version": 1, "event": "ready"}), flush=True)
        while not stopped:
            if parent_pipe and select.select([sys.stdin.buffer], [], [], 0)[0]:
                if not os.read(sys.stdin.fileno(), 1):
                    break
            messages = consumer.poll()
            if messages:
                print(canonical({"version": 1, "messages": messages}), flush=True)
            time.sleep(1)
    finally:
        consumer.close()
        for number, handler in old.items():
            signal.signal(number, handler)


def main(argv=None):
    args = parser().parse_args(argv)
    store = None
    try:
        if args.command in ("setup", "doctor", "uninstall"):
            from .adapters import management

            emit(management(args), args)
            return 0
        store = Store(args.home)
        if args.command in ("post", "reply"):
            value = store.post(**request(args))
        elif args.command in ("read-thread", "pending"):
            value = store.page(
                thread_id=getattr(args, "thread", None),
                pending=args.command == "pending",
                after=args.after,
                limit=args.limit,
            )
        elif args.command == "ack":
            value = store.ack(args.message)
        elif args.command == "ack-status":
            value = store.ack_status(args.messages)
        elif args.command == "delivery-state":
            value = {"id": args.message, "block": store.delivery_block(args.message)}
        elif args.command == "retry":
            value = store.retry(args.message)
        elif args.command == "codex":
            from .adapters.codex import run

            run(store, args)
            return 0
        elif args.command == "consume":
            consume(store, args.parent_pipe)
            return 0
        else:
            value = store.status()
            value["consumer_active"] = active(store)
        emit(value, args)
        return 0
    except (InboxError, OSError, sqlite3.Error, UnicodeError, RecursionError) as exc:
        print("error: " + str(exc).lower(), file=sys.stderr)
        return 2
    finally:
        if store is not None:
            store.close()
