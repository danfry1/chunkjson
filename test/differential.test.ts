import { describe, expect, it } from "vitest";
import { parseJsonArray, parsePartialJson } from "../src/index.js";
import { chunked, collect, streamOf } from "./helpers.js";

/**
 * Differential test: for a generated corpus of documents, the incremental
 * parser must agree with `JSON.parse` exactly — at every chunk size.
 *
 * The corpus is generated from a fixed seed, so failures reproduce.
 */

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_00_00_00_00;
  };
}

const ALPHABET = ["a", "b", "é", "日", "\u{1F600}", '"', "\\", "\n", "\t", "/", "", " "];

function makeValue(random: () => number, depth: number): unknown {
  const roll = random();
  if (depth > 3 || roll < 0.35) {
    const scalar = random();
    if (scalar < 0.2) {
      return null;
    }
    if (scalar < 0.35) {
      return random() < 0.5;
    }
    if (scalar < 0.7) {
      const n = (random() - 0.5) * 10 ** Math.floor(random() * 12);
      return random() < 0.3 ? Math.round(n) : n;
    }
    const length = Math.floor(random() * 8);
    let text = "";
    for (let i = 0; i < length; i++) {
      text += ALPHABET[Math.floor(random() * ALPHABET.length)] ?? "a";
    }
    return text;
  }
  const size = Math.floor(random() * 4);
  if (roll < 0.7) {
    return Array.from({ length: size }, () => makeValue(random, depth + 1));
  }
  const object: Record<string, unknown> = {};
  for (let i = 0; i < size; i++) {
    object[`k${i}${random() < 0.3 ? String.raw`é\"` : ""}`] = makeValue(random, depth + 1);
  }
  return object;
}

const random = makeRandom(0x5eed_1234);
const CORPUS = Array.from({ length: 120 }, () => makeValue(random, 0));

describe("differential vs JSON.parse", () => {
  it("generates a varied corpus", () => {
    const kindOf = (value: unknown): string => {
      if (Array.isArray(value)) {
        return "array";
      }
      return value === null ? "null" : typeof value;
    };
    const kinds = new Set(CORPUS.map((value) => kindOf(value)));
    expect(kinds.size).toBeGreaterThanOrEqual(4);
    expect(CORPUS.length).toBe(120);
  });

  it("parseJsonArray matches JSON.parse for every document at several chunk sizes", async () => {
    const doc = JSON.stringify(CORPUS);
    const expected: unknown = JSON.parse(doc);
    for (const size of [1, 3, 8, 64, 4096]) {
      const out = await collect(streamOf(chunked(doc, size)).pipeThrough(parseJsonArray()));
      expect(out).toStrictEqual(expected);
    }
  });

  it("parsePartialJson's final snapshot matches JSON.parse for every document", async () => {
    for (const value of CORPUS) {
      const doc = JSON.stringify(value);
      // Wrapped so a scalar root is still exercised through the container paths.
      for (const text of [doc, JSON.stringify({ wrapped: value })]) {
        const out = await collect(streamOf(chunked(text, 1)).pipeThrough(parsePartialJson()));
        expect(out.at(-1)).toStrictEqual(JSON.parse(text));
      }
    }
  });

  it("agrees with JSON.parse on number formatting edge cases", async () => {
    const numbers = [
      0, -0, 1, -1, 1e21, 1e-7, 5e-324, 1.7976931348623157e308, 0.1, 123456789012345680000,
    ];
    const doc = JSON.stringify(numbers);
    const out = await collect(streamOf(chunked(doc, 1)).pipeThrough(parseJsonArray()));
    expect(out).toStrictEqual(JSON.parse(doc));
  });

  it("agrees with JSON.parse on string escape edge cases", async () => {
    const strings = [
      "",
      '"',
      "\\",
      "/",
      "\b\f\n\r\t",
      "\u0000\u001F",
      "",
      "日本語",
      "\u{1F600}\u{1F1EC}\u{1F1E7}",
      "é",
      "a\u200Db",
    ];
    const doc = JSON.stringify(strings);
    const out = await collect(streamOf(chunked(doc, 1)).pipeThrough(parseJsonArray()));
    expect(out).toStrictEqual(JSON.parse(doc));
  });
});
