import { describe, expect, it } from "vitest";
import { ChunkJsonError, parseNdjson, stringifyNdjson } from "../src/index.js";
import { assertChunkJsonError, chunked, chunkedBytes, collect, streamOf } from "./helpers.js";

const RECORDS = [
  { id: 1, name: "alpha" },
  { id: 2, name: 'brá"vo' },
  { id: 3, name: "日本 \u{1F600}" },
];
const DOC = `${RECORDS.map((r) => JSON.stringify(r)).join("\n")}\n`;

describe("parseNdjson", () => {
  it("parses records from a single chunk", async () => {
    expect(await collect(streamOf([DOC]).pipeThrough(parseNdjson()))).toStrictEqual(RECORDS);
  });

  it("produces identical results at every chunk size", async () => {
    for (const size of [1, 2, 5, 17, 1000]) {
      const out = await collect(streamOf(chunked(DOC, size)).pipeThrough(parseNdjson()));
      expect(out).toStrictEqual(RECORDS);
    }
  });

  it("handles byte input split mid-code-point", async () => {
    const out = await collect(streamOf(chunkedBytes(DOC, 1)).pipeThrough(parseNdjson()));
    expect(out).toStrictEqual(RECORDS);
  });

  it("tolerates a missing trailing newline", async () => {
    const out = await collect(streamOf([DOC.trimEnd()]).pipeThrough(parseNdjson()));
    expect(out).toStrictEqual(RECORDS);
  });

  it("ignores blank lines and CRLF endings", async () => {
    const doc = '{"a":1}\r\n\r\n{"a":2}\r\n';
    expect(await collect(streamOf([doc]).pipeThrough(parseNdjson()))).toStrictEqual([
      { a: 1 },
      { a: 2 },
    ]);
  });

  it("ignores a line containing only whitespace", async () => {
    const doc = '{"a":1}\n   \n\t\n{"a":2}\n';
    expect(await collect(streamOf([doc]).pipeThrough(parseNdjson()))).toStrictEqual([
      { a: 1 },
      { a: 2 },
    ]);
  });

  it("tolerates leading and trailing whitespace around a record", async () => {
    const doc = '  {"a":1}  \n\t{"a":2}\t\n';
    expect(await collect(streamOf([doc]).pipeThrough(parseNdjson()))).toStrictEqual([
      { a: 1 },
      { a: 2 },
    ]);
  });

  it("parses scalar records", async () => {
    const doc = '1\n"two"\ntrue\nnull\n[1,2]\n';
    expect(await collect(streamOf([doc]).pipeThrough(parseNdjson()))).toStrictEqual([
      1,
      "two",
      true,
      null,
      [1, 2],
    ]);
  });

  it("reports the line number of a malformed record", async () => {
    expect.assertions(3);
    const doc = '{"a":1}\n{"a":2}\n{oops}\n';
    try {
      await collect(streamOf([doc]).pipeThrough(parseNdjson()));
    } catch (error) {
      expect(error).toBeInstanceOf(ChunkJsonError);
      assertChunkJsonError(error);
      expect(error.code).toBe("invalid_json");
      assertChunkJsonError(error);
      expect(error.line).toBe(3);
    }
  });

  it("skips malformed records when asked", async () => {
    const doc = '{"a":1}\n{oops}\n{"a":2}\n';
    const out = await collect(streamOf([doc]).pipeThrough(parseNdjson({ onInvalidLine: "skip" })));
    expect(out).toStrictEqual([{ a: 1 }, { a: 2 }]);
  });

  it("enforces maxLineLength", async () => {
    const stream = streamOf([`{"a":"${"x".repeat(100)}"}\n`]).pipeThrough(
      parseNdjson({ maxLineLength: 20 }),
    );
    await expect(collect(stream)).rejects.toThrow(ChunkJsonError);
  });

  it("returns nothing for an empty stream", async () => {
    expect(await collect(streamOf([]).pipeThrough(parseNdjson()))).toStrictEqual([]);
  });
});

describe("stringifyNdjson", () => {
  it("writes one JSON document per line", async () => {
    const out = await collect(streamOf([]).pipeThrough(stringifyNdjson()));
    expect(out).toStrictEqual([]);
    const written = await collect(
      new ReadableStream<unknown>({
        start(controller) {
          for (const record of RECORDS) {
            controller.enqueue(record);
          }
          controller.close();
        },
      }).pipeThrough(stringifyNdjson()),
    );
    expect(written.join("")).toBe(DOC);
  });

  it("skips undefined, which has no JSON representation", async () => {
    const written = await collect(
      new ReadableStream<unknown>({
        start(controller) {
          controller.enqueue({ a: 1 });
          controller.enqueue(undefined);
          controller.enqueue(2);
          controller.close();
        },
      }).pipeThrough(stringifyNdjson()),
    );
    expect(written.join("")).toBe('{"a":1}\n2\n');
  });

  it("round-trips through parseNdjson", async () => {
    const source = new ReadableStream<unknown>({
      start(controller) {
        for (const record of RECORDS) {
          controller.enqueue(record);
        }
        controller.close();
      },
    });
    const out = await collect(source.pipeThrough(stringifyNdjson()).pipeThrough(parseNdjson()));
    expect(out).toStrictEqual(RECORDS);
  });
});
