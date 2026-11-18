import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const SOURCE = resolve(".");
function run(
  command: string,
  args: string[],
  cwd: string,
  options: Record<string, unknown> = {},
) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 120000,
    ...options,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}
test("generated skill is derived from static guidance and rejects drift", () => {
  run(
    process.execPath,
    ["--import", "tsx", "scripts/generate-skill.ts", "--check"],
    SOURCE,
  );
  const skill = readFileSync("skills/inbox-axi/SKILL.md", "utf8");
  assert.match(
    skill,
    /npm install -g git\+https:\/\/github.com\/schmidthole\/inbox-axi\.git/,
  );
  assert.match(skill, /not published to the npm registry/);
  assert.doesNotMatch(skill, /npx -y inbox-axi/);
  assert.match(skill, /^- inbox-axi pending:/m);
  assert.ok(!/messages\[|previous_session|consumer_active/.test(skill));
});
test(
  "packed install outside source runs without python and includes all native assets",
  { timeout: 120000 },
  () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "inbox-pack-"));
    try {
      const pack = JSON.parse(
        run(
          "npm",
          ["pack", "--ignore-scripts", "--pack-destination", root, "--json"],
          SOURCE,
        ),
      );
      const files = pack[0].files.map((f: { path: string }) => f.path);
      for (const path of [
        "bin/inbox-axi.js",
        "dist/cli.js",
        "dist/adapters/pi.js",
        "dist/adapters/codex.js",
        "dist/adapters/claude.js",
        "skills/inbox-axi/SKILL.md",
      ])
        assert.ok(files.includes(path), path);
      assert.ok(
        !files.some(
          (path: string) =>
            path.endsWith(".py") ||
            path.startsWith("src/") ||
            path.startsWith("test/"),
        ),
      );
      const install = join(root, "install");
      mkdirSync(install);
      run(
        "npm",
        [
          "install",
          // npm ci does not store registry packuments, so --offline fails on a cold cache.
          "--prefer-offline",
          "--no-audit",
          "--no-fund",
          "--prefix",
          install,
          join(root, pack[0].filename),
        ],
        root,
      );
      const pkg = join(install, "node_modules", "inbox-axi");
      const cli = join(pkg, "bin", "inbox-axi.js");
      const home = join(root, "mailbox");
      const environment = {
        ...process.env,
        PATH: "/nonexistent",
        INBOX_AXI_HOME: home,
        HOME: root,
      };
      const invoke = (args: string[], input?: string) =>
        run(process.execPath, [cli, ...args], root, {
          env: environment,
          input,
        });
      assert.equal(invoke(["--version"]), "0.2.0\n");
      const posted = JSON.parse(
        invoke(["post", "--body-file", "-", "--json"], "packed request"),
      );
      assert.equal(posted.text, "packed request");
      const reply = JSON.parse(
        invoke(
          [
            "reply",
            "--thread",
            posted.thread_id,
            "--parent",
            posted.id,
            "--body-file",
            "-",
            "--json",
          ],
          "packed reply",
        ),
      );
      assert.equal(reply.parent_id, posted.id);
      const detail = JSON.parse(
        invoke(["read-thread", posted.thread_id, "--json"]),
      );
      assert.equal(detail.messages.length, 2);
      assert.equal(detail.total, 2);
      invoke(["ack", posted.id, "--json"]);
      assert.equal(JSON.parse(invoke(["status", "--json"])).pending, 0);
      for (const harness of ["pi", "claude", "codex"]) {
        const setup = JSON.parse(invoke(["setup", harness, "--json"]));
        assert.equal(
          setup.environment.INBOX_AXI_CLI,
          join(pkg, "dist", "cli.js"),
        );
        assert.ok(existsSync(join(pkg, "dist", "adapters", harness + ".js")));
      }
      const delivered = JSON.parse(
        run(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `const {Store}=await import(${JSON.stringify("file://" + join(pkg, "dist/store.js"))});const {deliveryInput}=await import(${JSON.stringify("file://" + join(pkg, "dist/adapters/codex.js"))});const store=new Store(${JSON.stringify(home)});process.stdout.write(deliveryInput(store,store.message(${JSON.stringify(posted.id)})).split('\\n')[1]);store.close();`,
          ],
          root,
          { env: environment },
        ),
      );
      for (const [name, input] of [
        ["read_thread_argv", undefined],
        ["reply_argv", "reply from delivered installed argv"],
        ["ack_argv", undefined],
      ] as const) {
        const argv = delivered.mailbox[name];
        assert.equal(argv[0], process.execPath);
        assert.equal(argv[1], join(pkg, "dist/cli.js"));
        const value = JSON.parse(
          run(argv[0], argv.slice(1), root, { env: environment, input }),
        );
        if (name === "read_thread_argv")
          assert.equal(value.messages[0].id, posted.id);
        if (name === "reply_argv") {
          assert.equal(value.thread_id, posted.thread_id);
          assert.equal(value.parent_id, posted.id);
        }
      }
      run(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const pi=await import(${JSON.stringify("file://" + join(pkg, "dist/adapters/pi.js"))});if(typeof pi.default!=='function')process.exit(1);const codex=await import(${JSON.stringify("file://" + join(pkg, "dist/adapters/codex.js"))});if(typeof codex.run!=='function')process.exit(1);const claude=await import(${JSON.stringify("file://" + join(pkg, "dist/adapters/claude.js"))});if(typeof claude.serveInbox!=='function')process.exit(1);`,
        ],
        root,
        { env: environment },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
