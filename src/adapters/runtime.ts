import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
import { parseJson } from "../codec.js";
import { InboxError } from "../errors.js";
import { expandHome } from "../paths.js";
import type { Message } from "../types.js";

export function cliBinding(home: string | undefined) {
  if (!home || (!isAbsolute(home) && home !== "~" && !home.startsWith("~/")))
    throw new InboxError("inbox requires an absolute inbox_axi_home");
  home = expandHome(home);
  const node = process.env.INBOX_AXI_NODE || process.execPath;
  const cli =
    process.env.INBOX_AXI_CLI ||
    fileURLToPath(new URL("../cli.js", import.meta.url));
  if (!isAbsolute(node) || !isAbsolute(cli))
    throw new InboxError("inbox node and cli bindings must be absolute paths");
  return {
    node,
    cli,
    argv(command: string, args: string[] = []) {
      return [cli, command, "--home", home, "--json", ...args];
    },
  };
}

export function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function batchFrame(
  line: string,
): { version: 1; event: "ready" } | { version: 1; messages: Message[] } {
  if (Buffer.byteLength(line) > 1048576)
    throw new InboxError("inbox frame exceeds limit");
  const batch = parseJson(line);
  if (object(batch) && typeof batch.error === "string")
    throw new InboxError(batch.error);
  if (!object(batch) || batch.version !== 1)
    throw new InboxError("invalid inbox batch");
  if (batch.event === "ready") return { version: 1, event: "ready" };
  if (
    !Array.isArray(batch.messages) ||
    batch.messages.length > 8 ||
    batch.messages.some(
      (message) =>
        !object(message) ||
        message.version !== 1 ||
        typeof message.id !== "string" ||
        !/^msg_[0-9a-f]{32}$/.test(message.id) ||
        typeof message.thread_id !== "string" ||
        !/^thr_[0-9a-f]{32}$/.test(message.thread_id),
    )
  )
    throw new InboxError("invalid inbox batch");
  return batch as unknown as { version: 1; messages: Message[] };
}
