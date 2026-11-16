"""transactional mailbox; the local operating system user is the authority."""

import json
import os
import re
import sqlite3
import stat
import time
import uuid
from pathlib import Path


class InboxError(ValueError):
    pass


def canonical(value):
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
    except (ValueError, TypeError, RecursionError) as exc:
        raise InboxError("invalid json value") from exc


def identifier(value, prefix):
    if not isinstance(value, str) or not re.fullmatch(prefix + r"_[0-9a-f]{32}", value):
        raise InboxError("invalid " + prefix + " identifier")
    return value


def integer(value, minimum, maximum, name):
    if type(value) is not int or not minimum <= value <= maximum:
        raise InboxError(f"{name} must be an integer between {minimum} and {maximum}")
    return value


def bounded(value, maximum, name):
    try:
        size = len(value.encode("utf-8"))
    except (AttributeError, UnicodeError) as exc:
        raise InboxError(name + " must be utf-8 text") from exc
    if size > maximum:
        raise InboxError(name + " is too large")
    return value


def default_root():
    return Path(
        os.environ.get(
            "INBOX_AXI_HOME",
            str(
                Path(
                    os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state"))
                )
                / "inbox-axi"
            ),
        )
    )


def private_file(path, create=True):
    flags = os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK
    if create:
        flags |= os.O_CREAT
    try:
        fd = os.open(str(path), flags, 0o600)
    except FileNotFoundError:
        if not create:
            return
        raise
    try:
        info = os.fstat(fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or info.st_mode & 0o077
            or info.st_nlink not in ((1,) if create else (0, 1))
        ):
            raise InboxError("unsafe private file ownership, type or permissions")
    finally:
        os.close(fd)


def private_root(root):
    root = Path(root).expanduser().absolute()
    for part in [*reversed(root.parents), root]:
        if part.is_symlink():
            raise InboxError("symlink paths are not supported; use a physical path")
        if not part.exists():
            try:
                part.mkdir(mode=0o700)
            except FileExistsError:
                if part.is_symlink():
                    raise InboxError("symlink paths are not supported")
        if not part.is_dir():
            raise InboxError("store path must be a directory")
    info = root.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise InboxError("store root must be owned by this user with mode 700")
    for part in root.parents:
        info = part.stat()
        if info.st_uid not in (0, os.getuid()) or (
            info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX
        ):
            raise InboxError("store ancestors must not be writable by other users")
    return root


