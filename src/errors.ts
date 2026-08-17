/** Discriminant for every failure `chunkjson` can raise. */
export type ChunkJsonErrorCode =
  | "invalid_json"
  | "line_too_long"
  | "document_too_large"
  | "unexpected_root"
  | "trailing_content"
  | "incomplete_input"
  | "invalid_option";

type ChunkJsonErrorContext = {
  readonly code: ChunkJsonErrorCode;
  /** 1-based line number, when the failure is attributable to one. */
  readonly line?: number;
  /** 0-based byte or character offset within the stream, when known. */
  readonly offset?: number;
  readonly cause?: unknown;
};

/**
 * The only error type thrown by this package. Branch on `code`; `line` and
 * `offset` locate the failure within the stream when they are known.
 */
export class ChunkJsonError extends Error {
  public readonly code: ChunkJsonErrorCode;
  public readonly line: number | undefined;
  public readonly offset: number | undefined;

  public constructor(message: string, context: ChunkJsonErrorContext) {
    super(message, context.cause === undefined ? undefined : { cause: context.cause });
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
    this.code = context.code;
    this.line = context.line;
    this.offset = context.offset;
  }

  public toJSON(): {
    readonly name: string;
    readonly code: ChunkJsonErrorCode;
    readonly message: string;
    readonly line: number | undefined;
    readonly offset: number | undefined;
  } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      line: this.line,
      offset: this.offset,
    };
  }
}

export function isChunkJsonError(error: unknown): error is ChunkJsonError {
  return error instanceof ChunkJsonError;
}
