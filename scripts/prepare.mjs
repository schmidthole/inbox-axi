import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Packed installs have no sources. Git and directory installs do, and npm
// runs prepare for those before the package is usable.
const root = fileURLToPath(new URL("../", import.meta.url));
if (!existsSync(new URL("../src/cli.ts", import.meta.url))) process.exit(0);

const localTsc = new URL("../node_modules/typescript/bin/tsc", import.meta.url);
if (existsSync(localTsc)) {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./build.mjs", import.meta.url))],
    { cwd: root, stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
}

// npm install -g git+... runs prepare before the clone has node_modules.
// Download the pinned compiler and emit without typechecking. make check
// still typechecks once the dev toolchain is installed.
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const version = pkg.devDependencies.typescript;
const dir = mkdtempSync(join(tmpdir(), "inbox-axi-tsc-"));
let status = 1;
try {
  const metaRes = await fetch(
    `https://registry.npmjs.org/typescript/${version}`,
  );
  if (!metaRes.ok)
    throw new Error(`unable to download typescript@${version} metadata`);
  const meta = await metaRes.json();
  const tarRes = await fetch(meta.dist.tarball);
  if (!tarRes.ok) throw new Error("unable to download the typescript tarball");
  const bytes = Buffer.from(await tarRes.arrayBuffer());
  const dash = String(meta.dist.integrity).indexOf("-");
  const actual = createHash(String(meta.dist.integrity).slice(0, dash))
    .update(bytes)
    .digest("base64");
  if (actual !== String(meta.dist.integrity).slice(dash + 1))
    throw new Error("typescript tarball failed its integrity check");
  const archive = join(dir, "typescript.tgz");
  writeFileSync(archive, bytes);
  const extracted = spawnSync("tar", ["-xzf", archive, "-C", dir], {
    stdio: "inherit",
  });
  if (extracted.status !== 0) throw new Error("unable to extract typescript");
  rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
  const compiled = spawnSync(
    process.execPath,
    [
      join(dir, "package", "bin", "tsc"),
      "-p",
      root,
      "--noCheck",
      "--pretty",
      "false",
    ],
    { cwd: root, stdio: "inherit" },
  );
  status = compiled.status ?? 1;
} catch (error) {
  process.stderr.write(
    String(error instanceof Error ? error.message : error) + "\n",
  );
  status = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(status);
