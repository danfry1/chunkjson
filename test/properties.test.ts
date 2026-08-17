import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import {
  lines,
  parseJsonArray,
  parseNdjson,
  parsePartialJson,
  stringifyNdjson,
} from "../src/index.js";
import { collect, streamOf } from "./helpers.js";

/**
 * Property-based tests. The guarantee this package makes is that the result is
 * independent of how the input happens to be split into chunks — so these
 * generate both the value and the split, and assert agreement with the
 * non-streaming equivalent. A counterexample is shrunk and reported with a seed.
 */

const jsonValue = fc.letrec<{ value: unknown }>((tie) => ({
  value: fc.oneof(
    { maxDepth: 4 },
    fc.constant(null),
    fc.boolean(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.integer(),
    fc.string({ unit: "grapheme" }),
    fc.array(tie("value"), { maxLength: 4 }),
    fc.dictionary(fc.string({ unit: "grapheme" }), tie("value"), { maxKeys: 4 }),
  ),
})).value;

/** Round-trips a value through JSON so the expectation matches what a parser can produce. */
function viaJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/** Splits `text` at the given sorted cut points, so any chunking is reachable. */
function splitAt(text: string, cuts: readonly number[]): string[] {
  const bounded = [...new Set(cuts.map((c) => Math.abs(c) % Math.max(text.length, 1)))].sort(
    (a, b) => a - b,
  );
  const parts: string[] = [];
  let previous = 0;
  for (const cut of bounded) {
    parts.push(text.slice(previous, cut));
    previous = cut;
  }
  parts.push(text.slice(previous));
  return parts.filter((part) => part !== "");
}

const cutPoints = fc.array(fc.integer({ min: 0, max: 5000 }), { maxLength: 12 });

describe("chunking invariance", () => {
  test.prop([fc.array(jsonValue, { maxLength: 6 }), cutPoints])(
    "parseJsonArray agrees with JSON.parse however the input is split",
    async (values, cuts) => {
      const doc = JSON.stringify(values);
      const out = await collect(streamOf(splitAt(doc, cuts)).pipeThrough(parseJsonArray()));
      expect(out).toStrictEqual(JSON.parse(doc));
    },
  );

  test.prop([jsonValue, cutPoints])(
    "parsePartialJson's final snapshot agrees with JSON.parse however the input is split",
    async (value, cuts) => {
      const doc = JSON.stringify(value);
      const out = await collect(streamOf(splitAt(doc, cuts)).pipeThrough(parsePartialJson()));
      expect(out.at(-1)).toStrictEqual(JSON.parse(doc));
    },
  );

  test.prop([fc.array(jsonValue, { maxLength: 6 }), cutPoints])(
    "parseNdjson recovers the records however the input is split",
    async (values, cuts) => {
      const doc = values.map((value) => JSON.stringify(value)).join("\n");
      const out = await collect(streamOf(splitAt(doc, cuts)).pipeThrough(parseNdjson()));
      expect(out).toStrictEqual(values.map((value) => viaJson(value)));
    },
  );

  test.prop([fc.array(fc.string({ unit: "grapheme" }), { maxLength: 8 }), cutPoints])(
    "lines agrees with String.split however the input is split",
    async (parts, cuts) => {
      const text = parts.map((part) => part.replaceAll(/[\n\r]/gu, "")).join("\n");
      const out = await collect(streamOf(splitAt(text, cuts)).pipeThrough(lines()));
      expect(out).toStrictEqual(text.split("\n").filter((line) => line !== ""));
    },
  );

  test.prop([fc.array(jsonValue, { maxLength: 6 })])(
    "stringifyNdjson round-trips through parseNdjson",
    async (values) => {
      const source = new ReadableStream<unknown>({
        start(controller) {
          for (const value of values) {
            controller.enqueue(value);
          }
          controller.close();
        },
      });
      const out = await collect(source.pipeThrough(stringifyNdjson()).pipeThrough(parseNdjson()));
      expect(out).toStrictEqual(values.map((value) => viaJson(value)));
    },
  );
});

describe("byte-level invariance", () => {
  test.prop([jsonValue, fc.integer({ min: 1, max: 6 })])(
    "parsePartialJson survives UTF-8 sequences split across byte chunks",
    async (value, size) => {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < bytes.length; i += size) {
        chunks.push(bytes.slice(i, i + size));
      }
      const out = await collect(streamOf(chunks).pipeThrough(parsePartialJson()));
      expect(out.at(-1)).toStrictEqual(viaJson(value));
    },
  );
});

describe("partial snapshot invariants", () => {
  test.prop([jsonValue, cutPoints])("every snapshot is itself valid JSON", async (value, cuts) => {
    const doc = JSON.stringify(value);
    const out = await collect(streamOf(splitAt(doc, cuts)).pipeThrough(parsePartialJson()));
    for (const snapshot of out) {
      expect(() => JSON.stringify(snapshot)).not.toThrow();
    }
  });

  test.prop([fc.array(jsonValue, { minLength: 1, maxLength: 6 }), cutPoints])(
    "an array under construction never shrinks",
    async (values, cuts) => {
      const doc = JSON.stringify(values);
      const out = await collect(streamOf(splitAt(doc, cuts)).pipeThrough(parsePartialJson()));
      let previous = 0;
      for (const snapshot of out) {
        if (Array.isArray(snapshot)) {
          expect(snapshot.length).toBeGreaterThanOrEqual(previous);
          previous = snapshot.length;
        }
      }
    },
  );
});
