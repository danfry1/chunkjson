import { ChunkJsonError } from "./errors.js";
import { lines, type LinesOptions } from "./lines.js";

export type ParseNdjsonOptions = LinesOptions & {
  /**
   * What to do with a line that is not valid JSON.
   * `"error"` aborts the stream (default); `"skip"` drops the line.
   */
  readonly onInvalidLine?: "error" | "skip";
};

/**
 * Parses newline-delimited JSON (NDJSON / JSON Lines) into values.
 *
 * Blank lines are ignored, so the trailing newline conventional in `.jsonl`
 * files is harmless. A malformed line reports its 1-based line number.
 *
 * ```ts
 * for await (const record of file.stream().pipeThrough(parseNdjson<Record>())) {
 *   ...
 * }
 * ```
 */
export function parseNdjson<T = unknown>(
  options: ParseNdjsonOptions = {},
): TransformStream<Uint8Array | string, T> {
  const skipInvalid = (options.onInvalidLine ?? "error") === "skip";
  const splitter = lines(options);
  let lineNumber = 0;

  const parser = new TransformStream<string, T>({
    transform(line, controller): void {
      lineNumber++;
      const trimmed = line.trim();
      if (trimmed === "") {
        return;
      }
      let value: unknown = undefined;
      try {
        value = JSON.parse(trimmed);
      } catch (error) {
        if (skipInvalid) {
          return;
        }
        throw new ChunkJsonError(`chunkjson: invalid JSON on line ${lineNumber}`, {
          code: "invalid_json",
          line: lineNumber,
          cause: error,
        });
      }
      // `T` is the caller's declaration of the record type, as with JSON.parse.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      controller.enqueue(value as T);
    },
  });

  return {
    writable: splitter.writable,
    readable: splitter.readable.pipeThrough(parser),
  };
}

export type StringifyNdjsonOptions = {
  /** Line delimiter appended after each record. Default `"\n"`. */
  readonly delimiter?: string;
};

/**
 * Serializes values as newline-delimited JSON.
 *
 * Every record is emitted with a trailing delimiter, so concatenating the
 * output of two of these streams produces a valid document. `undefined` values
 * are skipped rather than written as the literal `undefined`, which is not JSON.
 */
export function stringifyNdjson<T = unknown>(
  options: StringifyNdjsonOptions = {},
): TransformStream<T, string> {
  const delimiter = options.delimiter ?? "\n";
  return new TransformStream<T, string>({
    transform(value, controller) {
      const json = JSON.stringify(value);
      if (json === undefined) {
        return;
      }
      controller.enqueue(json + delimiter);
    },
  });
}
