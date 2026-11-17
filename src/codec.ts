import { parseTree, type Node, type ParseError } from "jsonc-parser";
import { validation } from "./errors.js";
import type { JsonValue, Sequence } from "./types.js";

function unicode(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const n = value.charCodeAt(i);
    if (n >= 0xd800 && n <= 0xdbff) {
      const low = value.charCodeAt(++i);
      if (!(low >= 0xdc00 && low <= 0xdfff))
        validation("text must be valid utf-8");
    } else if (n >= 0xdc00 && n <= 0xdfff)
      validation("text must be valid utf-8");
  }
}
export function bounded(value: unknown, max: number, name: string): string {
  if (typeof value !== "string") validation(`${name} must be utf-8 text`);
  unicode(value);
  if (Buffer.byteLength(value, "utf8") > max)
    validation(`${name} is too large`);
  return value;
}
export function identifier(value: unknown, prefix: string): string {
  if (
    typeof value !== "string" ||
    !new RegExp(`^${prefix}_[0-9a-f]{32}$`).test(value)
  )
    validation(`invalid ${prefix} identifier`);
  return value;
}
export function integer(
  value: unknown,
  min: Sequence,
  max: Sequence,
  name: string,
): Sequence {
  if (
    (typeof value !== "number" && typeof value !== "bigint") ||
    (typeof value === "number" && !Number.isSafeInteger(value)) ||
    value < min ||
    value > max
  )
    validation(`${name} must be an integer between ${min} and ${max}`);
  return value;
}
export function canonical(value: unknown): string {
  const seen = new Set<object>();
  function encode(v: unknown, depth: number): string {
    if (depth > 1000) validation("json nesting is too deep");
    if (v === null) return "null";
    if (typeof v === "string") {
      unicode(v);
      return JSON.stringify(v);
    }
    if (typeof v === "boolean") return String(v);
    if (typeof v === "bigint") return String(v);
    if (typeof v === "number") {
      if (!Number.isFinite(v)) validation("invalid json value");
      return JSON.stringify(v);
    }
    if (typeof v !== "object" || seen.has(v)) validation("invalid json value");
    if (
      !Array.isArray(v) &&
      Object.getPrototypeOf(v) !== Object.prototype &&
      Object.getPrototypeOf(v) !== null
    )
      validation("invalid json value");
    seen.add(v);
    let result: string;
    if (Array.isArray(v)) {
      if (Object.keys(v).length !== v.length) validation("invalid json array");
      result = "[" + Array.from(v, (x) => encode(x, depth + 1)).join(",") + "]";
    } else
      result =
        "{" +
        Object.keys(v)
          .sort()
          .map((k) => {
            unicode(k);
            return (
              JSON.stringify(k) +
              ":" +
              encode((v as Record<string, unknown>)[k], depth + 1)
            );
          })
          .join(",") +
        "}";
    seen.delete(v);
    return result;
  }
  try {
    return encode(value, 0);
  } catch (error) {
    if (error instanceof RangeError) validation("invalid json value");
    throw error;
  }
}
export function parseJson(text: string): JsonValue {
  if (typeof text !== "string") validation("invalid json text");
  try {
    const errors: ParseError[] = [];
    const tree = parseTree(text, errors, {
      disallowComments: true,
      allowTrailingComma: false,
      allowEmptyContent: false,
    });
    if (!tree || errors.length) validation("invalid json text");
    function convert(node: Node, depth: number): JsonValue {
      if (depth > 1000) validation("json nesting is too deep");
      if (node.type === "object") {
        const out: { [key: string]: JsonValue } = {};
        for (const property of node.children ?? []) {
          const [keyNode, valueNode] = property.children!;
          const key = keyNode.value as string;
          unicode(key);
          if (Object.hasOwn(out, key)) validation("duplicate json object key");
          Object.defineProperty(out, key, {
            value: convert(valueNode, depth + 1),
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
        return out;
      }
      if (node.type === "array")
        return (node.children ?? []).map((child) => convert(child, depth + 1));
      if (node.type === "number") {
        const token = text.slice(node.offset, node.offset + node.length);
        const n = Number(token);
        if (/^-?\d+$/.test(token))
          return Number.isSafeInteger(n) ? n : BigInt(token);
        if (!Number.isFinite(n)) validation("nonfinite json number");
        return n;
      }
      if (node.type === "string") unicode(node.value);
      return node.value as JsonValue;
    }
    return convert(tree, 0);
  } catch {
    return validation(
      "invalid json text; use unique object keys, finite numbers and valid utf-8",
    );
  }
}
