import { ChunkJsonError } from "./errors.js";

export type LinesOptions = {
  /**
   * Line delimiter. Default `"\n"`, which also strips a preceding `\r` so CRLF
   * input works without configuration.
   */
  readonly delimiter?: string;
  /**
   * Maximum characters in a single line before a `line_too_long` error. Guards
   * against a delimiter-free stream buffering without bound. Default `Infinity`.
   */
  readonly maxLineLength?: number;
  /** Emit the final line when the stream ends without a trailing delimiter. Default `true`. */
  readonly emitTrailing?: boolean;
  /** Emit empty lines. Default `false`, which is what line-delimited formats want. */
  readonly emitEmpty?: boolean;
};

/**
 * Splits a byte or text stream into lines.
 *
 * Decoding is incremental, so a multi-byte UTF-8 sequence split across two
 * chunks is reassembled rather than corrupted, and a leading byte-order mark is
 * removed. The delimiter itself is never emitted.
 *
 * ```ts
 * for await (const line of response.body.pipeThrough(lines())) {
 *   console.log(line);
 * }
 * ```
 */
function checkLength(length: number, line: number, maxLineLength: number): void {
  if (length > maxLineLength) {
    throw new ChunkJsonError(`chunkjson: line ${line} exceeds maxLineLength (${maxLineLength})`, {
      code: "line_too_long",
      line,
    });
  }
}

export function lines(options: LinesOptions = {}): TransformStream<Uint8Array | string, string> {
  const delimiter = options.delimiter ?? "\n";
  if (delimiter === "") {
    throw new ChunkJsonError("chunkjson: delimiter must not be empty", { code: "invalid_option" });
  }
  const maxLineLength = options.maxLineLength ?? Number.POSITIVE_INFINITY;
  const emitTrailing = options.emitTrailing ?? true;
  const emitEmpty = options.emitEmpty ?? false;
  const stripCarriageReturn = delimiter === "\n";

  // `stream: true` keeps partial multi-byte sequences buffered across chunks.
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let lineNumber = 0;

  const emit = (raw: string, controller: TransformStreamDefaultController<string>): void => {
    const line = stripCarriageReturn && raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    lineNumber++;
    checkLength(line.length, lineNumber, maxLineLength);
    if (line !== "" || emitEmpty) {
      controller.enqueue(line);
    }
  };

  return new TransformStream<Uint8Array | string, string>({
    transform(chunk, controller) {
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });

      let index = buffer.indexOf(delimiter);
      while (index !== -1) {
        emit(buffer.slice(0, index), controller);
        buffer = buffer.slice(index + delimiter.length);
        index = buffer.indexOf(delimiter);
      }

      checkLength(buffer.length, lineNumber + 1, maxLineLength);
    },

    flush(controller) {
      buffer += decoder.decode();
      if (buffer !== "" && emitTrailing) {
        emit(buffer, controller);
      }
      buffer = "";
    },
  });
}
