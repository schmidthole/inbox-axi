#!/usr/bin/env node
import { tryFastPath } from "axi-sdk-js/fast-path";
import { VERSION } from "../dist/version.js";
if (!tryFastPath(process.argv.slice(2), { version: VERSION })) {
  const { main } = await import("../dist/cli.js");
  const result = await main();
  // canceled output must not delay standalone exit after durable cleanup.
  if (result?.discardBufferedOutput) process.exit(process.exitCode ?? 0);
}
