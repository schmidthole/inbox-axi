import { openSync, readSync, closeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { encode } from "@toon-format/toon";
import { runAxiCli } from "axi-sdk-js";
import { canonical, integer, parseJson } from "./codec.js";
import { InboxError } from "./errors.js";
import { Store } from "./store.js";
import { Consumer, active } from "./delivery.js";
import {
  COMMAND_FLAGS,
  commandHelp,
  DESCRIPTION,
  GLOBALS,
  GUIDANCE,
  TOP_HELP,
} from "./guidance.js";
import { management } from "./management.js";
import { capture, previousContext, shellQuote } from "./lifecycle.js";
import { VERSION } from "./version.js";
import type { Message, PostOptions } from "./types.js";
type Args = { flags: Record<string, string | boolean>; positionals: string[] };
const GLOBAL_FLAGS = ["--home", "--json", "--full", "--fields"];
const BOOLEANS = new Set(["--json", "--full", "--parent-pipe"]);
function usage(message: string, command: string): never {
  throw new InboxError(message, "VALIDATION_ERROR", [
    commandHelp(command) ?? TOP_HELP,
  ]);
}
function parse(command: string, args: string[]): Args {
  const valid = [...(COMMAND_FLAGS[command] ?? []), ...GLOBAL_FLAGS, "--help"];
  const flags: Args["flags"] = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    const split = arg.indexOf("=");
    const flag = split < 0 ? arg : arg.slice(0, split);
    if (!valid.includes(flag))
      usage(`unknown flag ${flag}; valid flags: ${valid.join(", ")}`, command);
    if (flag in flags) usage(`duplicate flag ${flag}`, command);
    if (BOOLEANS.has(flag)) {
      if (split >= 0) usage(`${flag} takes no value`, command);
      flags[flag] = true;
    } else {
      const value = split < 0 ? args[++i] : arg.slice(split + 1);
      if (value === undefined || value.startsWith("--"))
        usage(`${flag} requires a value`, command);
      flags[flag] = value;
    }
  }
  const count = positionals.length;
  const bounds: Record<string, [number, number]> = {
    "read-thread": [1, 1],
    ack: [1, 1],
    "ack-status": [1, 8],
    "delivery-state": [1, 1],
    retry: [1, 1],
    setup: [1, 1],
    doctor: [1, 1],
    uninstall: [0, 1],
  };
  const [min, max] = bounds[command] ?? [0, 0];
  if (count < min || count > max)
    usage(
      `${command} requires ${min === max ? min : `${min}..${max}`} positional arguments`,
      command,
    );
  if (flags["--fields"]) {
    const fields = String(flags["--fields"]).split(",");
    if (fields.some((f) => !MESSAGE_FIELDS.includes(f)))
      usage(
        `unknown message field; valid fields: ${MESSAGE_FIELDS.join(",")}`,
        command,
      );
  }
  return { flags, positionals };
}
function normalize(argv: string[]): string[] {
  const leading: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const flag = argv[i].split("=")[0];
    if (!GLOBAL_FLAGS.includes(flag)) break;
    leading.push(argv[i++]);
    if (
      ["--home", "--fields"].includes(flag) &&
      !leading.at(-1)!.includes("=") &&
      i < argv.length
    )
      leading.push(argv[i++]);
  }
  if (i === argv.length) return leading.length ? ["home", ...leading] : [];
  return [argv[i], ...leading, ...argv.slice(i + 1)];
}
function input(path: string): string {
  const fd = path === "-" ? 0 : openSync(path, "r");
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total <= 65536) {
      const chunk = Buffer.alloc(Math.min(8192, 65537 - total));
      const size = readSync(fd, chunk, 0, chunk.length, null);
      if (!size) break;
      chunks.push(chunk.subarray(0, size));
      total += size;
    }
    if (total > 65536)
      throw new InboxError("input exceeds 65536 bytes", "VALIDATION_ERROR");
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } finally {
    if (fd !== 0) closeSync(fd);
  }
}
function request(command: string, args: Args): PostOptions {
  const f = args.flags;
  const body = f["--body-file"];
  const json = f["--input-json"];
  if (!!body === !!json)
    usage("provide exactly one of --body-file or --input-json", command);
  let value: PostOptions;
  if (json) {
    if (
      ["--thread", "--parent", "--key", "--data-json", "--metadata-json"].some(
        (k) => f[k] !== undefined,
      )
    )
      usage("--input-json cannot mix with body fields", command);
    const parsed = parseJson(input(String(json)));
    const allowed = [
      "text",
      "data",
      "thread_id",
      "parent_id",
      "key",
      "metadata",
    ];
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).some((k) => !allowed.includes(k))
    )
      usage(
        "request must be an object containing only documented body fields",
        command,
      );
    value = parsed as PostOptions;
  } else {
    value = {
      text: input(String(body)),
      data: f["--data-json"]
        ? parseJson(input(String(f["--data-json"])))
        : null,
    };
    for (const [flag, key] of [
      ["--thread", "thread_id"],
      ["--parent", "parent_id"],
      ["--key", "key"],
    ] as const)
      if (f[flag] !== undefined) value[key] = String(f[flag]);
    if (f["--metadata-json"])
      value.metadata = parseJson(
        input(String(f["--metadata-json"])),
      ) as PostOptions["metadata"];
  }
  if (command === "reply") {
    if (!value.thread_id || !value.parent_id)
      usage("reply requires explicit thread_id and parent_id", command);
    if (value.metadata !== undefined)
      usage("reply cannot include metadata", command);
    value.direction = "outbound";
  }
  return value;
}
const MESSAGE_FIELDS = [
  "version",
  "id",
  "thread_id",
  "seq",
  "parent_id",
  "direction",
  "text",
  "data",
  "created_at",
];
function printable(value: string): string {
  return value.replace(
    /[\u0000-\u001f\u007f-\u009f]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
function commandPrefix(args: Args): string {
  const home = args.flags["--home"] ?? process.env.INBOX_AXI_HOME;
  return "inbox-axi" + (home ? ` --home ${shellQuote(String(home))}` : "");
}
function preview(
  message: Message,
  args: Args,
  list: boolean,
): Record<string, unknown> {
  const full = !!args.flags["--full"];
  const fields = args.flags["--fields"]
    ? String(args.flags["--fields"]).split(",")
    : list
      ? ["id", "thread_id", "direction", "text"]
      : MESSAGE_FIELDS;
  const out: Record<string, unknown> = {};
  let truncated = false;
  for (const field of fields) {
    let value = (message as unknown as Record<string, unknown>)[field];
    if (field === "text" || field === "data") {
      const text = field === "text" ? String(value) : canonical(value);
      const length = Array.from(text).length;
      const shortened = !full && length > 800;
      truncated ||= shortened;
      value =
        printable(
          Array.from(text)
            .slice(0, full ? undefined : 800)
            .join(""),
        ) + (shortened ? " … (truncated)" : "");
      out[field] = value;
      if (shortened) out[field + "_length"] = length;
    } else out[field] = typeof value === "bigint" ? String(value) : value;
  }
  if (truncated)
    out.help = [
      `${commandPrefix(args)} read-thread ${message.thread_id} --after ${BigInt(message.seq) - 1n} --limit 1 --full`,
    ];
  return out;
}
function display(
  value: any,
  args: Args,
  command: string,
): Record<string, unknown> | string {
  if (args.flags["--json"]) return canonical(value);
  if (command === "home") return value;
  if (value && Array.isArray(value.messages)) {
    const result: Record<string, unknown> = {
      count: value.messages.length,
      total: value.total,
      messages: value.messages.map((m: Message) =>
        preview(m, args, command === "pending"),
      ),
      next_cursor:
        typeof value.next_cursor === "bigint"
          ? String(value.next_cursor)
          : value.next_cursor,
    };
    if (!value.messages.length)
      result.result =
        command === "pending"
          ? "0 pending messages found in this workspace"
          : "0 messages found in this thread";
    if (command === "read-thread") result.metadata = value.metadata;
    const prefix = commandPrefix(args);
    const hints =
      command === "read-thread"
        ? []
        : value.messages.length
          ? [`${prefix} read-thread ${value.messages[0].thread_id}`]
          : [`${prefix} post --body-file <file>`];
    if (value.next_cursor !== null)
      hints.push(
        `${prefix} ${command}${command === "read-thread" ? " " + args.positionals[0] : ""} --after ${value.next_cursor} --limit ${args.flags["--limit"] ?? 20}${args.flags["--full"] ? " --full" : ""}${args.flags["--fields"] ? ` --fields ${shellQuote(String(args.flags["--fields"]))}` : ""}`,
      );
    if (hints.length) result.help = hints;
    return result;
  }
  if (value && "text" in value) {
    const result = preview(value, args, false);
    if (command === "post" || command === "reply")
      result.help = [
        ...((result.help as string[] | undefined) ?? []),
        `${commandPrefix(args)} read-thread ${value.thread_id}`,
        ...(value.direction === "inbound"
          ? [`${commandPrefix(args)} ack ${value.id}`]
          : []),
      ];
    return result;
  }
  return value;
}
function sequence(value: string | boolean | undefined): number | bigint {
  if (value === undefined) return 0;
  if (typeof value !== "string" || !/^\d+$/.test(value))
    throw new InboxError("--after must be an integer", "VALIDATION_ERROR");
  const n = BigInt(value);
  return integer(n, 0n, 9223372036854775807n, "after");
}
async function consume(store: Store, parentPipe: boolean): Promise<void> {
  const consumer = new Consumer(store);
  let stop!: () => void;
  const stopped = new Promise<void>((r) => (stop = r));
  let done = false;
  const end = () => {
    done = true;
    stop();
  };
  process.once("SIGINT", end);
  process.once("SIGTERM", end);
  async function write(value: unknown): Promise<void> {
    if (!process.stdout.write(canonical(value) + "\n")) {
      let drain!: () => void;
      const ready = new Promise<void>((r) => {
        drain = r;
        process.stdout.once("drain", drain);
      });
      try {
        await Promise.race([ready, stopped]);
      } finally {
        process.stdout.removeListener("drain", drain);
      }
    }
  }
  if (parentPipe) {
    process.stdin.on("end", end);
    process.stdin.on("data", () => {});
    process.stdin.resume();
    if (process.stdin.readableEnded) end();
    await write({ version: 1, event: "ready" });
  }
  try {
    while (!done) {
      const messages = consumer.poll();
      if (messages.length) await write({ version: 1, messages });
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        stopped,
        new Promise<void>((r) => {
          timer = setTimeout(r, 1000);
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
  } finally {
    consumer.close();
    process.removeListener("SIGINT", end);
    process.removeListener("SIGTERM", end);
    if (parentPipe) {
      process.stdin.removeListener("end", end);
      process.stdin.removeAllListeners("data");
      process.stdin.pause();
    }
  }
}
async function execute(command: string, args: Args): Promise<unknown> {
  if (["setup", "doctor", "uninstall"].includes(command))
    return management(
      command,
      args.positionals[0],
      args.flags["--home"] as string | undefined,
    );
  if (command === "post" || command === "reply") {
    const fields = request(command, args);
    const store = new Store(args.flags["--home"] as string | undefined);
    try {
      return store.post(fields);
    } finally {
      store.close();
    }
  }
  if (command === "codex")
    for (const flag of [
      "--socket",
      "--codex-home",
      "--server-version",
      "--thread",
    ])
      if (!args.flags[flag]) usage(`${flag} is required`, command);
  const after = ["pending", "read-thread"].includes(command)
    ? sequence(args.flags["--after"])
    : 0;
  const limit =
    args.flags["--limit"] === undefined ? 20 : Number(args.flags["--limit"]);
  if (["pending", "read-thread"].includes(command))
    integer(limit, 1, 100, "limit");
  const store = new Store(args.flags["--home"] as string | undefined);
  try {
    switch (command) {
      case "pending":
      case "read-thread":
        return store.page({
          thread_id: args.positionals[0],
          pending: command === "pending",
          after,
          limit,
        });
      case "ack":
        return store.ack(args.positionals[0]);
      case "ack-status":
        return store.ackStatus(args.positionals);
      case "delivery-state":
        return {
          id: args.positionals[0],
          block: store.deliveryBlock(args.positionals[0]),
          submission: store.submission(args.positionals[0]),
        };
      case "retry":
        return store.retry(args.positionals[0]);
      case "capture":
        return capture(store, args.flags["--boundary"] as string | undefined);
      case "consume":
        await consume(store, !!args.flags["--parent-pipe"]);
        return;
      case "codex": {
        const { run } = await import("./adapters/codex.js");
        return await run(store, {
          socket: String(args.flags["--socket"]),
          codexHome: String(args.flags["--codex-home"]),
          serverVersion: String(args.flags["--server-version"]),
          thread: String(args.flags["--thread"]),
        });
      }
      case "home": {
        const page = store.page({ pending: true, limit: 5 });
        const view = display(page, args, "pending") as Record<string, unknown>;
        return {
          bin: resolve(process.argv[1]).replace(homedir(), "~"),
          description: DESCRIPTION,
          home: store.root,
          counts: store.status(),
          consumer_active: active(store),
          ...(args.flags["--json"]
            ? {
                messages: page.messages,
                total: page.total,
                next_cursor: page.next_cursor,
              }
            : view),
          previous_session: previousContext(store) ?? null,
          help: [
            ...((view.help as string[] | undefined) ?? []),
            GUIDANCE[4].replaceAll("inbox-axi", commandPrefix(args)),
          ],
        };
      }
      default:
        return { ...store.status(), consumer_active: active(store) };
    }
  } finally {
    store.close();
  }
}
function formatted(
  error: unknown,
  json: boolean,
  command: string,
): { output: string; exitCode: number } {
  const known = error instanceof InboxError;
  const message = known ? error.message : "unable to complete inbox operation";
  const code = known ? error.code : "OPERATIONAL_ERROR";
  const value = {
    error: message,
    code,
    help:
      known && error.suggestions.length
        ? error.suggestions
        : [commandHelp(command) ?? TOP_HELP],
  };
  return {
    output: (json ? canonical(value) : encode(value)) + "\n",
    exitCode: code === "VALIDATION_ERROR" ? 2 : 1,
  };
}
export async function main(
  argv = process.argv.slice(2),
): Promise<{ discardBufferedOutput: true } | void> {
  const normalized = normalize(argv);
  const command = normalized[0] ?? "home";
  const json = normalized.includes("--json");
  if (
    ["consume", "codex"].includes(command) &&
    !normalized.includes("--help")
  ) {
    try {
      const discarded = await execute(
        command,
        parse(command, normalized.slice(1)),
      );
      if (command === "codex" && discarded === true)
        return { discardBufferedOutput: true };
    } catch (error) {
      const result = formatted(error, json, command);
      process.stdout.write(result.output);
      process.exitCode = result.exitCode;
    }
    return;
  }
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    packageName: "inbox-axi",
    argv: normalized,
    topLevelHelp: TOP_HELP,
    getCommandHelp: commandHelp,
    formatError: (error) => formatted(error, json, command),
    renderUnknownCommand: (unknown) =>
      formatted(
        new InboxError(`unknown command ${unknown}`, "VALIDATION_ERROR", [
          TOP_HELP,
        ]),
        json,
        unknown,
      ).output,
    home: async () =>
      (await execute("home", parse("home", []))) as Record<string, unknown>,
    commands: Object.assign(
      Object.create(null),
      Object.fromEntries(
        Object.keys(COMMAND_FLAGS).map((name) => [
          name,
          async (args: string[]) => {
            const parsed = parse(name, args);
            return display(await execute(name, parsed), parsed, name);
          },
        ]),
      ),
    ),
  });
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await main();
  // canceled output must not delay standalone exit after durable cleanup.
  if (result?.discardBufferedOutput) process.exit(process.exitCode ?? 0);
}
