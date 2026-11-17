"""build and install an isolated wheel; never import the working source tree."""

import json
import os
import subprocess
import sys
import tempfile
import venv
import zipfile
from pathlib import Path


root = Path(__file__).resolve().parent.parent
scratch = root / ".scratch"
scratch.mkdir(exist_ok=True)
env = dict(os.environ)
env.pop("PYTHONPATH", None)
env["PIP_CACHE_DIR"] = str(scratch / "pip-cache")
with tempfile.TemporaryDirectory(dir=str(scratch)) as temp:
    temp = Path(temp)
    env.pop("INBOX_AXI_HOME", None)
    env["HOME"] = str(temp / "unused-home")
    env["XDG_STATE_HOME"] = str(temp / "unused-state")
    subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "wheel",
            "--no-deps",
            "--no-build-isolation",
            "--wheel-dir",
            str(temp),
            str(root),
        ],
        check=True,
        env=env,
        cwd=str(root),
    )
    wheel = next(temp.glob("*.whl"))
    with zipfile.ZipFile(wheel) as archive:
        names = archive.namelist()
        for asset in ("pi.ts", "claude.mjs", "package.json", "package-lock.json"):
            assert "inbox_axi/adapters/" + asset in names, asset
        assert not any("node_modules" in name for name in names)
        assert not any(".scratch" in name for name in names)
    destination = temp / "runtime"
    venv.EnvBuilder(with_pip=True).create(str(destination))
    python = destination / "bin/python"
    subprocess.run(
        [str(python), "-m", "pip", "install", "--no-deps", str(wheel)],
        check=True,
        env=env,
        cwd=str(temp),
    )
    home = temp / "mailbox"
    command = [str(destination / "bin/inbox-axi"), "--home", str(home), "--json"]

    def cli(args, body=None):
        result = subprocess.run(
            [*command, *args],
            input=body,
            text=True,
            capture_output=True,
            env=env,
            cwd=str(temp),
            timeout=15,
        )
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)

    cli(["init"])
    first = cli(
        ["post", "--input-json", "-"],
        '{"text":"installed wheel","data":{"ok":true},"key":"installed"}',
    )
    assert cli(["pending"])["messages"] == [first]
    recipe = cli(["setup", "pi"])
    assert str(destination) in recipe["launch"]
    assert Path(recipe["launch"].split(" -e ")[1]).is_file()
    claude = cli(["setup", "claude"])
    assert claude["automatic_push_enabled"] is True
    assert claude["routing"] == "active_conversation"
    assert "--dangerously-load-development-channels server:inbox" in claude["launch"]
    assert "--session-id" not in claude["launch"]
    assert "INBOX_AXI_SESSION" not in claude["mcp_config"]["mcpServers"]["inbox"]["env"]
    assert Path(claude["mcp_config"]["mcpServers"]["inbox"]["args"][0]).is_file()
    result = subprocess.run(
        [
            str(python),
            "-c",
            "import sys; from inbox_axi.store import Store; "
            "from inbox_axi.adapters.codex import delivery_input; "
            "store = Store(sys.argv[1]); "
            "print(delivery_input(store, store.message(sys.argv[2]))); store.close()",
            str(home),
            first["id"],
        ],
        check=True,
        text=True,
        capture_output=True,
        env=env,
        cwd=str(temp),
        timeout=15,
    )
    delivery = json.loads(result.stdout.split("\n", 1)[1])
    assert delivery["message"] == first
    assert delivery["mailbox"]["home"] == str(home)
    native_env = {**env, "PATH": ""}

    def delivered(name, body=None):
        argv = delivery["mailbox"][name + "_argv"]
        assert argv[:3] == [str(python), "-m", "inbox_axi"]
        result = subprocess.run(
            argv,
            input=body,
            text=True,
            capture_output=True,
            env=native_env,
            cwd=str(temp),
            timeout=15,
        )
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)

    assert delivered("read_thread")["messages"] == [first]
    reply = delivered("reply", "installed explicit reply")
    assert reply["thread_id"] == first["thread_id"]
    assert reply["parent_id"] == first["id"]
    assert cli(["status"])["pending"] == 1
    assert delivered("ack")["incorporated"] is True
    assert cli(["status"])["pending"] == 0
    assert not Path(env["XDG_STATE_HOME"]).exists()
    assert not (Path(env["HOME"]) / ".local/state/inbox-axi").exists()
    result = subprocess.run(
        [
            str(python),
            "-c",
            "import importlib.util; assert importlib.util.find_spec('websockets') is None",
        ],
        env=env,
        cwd=str(temp),
    )
    assert result.returncode == 0
print("isolated stdlib-only wheel install and bundled assets passed")
