import { describe, expect, it } from "vitest";
import { ChunkJsonError, parsePartialJson } from "../src/index.js";
import {
  assertChunkJsonError,
  chunked,
  chunkedBytes,
  collect,
  keysOf,
  streamOf,
  readString,
} from "./helpers.js";

/** Snapshots share structure with the value under construction, so copy each one. */
async function snapshots(chunks: readonly string[]): Promise<unknown[]> {
  const captured = await collect(
    streamOf(chunks)
      .pipeThrough(parsePartialJson())
      .pipeThrough(
        new TransformStream<unknown, unknown>({
          transform(value, controller) {
            controller.enqueue(structuredClone(value));
          },
        }),
      ),
  );
  return captured;
}

describe("parsePartialJson", () => {
  it("emits a growing object as it arrives", async () => {
    const out = await snapshots(chunked('{"title":"Econ","done":true}', 1));
    expect(out.at(-1)).toStrictEqual({ title: "Econ", done: true });
    expect(out).toContainEqual({});
    expect(out).toContainEqual({ title: "E" });
    expect(out).toContainEqual({ title: "Ec" });
    expect(out).toContainEqual({ title: "Econ" });
  });

  it("shows a string growing character by character", async () => {
    const out = await snapshots(chunked('{"a":"hello"}', 1));
    const values = out
      .map((snapshot) => readString(snapshot, "a"))
      .filter((value) => value !== undefined);
    // The value appears once the first character arrives and grows from there;
    // The tail repeats as the closing quote and brace are consumed.
    expect(values).toStrictEqual(["h", "he", "hel", "hell", "hello", "hello", "hello", "hello"]);
  });

  it("does not expose a half-received key", async () => {
    const out = await snapshots(chunked('{"title":1}', 1));
    for (const snapshot of out) {
      const keys = keysOf(snapshot);
      expect(keys.every((k) => k === "title")).toBe(true);
    }
  });

  it("grows an array element by element", async () => {
    const out = await snapshots(chunked("[1,2,3]", 1));
    expect(out.at(-1)).toStrictEqual([1, 2, 3]);
    expect(out).toContainEqual([]);
    expect(out).toContainEqual([1]);
    expect(out).toContainEqual([1, 2]);
  });

  it("builds nested structures progressively", async () => {
    const doc = '{"a":{"b":[{"c":"x"}]}}';
    const out = await snapshots(chunked(doc, 1));
    expect(out.at(-1)).toStrictEqual(JSON.parse(doc));
    expect(out).toContainEqual({ a: {} });
    expect(out).toContainEqual({ a: { b: [] } });
    expect(out).toContainEqual({ a: { b: [{}] } });
  });

  it("ends with a value equal to JSON.parse at every chunk size", async () => {
    const doc = JSON.stringify({
      title: "Quarterly report",
      points: ["growth", "risk"],
      meta: { count: 2, ok: true, note: null, ratio: -1.5e-3 },
      unicode: "日本 \u{1F600} café",
    });
    for (const size of [1, 2, 3, 7, 31, 1000]) {
      const out = await snapshots(chunked(doc, size));
      expect(out.at(-1)).toStrictEqual(JSON.parse(doc));
    }
  });

  it("handles byte input split mid-code-point", async () => {
    const doc = JSON.stringify({ text: "日本 \u{1F600}" });
    const out = await collect(streamOf(chunkedBytes(doc, 1)).pipeThrough(parsePartialJson()));
    expect(out.at(-1)).toStrictEqual(JSON.parse(doc));
  });

  it("emits snapshots monotonically — never loses a field", async () => {
    const doc = '{"a":1,"b":"two","c":[3],"d":{"e":4}}';
    const out = await snapshots(chunked(doc, 1));
    let previousKeys = 0;
    for (const snapshot of out) {
      const keys = keysOf(snapshot).length;
      expect(keys).toBeGreaterThanOrEqual(previousKeys);
      previousKeys = keys;
    }
    expect(out.at(-1)).toStrictEqual(JSON.parse(doc));
  });

  it("rejects a truncated document at flush", async () => {
    expect.assertions(1);
    try {
      await collect(streamOf(['{"a":1']).pipeThrough(parsePartialJson()));
    } catch (error) {
      assertChunkJsonError(error);
      expect(error.code).toBe("incomplete_input");
    }
  });

  it("rejects malformed input mid-stream", async () => {
    await expect(collect(streamOf(["{a:1}"]).pipeThrough(parsePartialJson()))).rejects.toThrow(
      ChunkJsonError,
    );
  });

  it("emits one snapshot per chunk when skipUnchanged is false", async () => {
    const chunks = ["{", '"a"', ":", "1", "}", "  ", " "];
    const out = await collect(
      streamOf(chunks).pipeThrough(parsePartialJson({ skipUnchanged: false })),
    );
    expect(out.length).toBe(chunks.length + 1); // One per chunk, plus the flush
  });

  it("suppresses snapshots for whitespace-only chunks by default", async () => {
    const out = await collect(streamOf(['{"a":1}', "  ", "\n"]).pipeThrough(parsePartialJson()));
    expect(out.at(-1)).toStrictEqual({ a: 1 });
    expect(out.length).toBe(2); // The value chunk, then the flush
  });

  it.each([
    { doc: '"hi"', expected: "hi" },
    { doc: "42", expected: 42 },
    { doc: "true", expected: true },
    { doc: "null", expected: null },
  ])("parses the scalar root $doc", async ({ doc, expected }) => {
    const out = await snapshots(chunked(doc, 1));
    expect(out.at(-1)).toStrictEqual(expected);
  });
});
