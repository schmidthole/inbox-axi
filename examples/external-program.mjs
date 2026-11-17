import { spawnSync } from "node:child_process";
const request = { text: "review result", data: { score: 42 }, key: "job-42" };
const posted = spawnSync("inbox-axi", ["post", "--input-json", "-", "--json"], {
  input: JSON.stringify(request),
  encoding: "utf8",
});
if (posted.status !== 0) throw new Error(posted.stdout);
const message = JSON.parse(posted.stdout);
console.log(JSON.stringify({ id: message.id, thread_id: message.thread_id }));
