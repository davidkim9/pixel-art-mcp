/** An error whose message is meant for the model calling the tool. */
export class ToolError extends Error {
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "ToolError";
    this.details = details;
  }
}

export function fail(message: string, details?: unknown): never {
  throw new ToolError(message, details);
}

export function check(condition: unknown, message: string, details?: unknown): asserts condition {
  if (!condition) fail(message, details);
}
