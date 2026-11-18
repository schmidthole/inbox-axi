import {
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { expandHome } from "./paths.js";
import {
  installSessionStartHooks,
  sessionStartHookStatus,
  uninstallSessionStartHooks,
} from "axi-sdk-js";
import { canonical, parseJson } from "./codec.js";
import { InboxError } from "./errors.js";
import { privateFile, Store } from "./store.js";
export function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
export function capture(
  store: Store,
  boundary = "manual",
): Record<string, unknown> {
  if (!["manual", "session-end", "session-idle"].includes(boundary))
    throw new InboxError("unknown capture boundary", "VALIDATION_ERROR", [
      "inbox-axi capture --boundary manual",
    ]);
  const value = {
    version: 1,
    workspace: process.cwd(),
    captured_at: new Date().toISOString(),
    boundary,
    counts: store.status(),
  };
  const path = join(store.root, "session-context.json");
  privateFile(path);
  writeFileSync(path, canonical(value), { mode: 0o600 });
  return { captured: true, path, transcript_captured: false };
}
export function previousContext(store: Store): unknown {
  const path = join(store.root, "session-context.json");
  if (!existsSync(path)) return null;
  try {
    privateFile(path, false);
    return parseJson(readFileSync(path, "utf8"));
  } catch {
    return { available: false };
  }
}
const MARKER = "inbox-axi";
function wrapperPath(): string {
  return join(process.cwd(), ".inbox-axi-hooks", "inbox-axi");
}
function writeManaged(path: string, text: string, marker: string): void {
  if (existsSync(path) && !readFileSync(path, "utf8").includes(marker))
    throw new InboxError(
      "refusing to overwrite an unmanaged integration file",
      "HOOK_ERROR",
      ["move the unrelated integration file before inbox-axi setup hooks"],
    );
  if (!existsSync(path) || readFileSync(path, "utf8") !== text)
    writeFileSync(path, text);
}
function options() {
  return {
    marker: MARKER,
    execPath: wrapperPath(),
    binaryNames: [MARKER],
    scope: "project" as const,
    projectDir: process.cwd(),
  };
}
function jsonHooks(remove: boolean): void {
  for (const parts of [
    [".claude", "settings.json"],
    [".codex", "hooks.json"],
  ]) {
    const path = join(process.cwd(), ...parts);
    if (!existsSync(path)) continue;
    const value = JSON.parse(readFileSync(path, "utf8"));
    const hooks = (value.hooks ??= {});
    if (!remove)
      for (const group of hooks.SessionStart ?? [])
        for (const hook of group.hooks ?? [])
          if (typeof hook.command === "string" && hook.command.includes(MARKER))
            hook.command = shellQuote(wrapperPath());
    const old = Array.isArray(hooks.SessionEnd) ? hooks.SessionEnd : [];
    const groups = old
      .map((group: Record<string, any>) => ({
        ...group,
        hooks: Array.isArray(group.hooks)
          ? group.hooks.filter(
              (hook: Record<string, unknown>) =>
                !(
                  typeof hook.command === "string" &&
                  hook.command.includes(".inbox-axi-hooks") &&
                  hook.command.includes(" capture")
                ),
            )
          : group.hooks,
      }))
      .filter(
        (group: Record<string, any>) =>
          !Array.isArray(group.hooks) || group.hooks.length,
      );
    if (!remove)
      groups.push({
        hooks: [
          {
            type: "command",
            command: `${shellQuote(wrapperPath())} capture --boundary session-end`,
            timeout: 3,
          },
        ],
      });
    if (groups.length) hooks.SessionEnd = groups;
    else delete hooks.SessionEnd;
    const next = JSON.stringify(value, null, 2) + "\n";
    if (next !== readFileSync(path, "utf8")) writeFileSync(path, next);
  }
}
function idlePlugin(remove: boolean): void {
  const path = join(
    process.cwd(),
    ".opencode",
    "plugins",
    "inbox-axi-capture.js",
  );
  const marker = "inbox-axi managed local idle capture";
  if (remove) {
    if (existsSync(path) && readFileSync(path, "utf8").includes(marker))
      rmSync(path);
    return;
  }
  const text = `// ${marker}\nimport { spawn } from 'node:child_process';\nconst command=${JSON.stringify(wrapperPath())};\nfunction capture(cwd){const child=spawn(command,['capture','--boundary','session-idle'],{cwd,stdio:'ignore'});const timer=setTimeout(()=>child.kill('SIGTERM'),2000);child.on('error',()=>clearTimeout(timer));child.on('close',()=>clearTimeout(timer));}\nexport default {\n id:'inbox-axi-capture',\n async setup(ctx){const controller=new AbortController();(async()=>{for await(const event of ctx.event.subscribe({signal:controller.signal})){if(event.type==='session.idle')capture(ctx.location.directory);}})().catch(()=>{});return ()=>controller.abort();},\n async server({directory}){return {event:async({event})=>{if(event.type==='session.idle')capture(directory);}};}\n};\n`;
  writeManaged(path, text, marker);
}
export function manageHooks(
  action: "setup" | "doctor" | "uninstall",
  home?: string,
): Record<string, unknown> {
  const errors: string[] = [];
  const opts = {
    ...options(),
    onError: (message: string) => errors.push(message),
  };
  const selected = home === undefined ? undefined : expandHome(home);
  if (action === "setup") {
    mkdirSync(join(process.cwd(), ".inbox-axi-hooks"), { recursive: true });
    const node = shellQuote(process.execPath);
    const bin = shellQuote(resolve(process.argv[1]));
    const text = `#!/bin/sh\n# inbox-axi managed session launcher\nexec ${node} ${bin} "$@"${selected ? ` --home ${shellQuote(selected)}` : ""}\n`;
    writeManaged(wrapperPath(), text, "inbox-axi managed session launcher");
    chmodSync(wrapperPath(), 0o700);
    installSessionStartHooks(opts);
    jsonHooks(false);
    idlePlugin(false);
  }
  if (action === "uninstall") {
    uninstallSessionStartHooks(opts);
    jsonHooks(true);
    idlePlugin(true);
    if (
      existsSync(wrapperPath()) &&
      readFileSync(wrapperPath(), "utf8").includes(
        "inbox-axi managed session launcher",
      )
    )
      rmSync(wrapperPath());
  }
  if (errors.length)
    throw new InboxError(
      "unable to update managed session hooks",
      "HOOK_ERROR",
      [
        "check project and user configuration permissions; repair with inbox-axi setup hooks",
      ],
    );
  return {
    hooks: sessionStartHookStatus(opts),
    capture: "claude/codex SessionEnd; opencode session.idle snapshot",
    scope: "current project",
    home: selected ?? "current directory or INBOX_AXI_HOME",
    codex_feature:
      "setup enables shared user config.toml hooks feature; uninstall retains it",
  };
}
