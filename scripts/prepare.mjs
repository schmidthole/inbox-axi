import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Packed installs have no sources. A checkout does, and npm runs prepare
// after its dependencies are installed. Do not typecheck with tsx here.
const root = fileURLToPath(new URL("../", import.meta.url));
if (!existsSync(new URL("../src/cli.ts", import.meta.url))) process.exit(0);

const result = spawnSync(
  process.execPath,
  [fileURLToPath(new URL("./build.mjs", import.meta.url))],
  { cwd: root, stdio: "inherit" },
);
process.exit(result.status ?? 1);
