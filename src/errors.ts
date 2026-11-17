export class InboxError extends Error {
  constructor(
    message: string,
    public code = "OPERATIONAL_ERROR",
    public suggestions: string[] = [],
    public metadata?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "InboxError";
  }
}
export class ConsumerBusy extends InboxError {
  constructor() {
    super("an inbox consumer is already active", "CONSUMER_BUSY", [
      "stop the existing consumer before starting another",
    ]);
  }
}
export function validation(message: string): never {
  throw new InboxError(message, "VALIDATION_ERROR");
}
