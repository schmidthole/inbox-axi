import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { validation } from "./errors.js";

// Tilde expansion plus absolute resolution. Realpath is opt-in: mailbox paths
// must not follow symlinks, while a Codex server home is compared after resolution.
export function expandHome(
  input: string,
  options: { realpath?: boolean } = {},
): string {
  if (typeof input !== "string" || input.length === 0)
    validation("path must be text");
  const expanded =
    input === "~"
      ? homedir()
      : input.startsWith("~/")
        ? join(homedir(), input.slice(2))
        : input;
  const absolute = resolve(expanded);
  if (!options.realpath) return absolute;
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}
