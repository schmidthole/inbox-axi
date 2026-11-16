"""session-scoped launch recipes and honest offline diagnostics."""

import importlib.util
import shlex
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

from ..delivery import active
from ..store import InboxError, Store, canonical, default_root


ASSETS = Path(__file__).parent


def management(args):
    if args.command == "uninstall":
        return {
            "instructions": "stop the native session/adapter, relaunch without its extension/channel flags, then uninstall the python package and optional node dependencies; no harness config was written; mailbox retained"
        }
    root = (
        Path(args.home if args.home is not None else default_root())
        .expanduser()
        .absolute()
    )
    environment = {"INBOX_AXI_HOME": str(root), "INBOX_AXI_PYTHON": sys.executable}
    if args.command == "setup":
        if args.session and args.harness != "claude":
            raise InboxError("session selector is only supported for claude setup")
        result = {
            "harness": args.harness,
            "writes_config": False,
            "environment": environment,
            "capability_verified": False,
        }
        if args.harness == "pi":
            command = ["pi", "-e", str(ASSETS / "pi.ts")]
            result["launch"] = (
                " ".join(
                    f"{key}={shlex.quote(value)}" for key, value in environment.items()
                )
                + " "
                + shlex.join(command)
            )
            result["requirements"] = (
                "interactive native pi with its user-message api; one mailbox per workspace; not live-verified"
            )
        elif args.harness == "claude":
            session = args.session or str(uuid.uuid4())
            try:
                if str(uuid.UUID(session)) != session:
                    raise ValueError()
            except ValueError as exc:
                raise InboxError("session must be an exact lowercase uuid") from exc
            environment["INBOX_AXI_SESSION"] = session
            config = {
                "mcpServers": {
                    "inbox": {
                        "command": shutil.which("node") or "node",
                        "args": [str(ASSETS / "claude.mjs")],
                        "env": environment,
                    }
                }
            }
            result["mcp_config"] = config
            result["dependencies"] = shlex.join(
                ["npm", "ci", "--omit=dev", "--ignore-scripts", "--prefix", str(ASSETS)]
            )
            result["launch"] = shlex.join(
                [
                    "claude",
                    "--session-id",
                    session,
                    "--mcp-config",
                    canonical(config),
                ]
            )
            result["native_session_fencing"] = "unsupported"
            result["automatic_push_enabled"] = False
            result["requirements"] = (
                "node >=24 and mcp consent; tools-only, automatic push disabled because native session switching cannot be atomically fenced; use manual inbox-axi read-thread/ack/reply"
            )
        else:
            result["launch_template"] = (
                shlex.join(
                    [sys.executable, "-m", "inbox_axi", "--home", str(root), "codex"]
                )
                + " --socket <shared-private-socket> --codex-home <exact-server-home> --server-version <exact-version> --thread <native-thread-uuid>"
            )
            result["requirements"] = (
                "install inbox-axi[codex]; open the exact thread in native codex sharing the selected server; no backend fallback or session resume; uncertain submissions require explicit retry"
            )
        return result
    executable = shutil.which(args.harness)
    version = None
    error = None
    if executable:
        try:
            probe = subprocess.run(
                [executable, "--version"], capture_output=True, text=True, timeout=5
            )
            if probe.returncode == 0:
                version = probe.stdout.strip()[:200]
            else:
                error = "version probe failed"
        except (OSError, subprocess.TimeoutExpired):
            error = "version probe failed or timed out"
    consumer_active = False
    if (root / "inbox.sqlite3").exists():
        store = Store(root)
        try:
            consumer_active = active(store)
        finally:
            store.close()
    dependencies = True
    if args.harness == "codex":
        dependencies = importlib.util.find_spec("websockets") is not None
    elif args.harness == "claude":
        dependencies = (
            ASSETS / "node_modules/@modelcontextprotocol/sdk/package.json"
        ).is_file() and shutil.which("node") is not None
    return {
        "native_session_fencing": (
            "unsupported" if args.harness == "claude" else "not_live_verified"
        ),
        "automatic_push_enabled": (
            False if args.harness == "claude" else "session_scoped_opt_in"
        ),
        "harness": args.harness,
        "installed": executable is not None,
        "executable": executable,
        "version": version,
        "probe_error": error,
        "optional_dependencies_present": dependencies,
        "configured": "session-scoped; not inferred",
        "mailbox_consumer_active": consumer_active,
        "harness_active": "unknown",
        "capability_verified": False,
        "limitations": "offline availability only; native idle wake, busy steering, auth/policy admission and permissions require manual native session verification",
    }
