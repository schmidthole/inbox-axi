import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expandHome } from "../../src/paths.js";
import { InboxError } from "../../src/errors.js";

test("expandHome treats bare tilde and ~/ the same and leaves ~user alone", () => {
  assert.equal(expandHome("~"), resolve(homedir()));
  assert.equal(expandHome("~/"), resolve(homedir()));
  assert.equal(expandHome("~/mailbox"), resolve(join(homedir(), "mailbox")));
  assert.equal(expandHome("~/a/b"), resolve(join(homedir(), "a/b")));
  assert.equal(expandHome("~mailbox"), resolve("~mailbox"));
  assert.equal(expandHome("mailbox"), resolve("mailbox"));
  assert.equal(expandHome("/tmp/inbox"), resolve("/tmp/inbox"));
  assert.notEqual(expandHome("~/mailbox"), resolve("~/mailbox"));
  assert.throws(() => expandHome(""), InboxError);
  assert.throws(() => expandHome(1 as never), { message: "path must be text" });
});

test("realpath is opt-in so mailbox normalization does not follow symlinks", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "inbox-path-")));
  try {
    const target = join(base, "target");
    mkdirSync(target);
    const link = join(base, "link");
    symlinkSync(target, link);
    assert.equal(expandHome(link), resolve(link));
    assert.equal(expandHome(link, { realpath: true }), target);
    const missing = join(base, "missing");
    assert.equal(expandHome(missing, { realpath: true }), resolve(missing));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
