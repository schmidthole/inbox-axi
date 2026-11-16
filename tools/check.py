"""compile sources and reject uppercase source comments and trailing whitespace."""

import ast
import io
import tokenize
from pathlib import Path


for root in ("src", "tests", "tools", "examples"):
    for path in Path(root).rglob("*.py"):
        if "node_modules" in path.parts:
            continue
        text = path.read_text()
        ast.parse(text, filename=str(path), feature_version=(3, 9))
        compile(text, str(path), "exec")
        for token in tokenize.generate_tokens(io.StringIO(text).readline):
            if token.type == tokenize.COMMENT and token.string != token.string.lower():
                raise SystemExit(f"uppercase comment: {path}:{token.start[0]}")
        for number, line in enumerate(text.splitlines(), 1):
            if line.rstrip() != line:
                raise SystemExit(f"trailing whitespace: {path}:{number}")
print("source checks passed")
