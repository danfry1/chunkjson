import { isChunkJsonError, type ChunkJsonError } from "../src/index.js";

/** Test helpers for driving Web Streams deterministically. */

export function streamOf(
  chunks: readonly (Uint8Array | string)[],
): ReadableStream<Uint8Array | string> {
  return new ReadableStream<Uint8Array | string>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

export async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of stream) {
    out.push(value);
  }
  return out;
}

/** Splits text into `size`-character chunks, to exercise boundary handling. */
export function chunked(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(text.slice(i, i + size));
  }
  return out;
}

/** Splits UTF-8 bytes into `size`-byte chunks, which can split a code point. */
export function chunkedBytes(text: string, size: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    out.push(bytes.slice(i, i + size));
  }
  return out;
}

/** Narrows a caught value without a cast (see the TypeScript standards, rule 14). */
export function assertChunkJsonError(error: unknown): asserts error is ChunkJsonError {
  if (!isChunkJsonError(error)) {
    throw new Error(`expected a ChunkJsonError, received ${String(error)}`);
  }
}

/** Own enumerable keys of an unknown value, without asserting its type. */
export function keysOf(value: unknown): readonly string[] {
  return typeof value === "object" && value !== null ? Object.keys(value) : [];
}

/** Reads a string property from an unknown value, or undefined if absent. */
export function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const found: unknown = Reflect.get(value, key);
  return typeof found === "string" ? found : undefined;
}
