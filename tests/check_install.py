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
    cli(["ack", first["id"]])
    assert cli(["status"])["pending"] == 0
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
