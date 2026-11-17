import { writeFileSync } from "node:fs";

if (process.env.INBOX_FIXTURE_PID)
  writeFileSync(process.env.INBOX_FIXTURE_PID, String(process.pid));
if (process.argv[2] !== "consume") process.exit(1);
process.stdout.write('{"version":1,"event":"ready"}\n');
if (process.env.INBOX_FIXTURE_MODE === "malformed") {
  process.stdout.write('{"version":1,"version":1,"messages":[]}\n');
} else {
  // leave the process alive after stdout eof; the adapter must terminate it.
  process.stdout.end();
}
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
setInterval(() => {}, 1000);
