export type JsonValue =
  | null
  | boolean
  | string
  | number
  | bigint
  | JsonValue[]
  | { [key: string]: JsonValue };
export type Sequence = number | bigint;
export interface Message {
  version: 1;
  id: string;
  thread_id: string;
  seq: Sequence;
  parent_id: string | null;
  direction: "inbound" | "outbound";
  text: string;
  data: JsonValue;
  created_at: number;
}
export interface PostOptions {
  text?: string;
  data?: JsonValue;
  thread_id?: string | null;
  parent_id?: string | null;
  direction?: "inbound" | "outbound";
  metadata?: { [key: string]: JsonValue } | null;
  key?: string | null;
}
export interface PageOptions {
  thread_id?: string | null;
  pending?: boolean;
  after?: Sequence;
  limit?: number;
}
export interface Page {
  version: 1;
  messages: Message[];
  next_cursor: Sequence | null;
  metadata: JsonValue;
  total: number;
}
