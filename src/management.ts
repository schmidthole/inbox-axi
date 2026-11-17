import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { defaultRoot } from "./store.js";
import { canonical } from "./codec.js";
import { InboxError } from "./errors.js";
import { manageHooks, shellQuote } from "./lifecycle.js";
export function management(
  command: string,
  harness: string | undefined,
  home?: string,
): Record<string, unknown> {
  if (harness === "hooks")
    return manageHooks(command as "setup" | "doctor" | "uninstall", home);
  if (command === "uninstall" && !harness)
    return {
      instructions:
        "stop the native adapter and relaunch without its extension/channel flags; npm uninstall -g inbox-axi; run inbox-axi uninstall hooks first if installed; mailbox retained",
    };
  if (!harness || !["pi", "claude", "codex"].includes(harness))
    throw new InboxError(
      "expected pi, claude, codex or hooks",
      "VALIDATION_ERROR",
      [`inbox-axi ${command} hooks`, `inbox-axi ${command} pi`],
    );
  const root = resolve(home ?? defaultRoot());
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const environment = {
    INBOX_AXI_HOME: root,
    INBOX_AXI_NODE: process.execPath,
    INBOX_AXI_CLI: cli,
  };
  if (command === "doctor") {
    const executable = (process.env.PATH ?? "")
      .split(delimiter)
      .map((p) => join(p, harness))
      .find((p) => existsSync(p));
    const probe = executable
      ? spawnSync(executable, ["--version"], {
          encoding: "utf8",
          timeout: 5000,
          maxBuffer: 65536,
        })
      : undefined;
    return {
      harness,
      installed: !!executable,
      executable: executable ?? null,
      version: probe?.status === 0 ? probe.stdout.trim().slice(0, 200) : null,
      configured: "session-scoped; not inferred",
      capability_verified: false,
      limitations:
        "offline availability only; native auth, idle wake, busy steering and admission require manual verification",
    };
  }
  const common = {
    harness,
    writes_config: false,
    environment,
    capability_verified: false,
  };
  if (harness === "pi")
    return {
      ...common,
      launch:
        Object.entries(environment)
          .map(([k, v]) => `${k}=${shellQuote(v)}`)
          .join(" ") +
        ` pi -e ${shellQuote(fileURLToPath(new URL("./adapters/pi.js", import.meta.url)))}`,
      requirements:
        "durable interactive native pi user-message api; explicit incorporation; native live behavior unverified",
    };
  if (harness === "claude") {
    const config = {
      mcpServers: {
        inbox: {
          command: process.execPath,
          args: [
            fileURLToPath(new URL("./adapters/claude.js", import.meta.url)),
          ],
          env: environment,
        },
      },
    };
    return {
      ...common,
      mcp_config: config,
      launch: `claude --mcp-config ${shellQuote(canonical(config))} --dangerously-load-development-channels server:inbox`,
      routing: "active_conversation",
      mechanism: "native_mcp_channel",
      automatic_push_enabled: true,
      channel_registration: "unknown",
      requirements:
        "interactive channel/mcp consent, supported authentication and organization policy; restore thread history and generic task context after clear/resume; native registration unverified",
    };
  }
  return {
    ...common,
    launch_template: `${shellQuote(process.execPath)} ${shellQuote(cli)} codex --home ${shellQuote(root)} --socket <shared-private-socket> --codex-home <exact-server-home> --server-version <exact-version> --thread <native-thread-uuid>`,
    requirements:
      "exact native thread sharing selected private server; no resume or backend fallback; explicit retry after uncertain submission; native behavior unverified",
  };
}