class Store:
    def __init__(self, root=None):
        self.root = private_root(root if root is not None else default_root())
        path = self.root / "inbox.sqlite3"
        private_file(path)
        for suffix in ("-journal", "-wal", "-shm"):
            sidecar = Path(str(path) + suffix)
            if sidecar.exists() or sidecar.is_symlink():
                private_file(sidecar, create=False)
        self.db = sqlite3.connect(str(path), timeout=10, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("pragma foreign_keys=on")
        version = self.db.execute("pragma user_version").fetchone()[0]
        if version not in (0, 1):
            self.db.close()
            raise InboxError("unsupported database version")
        self.db.executescript(
            """
            begin immediate;
            create table if not exists threads (
                id text primary key, metadata text not null
            );
            create table if not exists messages (
                seq integer primary key autoincrement,
                id text unique not null,
                thread_id text not null references threads(id),
                parent_id text references messages(id),
                direction text not null check(direction in ('inbound','outbound')),
                text text not null, data text not null, created_at real not null,
                acked_at real
            );
            create index if not exists thread_order on messages(thread_id, seq);
            create index if not exists pending_order on messages(direction, acked_at, seq);
            create table if not exists requests (
                key text primary key, payload text not null,
                message_id text not null references messages(id)
            );
            create table if not exists delivery_blocks (
                message_id text primary key references messages(id),
                target text not null, reason text not null
            );
            pragma user_version=1;
            commit;
        """
        )

    def close(self):
        self.db.close()

    def envelope(self, row):
        return {
            "version": 1,
            "id": row["id"],
            "thread_id": row["thread_id"],
            "seq": row["seq"],
            "parent_id": row["parent_id"],
            "direction": row["direction"],
            "text": row["text"],
            "data": json.loads(row["data"]),
            "created_at": row["created_at"],
        }

    def message(self, message_id):
        identifier(message_id, "msg")
        row = self.db.execute(
            "select * from messages where id=?", (message_id,)
        ).fetchone()
        if row is None:
            raise InboxError("unknown message identifier")
        return self.envelope(row)

    def post(
        self,
        *,
        text="",
        data=None,
        thread_id=None,
        parent_id=None,
        direction="inbound",
        metadata=None,
        key=None,
    ):
        bounded(text, 16384, "text")
        encoded = bounded(canonical(data), 16384, "data")
        if metadata is not None and not isinstance(metadata, dict):
            raise InboxError("metadata must be an object")
        meta = bounded(canonical(metadata or {}), 4096, "metadata")
        if direction not in ("inbound", "outbound"):
            raise InboxError("invalid direction")
        if thread_id is not None:
            identifier(thread_id, "thr")
            if metadata is not None:
                raise InboxError("metadata is only accepted when creating a thread")
        if parent_id is not None:
            identifier(parent_id, "msg")
            if thread_id is None:
                raise InboxError("parent requires an explicit thread identifier")
        if direction == "outbound" and parent_id is None:
            raise InboxError("reply requires an explicit parent identifier")
        if key is not None:
            if not isinstance(key, str) or not re.fullmatch(
                r"[a-zA-Z0-9._:-]{1,128}", key
            ):
                raise InboxError("invalid idempotency key")
        payload = canonical(
            {
                "text": text,
                "data": data,
                "thread_id": thread_id,
                "parent_id": parent_id,
                "direction": direction,
                "metadata": metadata,
            }
        )
        self.db.execute("begin immediate")
        try:
            if key is not None:
                previous = self.db.execute(
                    "select * from requests where key=?", (key,)
                ).fetchone()
                if previous:
                    if previous["payload"] != payload:
                        raise InboxError(
                            "idempotency key already used for a different payload"
                        )
                    result = self.message(previous["message_id"])
                    self.db.execute("commit")
                    return result
            if thread_id is None:
                thread_id = "thr_" + uuid.uuid4().hex
                self.db.execute("insert into threads values (?,?)", (thread_id, meta))
            elif not self.db.execute(
                "select 1 from threads where id=?", (thread_id,)
            ).fetchone():
                raise InboxError("unknown thread identifier")
            if (
                parent_id is not None
                and self.message(parent_id)["thread_id"] != thread_id
            ):
                raise InboxError("parent must belong to the same thread")
            message_id = "msg_" + uuid.uuid4().hex
            self.db.execute(
                "insert into messages (id,thread_id,parent_id,direction,text,data,created_at) values (?,?,?,?,?,?,?)",
                (
                    message_id,
                    thread_id,
                    parent_id,
                    direction,
                    text,
                    encoded,
                    time.time(),
                ),
            )
            if key is not None:
                self.db.execute(
                    "insert into requests values (?,?,?)", (key, payload, message_id)
                )
            result = self.message(message_id)
            self.db.execute("commit")
            return result
        except BaseException:
            self.db.execute("rollback")
            raise

    def page(self, *, thread_id=None, pending=False, after=0, limit=20):
        integer(after, 0, 9223372036854775807, "cursor")
        integer(limit, 1, 100, "limit")
        if type(pending) is not bool:
            raise InboxError("pending must be boolean")
        where, args = ["seq> ?"], [after]
        metadata = None
        if thread_id is not None:
            identifier(thread_id, "thr")
            row = self.db.execute(
                "select metadata from threads where id=?", (thread_id,)
            ).fetchone()
            if row is None:
                raise InboxError("unknown thread identifier")
            metadata = json.loads(row[0])
            where.append("thread_id=?")
            args.append(thread_id)
        if pending:
            where.append("direction='inbound' and acked_at is null")
        rows = self.db.execute(
            "select * from messages where "
            + " and ".join(where)
            + " order by seq limit ?",
            (*args, limit + 1),
        ).fetchall()
        items = [self.envelope(row) for row in rows[:limit]]
        return {
            "version": 1,
            "messages": items,
            "next_cursor": items[-1]["seq"] if len(rows) > limit else None,
            "metadata": metadata,
        }

    def ack(self, message_id):
        message = self.message(message_id)
        if message["direction"] != "inbound":
            raise InboxError("only inbound messages can be acknowledged")
        self.db.execute(
            "update messages set acked_at=coalesce(acked_at,?) where id=?",
            (time.time(), message_id),
        )
        return {"id": message_id, "incorporated": True}

    def block_delivery(self, message_id, target, reason):
        self.message(message_id)
        self.db.execute(
            "insert or replace into delivery_blocks values (?,?,?)",
            (message_id, target, reason),
        )

    def delivery_block(self, message_id):
        self.message(message_id)
        row = self.db.execute(
            "select * from delivery_blocks where message_id=?", (message_id,)
        ).fetchone()
        return dict(row) if row else None

    def retry(self, message_id):
        self.message(message_id)
        self.db.execute("delete from delivery_blocks where message_id=?", (message_id,))
        return {"id": message_id, "retry_authorized": True}

    def status(self):
        return {
            "version": 1,
            "root": str(self.root),
            "blocked_deliveries": self.db.execute(
                "select count(*) from delivery_blocks b join messages m on b.message_id=m.id where m.acked_at is null"
            ).fetchone()[0],
            "threads": self.db.execute("select count(*) from threads").fetchone()[0],
            "messages": self.db.execute("select count(*) from messages").fetchone()[0],
            "pending": self.db.execute(
                "select count(*) from messages where direction='inbound' and acked_at is null"
            ).fetchone()[0],
        }
