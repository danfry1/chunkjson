# chunkjson

[![CI](https://github.com/danfry1/chunkjson/actions/workflows/ci.yml/badge.svg)](https://github.com/danfry1/chunkjson/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/chunkjson)](https://www.npmjs.com/package/chunkjson)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](https://github.com/danfry1/chunkjson/blob/main/package.json)

**Streaming JSON built on Web Streams.** Split lines, parse NDJSON, stream the elements of a huge JSON array, and render a JSON value _while it is still arriving_.

Every streaming-JSON package on npm predates Web Streams: they are Node-only, CommonJS, and unmaintained for years. None of them run in a browser, a Cloudflare Worker, Vercel Edge, or Deno — which is exactly where streaming workloads now live.

```ts
import { parsePartialJson } from "chunkjson";

// A structured LLM response, usable before it finishes generating
for await (const partial of response.body.pipeThrough(parsePartialJson<Answer>())) {
  render(partial);
  // {}
  // { title: "Q3 R" }
  // { title: "Q3 Review", risks: ["supp"] }
  // { title: "Q3 Review", risks: ["supply", "fx"], confidence: 0.82 }
}
```

- **Web Streams native** — every export is a `TransformStream`, so it composes with `.pipeThrough()` and works on any runtime with `fetch`
- **Correct at any chunk boundary** — a multi-byte character, a string escape, or a number split across chunks is reassembled, not corrupted. Verified by a differential test against `JSON.parse` over a generated corpus at chunk sizes down to one byte
- **Constant memory** — nothing buffers the whole document
- **Typed errors** — a single `ChunkJsonError` with a literal `code`, plus the line or offset where it happened
- **Small** — zero dependencies, ~2.5 KB min+gzip, ESM + CJS

## Install

```sh
npm install chunkjson
pnpm add chunkjson
yarn add chunkjson
bun add chunkjson
deno add npm:chunkjson
```

## API

### `parsePartialJson<T>(options?)`

Emits the value as it is being received. Containers appear as soon as they open and fill in progressively; a string still arriving appears truncated. The final snapshot is the complete value.

This is what makes a streamed structured response usable: fields populate as they generate instead of appearing all at once at the end.

```ts
for await (const partial of stream.pipeThrough(parsePartialJson<Draft>())) {
  setState(partial);
}
```

Snapshots share structure with the value under construction, so copy one (`structuredClone`) if you need to retain it.

| option          | default |                                                                        |
| --------------- | ------- | ---------------------------------------------------------------------- |
| `skipUnchanged` | `true`  | Suppress snapshots for chunks that changed nothing, such as whitespace |

### `parseJsonArray<T>(options?)`

Streams the elements of a top-level JSON array without holding the document in memory — the shape most HTTP APIs return, where `await response.json()` would buffer the entire body first.

```ts
for await (const row of response.body.pipeThrough(parseJsonArray<Row>())) {
  await insert(row);
}
```

| option      | default    |                                                                            |
| ----------- | ---------- | -------------------------------------------------------------------------- |
| `maxLength` | `Infinity` | Character budget before `document_too_large`. Bounds work on hostile input |

Throws `unexpected_root` if the root value is not an array, and `incomplete_input` if the stream ends first.

### `parseNdjson<T>(options?)` / `stringifyNdjson<T>(options?)`

Newline-delimited JSON (NDJSON / JSON Lines), the format of LLM batch APIs, training datasets, and log pipelines. Blank lines are ignored, CRLF is handled, and a malformed record reports its 1-based line number.

```ts
for await (const record of file.stream().pipeThrough(parseNdjson<Record>())) {
  ...
}

readable.pipeThrough(stringifyNdjson()).pipeTo(writable);
```

| option                     | default   |                                                    |
| -------------------------- | --------- | -------------------------------------------------- |
| `onInvalidLine`            | `"error"` | `"skip"` drops malformed lines instead of aborting |
| plus all `lines()` options |           |                                                    |

### `lines(options?)`

Splits a byte or text stream into lines. UTF-8 decoding is incremental, so a character split across chunks is reassembled rather than replaced with `�`, and a leading byte-order mark is removed.

```ts
for await (const line of response.body.pipeThrough(lines())) {
  if (line.startsWith("data: ")) handle(line.slice(6));
}
```

| option          | default    |                                                                           |
| --------------- | ---------- | ------------------------------------------------------------------------- |
| `delimiter`     | `"\n"`     | A `\n` delimiter also strips a preceding `\r`, so CRLF works unconfigured |
| `maxLineLength` | `Infinity` | Guards against a delimiter-free stream buffering without bound            |
| `emitTrailing`  | `true`     | Emit the last line when the stream ends without a delimiter               |
| `emitEmpty`     | `false`    | Emit blank lines                                                          |

### Errors

Every failure is a `ChunkJsonError` (exported, with `isChunkJsonError`) carrying a literal `code`:

| `code`               | when                                          |
| -------------------- | --------------------------------------------- |
| `invalid_json`       | a record or document is not valid JSON        |
| `incomplete_input`   | the stream ended inside a string or container |
| `trailing_content`   | a second value followed the root value        |
| `unexpected_root`    | `parseJsonArray` received a non-array root    |
| `line_too_long`      | a line exceeded `maxLineLength`               |
| `document_too_large` | input exceeded `maxLength`                    |
| `invalid_option`     | an option was rejected at construction        |

`line` and `offset` locate the failure where they are known, and `toJSON()` makes the error safe to log structurally.

## Notes

- **Types are declarations, not validation.** `parseNdjson<T>()` asserts the shape the way `JSON.parse` does — it does not check it. Parse with a schema at the boundary if the input is untrusted.
- **`parsePartialJson` never emits invalid intermediate types.** A number still being received is withheld until its last digit, because `1.5` truncated to `1.` is not a number. Strings and containers stream; scalars land whole.
- **Duplicate object keys** follow `JSON.parse`: the last one wins.

## Compared with the Node-stream generation

|                             | chunkjson            | `split2` / `byline` / `ndjson` / `JSONStream` |
| --------------------------- | -------------------- | --------------------------------------------- |
| runtimes                    | any with Web Streams | Node only                                     |
| modules                     | ESM + CJS            | CommonJS                                      |
| dependencies                | 0                    | 2–10                                          |
| partial/incremental parsing | yes                  | no                                            |
| last released               | —                    | 3 to 10 years ago                             |

## Contributing

```sh
bun install
bun run check   # format, lint, types, tests, build
```

## License

MIT
