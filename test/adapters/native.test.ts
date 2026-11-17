import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

for (const name of ["pi", "claude", "pi-boundaries"]) {
  test(
    `${name} deterministic native lifecycle fixture`,
    { timeout: 120000 },
    async () => {
      const result = await new Promise<{ code: number | null; output: string }>(
        (accept, reject) => {
          const child = spawn(
            process.execPath,
            [resolve(`test/adapters/${name}-fixture.mjs`)],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          let output = "";
          const timer = setTimeout(() => child.kill("SIGKILL"), 110000);
          child.stdout.on("data", (data) => {
            output += data;
          });
          child.stderr.on("data", (data) => {
            output += data;
          });
          child.once("error", reject);
          child.once("close", (code) => {
            clearTimeout(timer);
            accept({ code, output });
          });
        },
      );
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /fixture passed/);
    },
  );
}
