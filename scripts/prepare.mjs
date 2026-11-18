import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Packed installs have no sources. Git and directory installs do, and npm
// runs prepare for those before the package is usable.
if (!existsSync(new URL("../src/cli.ts", import.meta.url))) process.exit(0);

const root = fileURLToPath(new URL("../", import.meta.url));
function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run([fileURLToPath(new URL("./build.mjs", import.meta.url))]);
run([
  "--import",
  "tsx",
  fileURLToPath(new URL("./generate-skill.ts", import.meta.url)),
  "--check",
]);
