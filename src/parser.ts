import { ChunkJsonError } from "./errors.js";

/**
 * An incremental JSON parser. Feed it text a chunk at a time; it keeps whatever
 * state is needed across chunk boundaries — including partial strings, escape
 * sequences, and numbers — and reports completed values through callbacks.
 *
 * This is the engine behind `parseJsonArray` and `parsePartialJson`; it is not
 * part of the public API.
 */

type Frame =
  | { kind: "array"; value: unknown[] }
  | { kind: "object"; value: Record<string, unknown>; key: string | undefined };

/** Where the tokenizer is within the text. */
type Mode = "value" | "string" | "escape" | "unicode" | "number" | "literal";

export type ParserEvents = {
  /** A value completed at the given depth. Depth 0 is a root-level value. */
  readonly onValue?: (value: unknown, depth: number) => void;
  /** Any container or scalar was updated; used to drive partial snapshots. */
  readonly onUpdate?: () => void;
};

const LITERALS = { true: true, false: false, null: null } as const;

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}

function isDigitish(char: string): boolean {
  return (
    (char >= "0" && char <= "9") ||
    char === "-" ||
    char === "+" ||
    char === "." ||
    char === "e" ||
    char === "E"
  );
}

export class IncrementalParser {
  readonly #events: ParserEvents;
  readonly #stack: Frame[] = [];

  #mode: Mode = "value";
  #buffer = "";
  /**
   * Slot reserved for a string that is still arriving, so partial snapshots can
   * show it as it grows. Object keys never reserve a slot — a half-received key
   * is not yet a key.
   */
  #slot:
    | { readonly array: unknown[]; readonly index: number }
    | { readonly object: Record<string, unknown>; readonly key: string }
    | undefined;
  #escapeDigits = "";
  #offset = 0;
  /** The most recent completed root value, kept so callers can read the result. */
  #root: unknown = undefined;
  #rootComplete = false;
  /** True once a root value has completed and only whitespace may follow. */
  #expectingKey = false;

  public constructor(events: ParserEvents = {}) {
    this.#events = events;
  }

  /** The value built so far, with any open containers included as-is. */
  public get snapshot(): unknown {
    const [bottom] = this.#stack;
    if (bottom !== undefined) {
      return bottom.value;
    }
    return this.#root;
  }

  public get depth(): number {
    return this.#stack.length;
  }

  public get isComplete(): boolean {
    return this.#rootComplete && this.#stack.length === 0;
  }

  /** Characters consumed so far, for error reporting. */
  public get offset(): number {
    return this.#offset;
  }

  public write(text: string): void {
    for (const char of text) {
      this.#step(char);
      this.#offset++;
    }
  }

  /** Signals end of input, flushing a trailing number or literal. */
  public end(): void {
    if (this.#mode === "number" || this.#mode === "literal") {
      this.#finishScalar();
    }
    if (this.#mode === "string" || this.#mode === "escape" || this.#mode === "unicode") {
      throw this.#fail("incomplete_input", "stream ended inside a string");
    }
    if (this.#stack.length > 0) {
      throw this.#fail("incomplete_input", "stream ended inside a container");
    }
  }

