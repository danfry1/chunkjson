import { describe, expect, it } from "vitest";
import { ChunkJsonError, lines } from "../src/index.js";
import { assertChunkJsonError, chunked, chunkedBytes, collect, streamOf } from "./helpers.js";

describe("lines", () => {
  it("splits a single chunk on newlines", async () => {
    const out = await collect(streamOf(["a\nb\nc"]).pipeThrough(lines()));
    expect(out).toStrictEqual(["a", "b", "c"]);
  });

  it("joins a line split across chunk boundaries", async () => {
    const out = await collect(streamOf(["he", "llo\nwor", "ld\n"]).pipeThrough(lines()));
    expect(out).toStrictEqual(["hello", "world"]);
  });

  it("strips CR from CRLF input", async () => {
    const out = await collect(streamOf(["a\r\nb\r\n"]).pipeThrough(lines()));
    expect(out).toStrictEqual(["a", "b"]);
  });

  it("emits a trailing line with no delimiter", async () => {
    const out = await collect(streamOf(["a\nb"]).pipeThrough(lines()));
    expect(out).toStrictEqual(["a", "b"]);
  });

  it("drops the trailing line when emitTrailing is false", async () => {
    const out = await collect(streamOf(["a\nb"]).pipeThrough(lines({ emitTrailing: false })));
    expect(out).toStrictEqual(["a"]);
  });

  it("skips empty lines by default", async () => {
    const out = await collect(streamOf(["a\n\n\nb\n"]).pipeThrough(lines()));
    expect(out).toStrictEqual(["a", "b"]);
  });

  it("emits empty lines when asked", async () => {
    const out = await collect(streamOf(["a\n\nb"]).pipeThrough(lines({ emitEmpty: true })));
    expect(out).toStrictEqual(["a", "", "b"]);
  });

  it("reassembles a multi-byte character split across byte chunks", async () => {
    // "café 日本 😀" split every byte guarantees code points are torn apart.
    const text = "café 日本 \u{1F600}\nsecond";
    const out = await collect(streamOf(chunkedBytes(text, 1)).pipeThrough(lines()));
    expect(out).toStrictEqual(["café 日本 \u{1F600}", "second"]);
  });

  it("strips a byte-order mark from byte input", async () => {
    const bytes = new TextEncoder().encode("\uFEFFhello\n");
    const out = await collect(streamOf([bytes]).pipeThrough(lines()));
    expect(out).toStrictEqual(["hello"]);
  });

  it("produces identical output at every chunk size", async () => {
    const text = "alpha\nbravo\ncharlie\ndelta\n";
    for (const size of [1, 2, 3, 5, 7, 100]) {
      const out = await collect(streamOf(chunked(text, size)).pipeThrough(lines()));
      expect(out).toStrictEqual(["alpha", "bravo", "charlie", "delta"]);
    }
  });

  it("supports a custom multi-character delimiter", async () => {
    const out = await collect(streamOf(["a<->b<->c"]).pipeThrough(lines({ delimiter: "<->" })));
    expect(out).toStrictEqual(["a", "b", "c"]);
  });

  it("keeps CR when the delimiter is not a newline", async () => {
    const out = await collect(streamOf(["a\r;b"]).pipeThrough(lines({ delimiter: ";" })));
    expect(out).toStrictEqual(["a\r", "b"]);
  });

  it("rejects an empty delimiter", () => {
    expect(() => lines({ delimiter: "" })).toThrow(ChunkJsonError);
    expect(() => lines({ delimiter: "" })).toThrow(/delimiter must not be empty/);
  });

  it("aborts when a line exceeds maxLineLength", async () => {
    const stream = streamOf(["x".repeat(50)]).pipeThrough(lines({ maxLineLength: 10 }));
    await expect(collect(stream)).rejects.toThrow(ChunkJsonError);
  });

  it("reports line_too_long with the line number", async () => {
    expect.assertions(2);
    const stream = streamOf(["ok\n", "x".repeat(50)]).pipeThrough(lines({ maxLineLength: 10 }));
    try {
      await collect(stream);
    } catch (error) {
      assertChunkJsonError(error);
      expect(error.code).toBe("line_too_long");
      assertChunkJsonError(error);
      expect(error.line).toBe(2);
    }
  });

  it("passes an empty stream through", async () => {
    expect(await collect(streamOf([]).pipeThrough(lines()))).toStrictEqual([]);
  });
});
