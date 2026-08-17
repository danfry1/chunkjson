import { IncrementalParser } from "./parser.js";

export type ParsePartialJsonOptions = {
  /**
   * Emit a snapshot only when the value actually changed since the last one.
   * Default `true`. Comparison is by reference identity of the tree, so this
   * suppresses whitespace-only chunks rather than doing a deep comparison.
   */
  readonly skipUnchanged?: boolean;
};

/**
 * Emits the JSON value as it is being received, so a partially transmitted
 * document can be rendered before it finishes.
 *
 * Each chunk produces a snapshot of everything parsed so far: containers that
 * are still open appear with the members received to date, and a string still
 * being received appears truncated. The final snapshot is the complete value.
 *
 * This is what makes a streamed LLM response usable while it is still
 * generating — the structured fields populate progressively instead of
 * appearing all at once at the end.
 *
 * ```ts
 * for await (const partial of llmResponse.pipeThrough(parsePartialJson<Answer>())) {
 *   render(partial); // { title: "The Ec" } → { title: "The Economy", points: [] } → ...
 * }
 * ```
 *
 * Snapshots share structure with the value under construction, so a consumer
 * that needs to retain one must copy it.
 */
export function parsePartialJson<T = unknown>(
  options: ParsePartialJsonOptions = {},
): TransformStream<Uint8Array | string, T> {
  const skipUnchanged = options.skipUnchanged ?? true;
  const decoder = new TextDecoder("utf-8");
  let dirty = false;

  const parser = new IncrementalParser({
    onUpdate(): void {
      dirty = true;
    },
  });

  return new TransformStream<Uint8Array | string, T>({
    transform(chunk, controller) {
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      dirty = false;
      parser.write(text);
      if (dirty || !skipUnchanged) {
        // `T` is the caller's declaration of the stream's contents, exactly as
        // `JSON.parse` is typed; the parser itself cannot know it.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        controller.enqueue(parser.snapshot as T);
      }
    },

    flush(controller) {
      parser.write(decoder.decode());
      parser.end();
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      controller.enqueue(parser.snapshot as T);
    },
  });
}