  #fail(
    code: "invalid_json" | "incomplete_input" | "trailing_content",
    detail: string,
  ): ChunkJsonError {
    return new ChunkJsonError(`chunkjson: ${detail} at offset ${this.#offset}`, {
      code,
      offset: this.#offset,
    });
  }

  #step(char: string): void {
    switch (this.#mode) {
      case "string": {
        this.#stepString(char);
        return;
      }
      case "escape": {
        this.#stepEscape(char);
        return;
      }
      case "unicode": {
        this.#stepUnicode(char);
        return;
      }
      case "number":
      case "literal": {
        this.#stepScalar(char);
        return;
      }
      case "value": {
        this.#stepValue(char);
      }
    }
  }

  #stepString(char: string): void {
    if (char === "\\") {
      this.#mode = "escape";
      return;
    }
    if (char === '"') {
      this.#mode = "value";
      const text = this.#buffer;
      this.#buffer = "";
      this.#commitString(text);
      return;
    }
    this.#buffer += char;
    this.#writeSlot();
  }

  /** Reflects the in-flight string into its reserved slot for partial snapshots. */
  #writeSlot(): void {
    const slot = this.#slot;
    if (slot === undefined) {
      return;
    }
    if ("array" in slot) {
      slot.array[slot.index] = this.#buffer;
    } else {
      slot.object[slot.key] = this.#buffer;
    }
    this.#events.onUpdate?.();
  }

  #stepEscapeDone(): void {
    this.#mode = "string";
    this.#writeSlot();
  }

  #stepEscape(char: string): void {
    if (char === "u") {
      this.#mode = "unicode";
      this.#escapeDigits = "";
      return;
    }
    const simple: Record<string, string> = {
      '"': '"',
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
    };
    const replacement = simple[char];
    if (replacement === undefined) {
      throw this.#fail("invalid_json", `invalid escape \\${char}`);
    }
    this.#buffer += replacement;
    this.#stepEscapeDone();
  }

  #stepUnicode(char: string): void {
    if (!/[0-9a-fA-F]/.test(char)) {
      throw this.#fail("invalid_json", `invalid unicode escape digit ${char}`);
    }
    this.#escapeDigits += char;
    if (this.#escapeDigits.length === 4) {
      this.#buffer += String.fromCharCode(Number.parseInt(this.#escapeDigits, 16));
      this.#escapeDigits = "";
      this.#stepEscapeDone();
    }
  }

  #stepScalar(char: string): void {
    const continues = this.#mode === "number" ? isDigitish(char) : /[a-z]/.test(char);
    if (continues) {
      this.#buffer += char;
      return;
    }
    this.#finishScalar();
    this.#stepValue(char);
  }

  #finishScalar(): void {
    const text = this.#buffer;
    this.#buffer = "";
    this.#mode = "value";
    if (text === "") {
      return;
    }
    if (text === "true" || text === "false" || text === "null") {
      this.#commit(LITERALS[text]);
      return;
    }
    const numeric = Number(text);
    if (!Number.isFinite(numeric) || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)) {
      throw this.#fail("invalid_json", `invalid token "${text}"`);
    }
    this.#commit(numeric);
  }

  #stepValue(char: string): void {
    if (isWhitespace(char)) {
      return;
    }
    switch (char) {
      case "{": {
        this.#openObject();
        return;
      }
      case "[": {
        this.#openArray();
        return;
      }
      case "}":
      case "]": {
        this.#closeContainer(char);
        return;
      }
      case '"': {
        this.#mode = "string";
        this.#buffer = "";
        this.#reserveSlot();
        return;
      }
      case ":": {
        this.#expectingKey = false;
        return;
      }
      case ",": {
        const top = this.#stack.at(-1);
        this.#expectingKey = top?.kind === "object";
        return;
      }
      default: {
        if (isDigitish(char)) {
          this.#mode = "number";
          this.#buffer = char;
          return;
        }
        if (/[a-z]/.test(char)) {
          this.#mode = "literal";
          this.#buffer = char;
          return;
        }
        throw this.#fail("invalid_json", `unexpected character ${JSON.stringify(char)}`);
      }
    }
  }

  /** Reserves the position a value-string will occupy, so it can grow in place. */
  #reserveSlot(): void {
    const top = this.#stack.at(-1);
    if (top === undefined) {
      this.#slot = undefined;
      return;
    }
    if (top.kind === "array") {
      const index = top.value.length;
      top.value.push("");
      this.#slot = { array: top.value, index };
      return;
    }
    if (this.#expectingKey) {
      this.#slot = undefined;
      return;
    }
    if (top.key !== undefined) {
      top.value[top.key] = "";
      this.#slot = { object: top.value, key: top.key };
    }
  }

  #openObject(): void {
    const value: Record<string, unknown> = {};
    this.#attach(value);
    this.#stack.push({ kind: "object", value, key: undefined });
    this.#expectingKey = true;
    this.#events.onUpdate?.();
  }

  #openArray(): void {
    const value: unknown[] = [];
    this.#attach(value);
    this.#stack.push({ kind: "array", value });
    this.#expectingKey = false;
    this.#events.onUpdate?.();
  }

  #closeContainer(char: string): void {
    const frame = this.#stack.pop();
    if (frame === undefined) {
      throw this.#fail("invalid_json", `unexpected ${char}`);
    }
    const expected = frame.kind === "object" ? "}" : "]";
    if (char !== expected) {
      throw this.#fail("invalid_json", `expected ${expected} but found ${char}`);
    }
    // The container was attached to its parent when it opened, so closing only
    // Has to record completion.
    if (this.#stack.length === 0) {
      this.#rootComplete = true;
    }
    this.#events.onUpdate?.();
    this.#events.onValue?.(frame.value, this.#stack.length);
  }

  /**
   * Places a value in its parent. Containers are attached as soon as they open
   * so that partial snapshots show the tree being built rather than nothing at
   * all until the final brace.
   */
  #attach(value: unknown): void {
    const top = this.#stack.at(-1);
    if (top === undefined) {
      if (this.#rootComplete) {
        throw this.#fail("trailing_content", "unexpected value after the root value");
      }
      this.#root = value;
      return;
    }
    if (top.kind === "array") {
      top.value.push(value);
      return;
    }
    if (top.key === undefined) {
      throw this.#fail("invalid_json", "object value without a key");
    }
    top.value[top.key] = value;
    top.key = undefined;
  }

  #commitString(text: string): void {
    const top = this.#stack.at(-1);
    if (top?.kind === "object" && this.#expectingKey) {
      top.key = text;
      this.#slot = undefined;
      this.#events.onUpdate?.();
      return;
    }
    const slot = this.#slot;
    this.#slot = undefined;
    if (slot !== undefined) {
      // The slot already holds the value; finalise it without appending again.
      if ("array" in slot) {
        slot.array[slot.index] = text;
      } else {
        slot.object[slot.key] = text;
        if (top?.kind === "object") {
          top.key = undefined;
        }
      }
      this.#events.onUpdate?.();
      this.#events.onValue?.(text, this.#stack.length);
      return;
    }
    this.#commit(text);
  }

  /** Attaches a finished value to its parent, or completes the root. */
  /** Attaches a completed scalar and reports it. */
  #commit(value: unknown): void {
    this.#attach(value);
    if (this.#stack.length === 0) {
      this.#rootComplete = true;
    }
    this.#events.onUpdate?.();
    // Measured after attaching: an element of the root array reports depth 1.
    this.#events.onValue?.(value, this.#stack.length);
  }
}
