import { ChunkJsonError } from "./errors.js";
import { IncrementalParser } from "./parser.js";

export type ParseJsonArrayOptions = {
  /**
   * Maximum characters the parser will consume before a `document_too_large`
   * error. Bounds work on hostile input. Default `Infinity`.
   */
  readonly maxLength?: number;
};

/**
 * Streams the elements of a top-level JSON array without holding the whole
 * document in memory.
 *
 * This is the shape most HTTP APIs return — `[{...}, {...}, ...]` — where
 * `await response.json()` would buffer the entire body first.
 *
 * ```ts
 * for await (const item of response.body.pipeThrough(parseJsonArray<Item>())) {
 *   ...
 * }
 * ```
 */
function assertArrayRoot(value: unknown): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new ChunkJsonError("chunkjson: the root value is not an array", {
      code: "unexpected_root",
    });
  }
}

export function parseJsonArray<T = unknown>(
  options: ParseJsonArrayOptions = {},
): TransformStream<Uint8Array | string, T> {
  const maxLength = options.maxLength ?? Number.POSITIVE_INFINITY;
  const decoder = new TextDecoder("utf-8");
  let consumed = 0;
  let sawRoot = false;

  let controllerRef: TransformStreamDefaultController<T> | undefined = undefined;
  const parser = new IncrementalParser({
    onValue(value, depth): void {
      if (depth === 1) {
        // `T` is the caller's declaration of the element type, as with JSON.parse.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        controllerRef?.enqueue(value as T);
        return;
      }
      if (depth === 0) {
        sawRoot = true;
        assertArrayRoot(value);
      }
    },
  });

  return new TransformStream<Uint8Array | string, T>({
    transform(chunk, controller) {
      controllerRef = controller;
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      consumed += text.length;
      if (consumed > maxLength) {
        throw new ChunkJsonError(`chunkjson: document exceeds maxLength (${maxLength})`, {
          code: "document_too_large",
          offset: consumed,
        });
      }
      parser.write(text);
    },

    flush(controller) {
      controllerRef = controller;
      parser.write(decoder.decode());
      parser.end();
      if (!sawRoot) {
        throw new ChunkJsonError("chunkjson: stream ended before the root array closed", {
          code: "incomplete_input",
        });
      }
    },
  });
}
