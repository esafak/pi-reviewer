/**
 * A small TOML reader for the constructs a dependency manifest uses.
 *
 * The reader is deliberately narrow: it reads table headers, array-of-table
 * headers, and key assignments whose value is a string, an inline table, or
 * an array. Anything else is reported rather than guessed at.
 *
 * The reader fails closed. A construct that was never closed, a statement
 * with trailing content, an array whose elements are not separated, and a
 * region the reader does not understand all leave the document
 * `uncertain`, and an uncertain document yields no records at all. A
 * manifest the reader is unsure of must never become a dependency the
 * reviewer did not read.
 */

/** One key assignment and the table it belongs to. */
export interface TomlEntry {
  /**
   * The scope the entry sits in, as its path segments.
   *
   * The segments are kept apart rather than joined into a name: an empty
   * segment and a literal dot are both significant, so `[""]` and `[]` are
   * different scopes, and so are `["a.b"]` and `["a", "b"]`.
   */
  scope: string[];
  /** The key. */
  key: string;
  /** The value's raw text, for a bare value. */
  value: string;
  /** The value is a string, already unescaped. */
  string?: string;
  /** The value is an array, and its items are strings. */
  items?: string[];
  /** The number of array elements that were not strings. */
  otherItems?: number;
  /** The value is an inline table, and these are its entries. */
  inline?: TomlEntry[];
  /** The entry was not read. */
  error?: string;
  /**
   * The entry sits in a scope the reader does not interpret — an array of
   * tables, or a table below one. The entry is kept so the scope stays
   * accounted for, but a consumer must not read it as a declaration.
   */
  unsupported?: boolean;
}

/** The result of reading a document. */
export interface TomlDocument {
  entries: TomlEntry[];
  /** Constructs the reader read but does not interpret. */
  warnings: string[];
  /**
   * Syntax the reader could not read. A syntax error means the reader no
   * longer knows where it is, so nothing the document contains can be
   * trusted — unlike a construct that was read and merely not interpreted,
   * which only costs the coverage of that construct.
   */
  errors: string[];
  /** The reader lost its place, so nothing the document contains can be trusted. */
  uncertain: boolean;
  /**
   * The tables the document declares.
   *
   * A table is declared whether or not it holds an assignment, so a caller
   * that does not read a table can still report that it did not read it.
   */
  tables: string[][];
}

/** A value the reader understood. */
interface TomlValue {
  /** The value is a string. */
  string?: string;
  /** The value is an array of strings. */
  items?: string[];
  /** The number of array elements that were not strings. */
  otherItems?: number;
  /** The value is an inline table. */
  inline?: TomlEntry[];
  /** The value is a bare token. */
  raw?: string;
  /** The value was not read. */
  error?: string;
}

class Reader {
  index = 0;

  constructor(readonly text: string) {}

  get done(): boolean {
    return this.index >= this.text.length;
  }

  peek(offset = 0): string | undefined {
    return this.text[this.index + offset];
  }

  startsWith(value: string): boolean {
    return this.text.startsWith(value, this.index);
  }

  skipWhitespace(): void {
    while (!this.done && (this.peek() === " " || this.peek() === "\t")) this.index += 1;
  }

  /** Skips whitespace, newlines, and comments. */
  skipToContent(): void {
    while (!this.done) {
      const char = this.peek();
      if (char === " " || char === "\t" || char === "\n" || char === "\r") {
        this.index += 1;
        continue;
      }
      if (char === "#") {
        while (!this.done && this.peek() !== "\n") this.index += 1;
        continue;
      }
      return;
    }
  }
}

/** Decodes the escape that follows a backslash. */
function readEscape(reader: Reader): string | undefined {
  const escape = reader.peek();
  reader.index += 1;
  switch (escape) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case "b":
      return "\b";
    case "f":
      return "\f";
    case '"':
      return '"';
    case "\\":
      return "\\";
    case "u":
    case "U": {
      const width = escape === "u" ? 4 : 8;
      const digits = reader.text.slice(reader.index, reader.index + width);
      if (!/^[0-9A-Fa-f]+$/.test(digits)) return undefined;
      const code = Number.parseInt(digits, 16);
      // A Unicode escape must name a scalar value, not a surrogate or a
      // value beyond the range.
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return undefined;
      reader.index += width;
      return String.fromCodePoint(code);
    }
    default:
      return undefined;
  }
}

/** Reads a basic string, resolving its escapes. */
function readBasicString(reader: Reader): string | undefined {
  let value = "";
  reader.index += 1;
  while (!reader.done) {
    const char = reader.peek();
    if (char === "\\") {
      reader.index += 1;
      const escaped = readEscape(reader);
      if (escaped === undefined) return undefined;
      value += escaped;
      continue;
    }
    if (char === '"') {
      reader.index += 1;
      return value;
    }
    if (char === "\n") return undefined;
    value += char;
    reader.index += 1;
  }
  return undefined;
}

/** Reads a literal string, which has no escapes. */
function readLiteralString(reader: Reader): string | undefined {
  let value = "";
  reader.index += 1;
  while (!reader.done) {
    const char = reader.peek();
    if (char === "'") {
      reader.index += 1;
      return value;
    }
    if (char === "\n") return undefined;
    value += char;
    reader.index += 1;
  }
  return undefined;
}

/**
 * Reads a multi-line string.
 *
 * The closing delimiter is the first `"""` that is not escaped, so a
 * `\"\"\"` inside the string is content rather than the end of it. A
 * backslash at the end of a line trims the whitespace up to the next
 * content, and the escapes are decoded as in a basic string.
 */
function readMultilineString(reader: Reader, quote: string): string | undefined {
  let value = "";
  reader.index += 3;
  // A newline immediately after the opening delimiter is not part of the value.
  if (reader.peek() === "\r") reader.index += 1;
  if (reader.peek() === "\n") reader.index += 1;
  while (!reader.done) {
    if (reader.startsWith(quote)) {
      // Up to two extra quotes belong to the content.
      let trailing = 0;
      while (reader.peek(3 + trailing) === '"' && trailing < 2) trailing += 1;
      value += '"'.repeat(trailing);
      reader.index += 3 + trailing;
      return value;
    }
    const char = reader.peek();
    if (quote === '"""' && char === "\\") {
      const next = reader.peek(1);
      if (next === "\n" || next === "\r") {
        // A line-ending backslash trims the whitespace that follows it.
        reader.index += 1;
        while (!reader.done) {
          const skip = reader.peek();
          if (skip === " " || skip === "\t" || skip === "\n" || skip === "\r") {
            reader.index += 1;
            continue;
          }
          break;
        }
        continue;
      }
      reader.index += 1;
      const escaped = readEscape(reader);
      if (escaped === undefined) return undefined;
      value += escaped;
      continue;
    }
    value += char;
    reader.index += 1;
  }
  return undefined;
}

/**
 * Reads an array's items.
 *
 * The elements must be separated by commas, and an empty array is an empty
 * array rather than a missing element. A trailing comma is allowed. After
 * an element the next thing must be the separator or the closing bracket:
 * content that is not consumed is an error, never skipped over.
 */
function readArray(reader: Reader): TomlValue {
  const items: string[] = [];
  let otherItems = 0;
  reader.index += 1;
  let afterValue = false;
  while (!reader.done) {
    reader.skipWhitespace();
    const char = reader.peek();
    if (char === undefined) return { error: "the array is never closed" };
    if (char === "#") {
      while (!reader.done && reader.peek() !== "\n") reader.index += 1;
      continue;
    }
    if (char === "\n" || char === "\r") {
      reader.index += 1;
      continue;
    }
    if (char === "]") {
      reader.index += 1;
      return { items, ...(otherItems > 0 ? { otherItems } : {}) };
    }
    if (char === ",") {
      if (!afterValue) return { error: "an array element is not separated" };
      afterValue = false;
      reader.index += 1;
      continue;
    }
    if (afterValue) return { error: "an array element is not separated" };
    const value = readValue(reader);
    if (value.error) return { error: value.error };
    if (value.string !== undefined) items.push(value.string);
    else otherItems += 1;
    // A value that is not a string is read but not interpreted. It leaves
    // the reader before its separator, so the separator check below still
    // applies to it.
    afterValue = true;
  }
  return { error: "the array is never closed" };
}

/** A key and the path it sits under. */
export interface TomlKey {
  /** The compound path the key sits under, empty for a simple key. */
  path: string[];
  /** The key itself. */
  key: string;
}

/**
 * Reads the dot-separated segments of a key or a table header.
 *
 * The whitespace around a **bare** segment is syntactic and is trimmed. The
 * content of a **quoted** segment is significant: `"version "` names a
 * different segment than `version`, and trimming it would turn one segment
 * into another.
 */
function readSegments(reader: Reader): string[] | undefined {
  const segments: string[] = [];
  while (!reader.done) {
    reader.skipWhitespace();
    const char = reader.peek();
    if (char === undefined) return undefined;
    if (char === '"') {
      const string = readBasicString(reader);
      if (string === undefined) return undefined;
      segments.push(string);
    } else if (char === "'") {
      const string = readLiteralString(reader);
      if (string === undefined) return undefined;
      segments.push(string);
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(reader.text.slice(reader.index));
      if (!bare) return undefined;
      segments.push(bare[0]);
      reader.index += bare[0].length;
    }
    // The whitespace before a separator is syntactic too.
    reader.skipWhitespace();
    if (reader.peek() === ".") {
      reader.index += 1;
      continue;
    }
    break;
  }
  // The whitespace after the last segment is syntactic too, so a header
  // written as `[ dependencies ]` names the same table as `[dependencies]`.
  reader.skipWhitespace();
  return segments.length > 0 ? segments : undefined;
}

/**
 * Reads a key, which may be bare, quoted, or compound.
 *
 * The last segment is the key; the earlier ones are the path it sits
 * under, so `metadata."version"` sets `version` under `metadata` and not
 * `version` in the table itself.
 */
function readKey(reader: Reader): TomlKey | undefined {
  const segments = readSegments(reader);
  if (!segments) return undefined;
  // The whitespace before the equals sign is syntactic.
  reader.skipWhitespace();
  const last = segments[segments.length - 1] as string;
  return { path: segments.slice(0, -1), key: last };
}

/** What an inline table read produced. */
export interface InlineTableRead {
  /** The table's entries. */
  entries: TomlEntry[];
  /** The table could not be read. */
  error?: string;
}

/**
 * Reads an inline table's entries, straight from the token stream.
 *
 * The entries are not reconstructed as text and read again: a string's
 * content must never become syntax.
 */
function readInlineTableEntries(reader: Reader): InlineTableRead {
  const entries: TomlEntry[] = [];
  reader.index += 1;
  // A key is expected at the start and after a separator. A comma where a
  // key is expected — a leading or a repeated comma — is an error, and so is
  // an entry that is not separated from the one before it.
  let expectKey = true;
  const seen = new Set<string>();
  while (!reader.done) {
    reader.skipWhitespace();
    const char = reader.peek();
    if (char === undefined) return { entries, error: "an inline table is never closed" };
    if (char === "}") {
      reader.index += 1;
      return { entries };
    }
    if (char === ",") {
      if (expectKey) return { entries, error: "an inline table entry is not separated" };
      expectKey = true;
      reader.index += 1;
      continue;
    }
    if (!expectKey) return { entries, error: "an inline table entry is not separated" };
    const read = readKey(reader);
    if (read === undefined) return { entries, error: "an inline table is never closed" };
    const identity = JSON.stringify([...read.path, read.key]);
    if (seen.has(identity)) return { entries, error: "an inline table repeats a key" };
    seen.add(identity);
    if (reader.peek() !== "=") return { entries, error: "an inline table entry has no value" };
    reader.index += 1;
    reader.skipWhitespace();
    const value = readValue(reader);
    // A compound key sits under its own path, so it never becomes a field
    // of the table that holds it.
    const entry: TomlEntry = { scope: read.path, key: read.key, value: value.raw ?? "" };
    if (value.error) entry.error = value.error;
    if (value.string !== undefined) entry.string = value.string;
    if (value.items !== undefined) entry.items = value.items;
    if (value.otherItems !== undefined) entry.otherItems = value.otherItems;
    if (value.inline !== undefined) entry.inline = value.inline;
    entries.push(entry);
    reader.skipWhitespace();
    const next = reader.peek();
    if (next === ",") {
      expectKey = true;
      reader.index += 1;
      continue;
    }
    if (next === "}") {
      reader.index += 1;
      return { entries };
    }
    return { entries, error: "an inline table entry is not separated" };
  }
  return { entries, error: "an inline table is never closed" };
}

/** Reads a value at the reader's position. */
function readValue(reader: Reader): TomlValue {
  const char = reader.peek();
  if (char === '"') {
    if (reader.startsWith('"""')) {
      const value = readMultilineString(reader, '"""');
      return value === undefined
        ? { error: "a multi-line string is never closed" }
        : { string: value };
    }
    const value = readBasicString(reader);
    return value === undefined ? { error: "a string is never closed" } : { string: value };
  }
  if (char === "'") {
    if (reader.startsWith("'''")) {
      const value = readMultilineString(reader, "'''");
      return value === undefined
        ? { error: "a multi-line string is never closed" }
        : { string: value };
    }
    const value = readLiteralString(reader);
    return value === undefined ? { error: "a string is never closed" } : { string: value };
  }
  if (char === "[") return readArray(reader);
  if (char === "{") {
    const table = readInlineTableEntries(reader);
    if (table.error) return { error: table.error };
    // An entry the reader could not read makes the whole table uncertain.
    const failed = table.entries.find((entry) => entry.error !== undefined);
    if (failed) return { error: failed.error };
    return { inline: table.entries, raw: "an inline table" };
  }
  // A bare value is a single token: it ends at whitespace or a separator.
  // A token that carries a quote or a bracket is not a bare value, and
  // accepting it would hide whatever it contains.
  let raw = "";
  while (!reader.done) {
    const inner = reader.peek();
    if (
      inner === " " ||
      inner === "\t" ||
      inner === "\n" ||
      inner === "\r" ||
      inner === "#" ||
      inner === "," ||
      inner === "}" ||
      inner === "]" ||
      inner === "="
    )
      break;
    if (inner === '"' || inner === "'" || inner === "[" || inner === "{")
      return { error: "a value is not a supported value" };
    raw += inner;
    reader.index += 1;
  }
  if (!raw) return { error: "a value is missing" };
  return { raw };
}

/**
 * The scope a table header names.
 *
 * A header is absolute, but a prefix that names an array of tables points
 * at that array's most recent element, so `[dependencies.foo]` after
 * `[[dependencies]]` is a table inside the last element of the array.
 */
/**
 * The scope a target names, and whether it passes through an array.
 *
 * The target is the absolute path of the scope, and a prefix that names an
 * array of tables points at that array's most recent element. The
 * identities are the segment lists themselves, never a joined name, so
 * `["a.b"]` and `["a", "b"]` stay apart.
 */
/** The scope a target names, and whether it passes through an array. */
export interface ResolvedScope {
  /** The scope the target names. */
  scope: string[];
  /** The target passes through an array the reader does not interpret. */
  unsupported: boolean;
}

function resolveScope(
  target: string[],
  base: string[],
  arrays: ReadonlyMap<string, string[]>,
): ResolvedScope {
  const absolute = [...base, ...target];
  let scope: string[] = [];
  let unsupported = false;
  for (let index = 0; index < absolute.length; index += 1) {
    const prefix = JSON.stringify(absolute.slice(0, index + 1));
    const instance = arrays.get(prefix);
    if (instance) {
      scope = [...instance];
      unsupported = true;
      continue;
    }
    scope = [...scope, absolute[index] as string];
  }
  return { scope, unsupported };
}

/**
 * Reads a document's table headers and key assignments.
 *
 * A construct the reader does not interpret becomes an entry with an
 * `error`, and the document is marked uncertain, so the caller can report
 * the coverage gap rather than act on a value it did not read.
 */
export function readTomlDocument(text: string): TomlDocument {
  const reader = new Reader(text);
  const entries: TomlEntry[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  // The tables the document declares, whether or not they hold an
  // assignment, so a caller that does not read a table can still report it.
  const tables: string[][] = [];
  let scope: string[] = [];
  // A region the reader does not interpret is skipped whole, so its
  // assignments are never read as the table that follows it.
  let skipping = false;
  // The assignments the document has already declared. A repeated
  // assignment to the same scope and key is a syntax error, not a value
  // to choose between.
  const declared = new Set<string>();
  // The last instance of each array of tables, so a table below an array
  // belongs to that array's most recent element, and two instances of the
  // same array are separate scopes.
  const arrayInstances = new Map<string, string[]>();
  let instanceCount = 0;
  // The scope the reader is currently in is not interpreted, because it
  // is an array of tables or a table below one.
  let currentUnsupported = false;
  while (!reader.done) {
    reader.skipToContent();
    if (reader.done) break;
    if (reader.peek() === "[") {
      const isArray = reader.startsWith("[[");
      reader.index += isArray ? 2 : 1;
      const segments = readSegments(reader);
      if (!segments) {
        errors.push("a table header is never closed");
        break;
      }
      if (reader.peek() !== "]") {
        errors.push("a table header is never closed");
        break;
      }
      reader.index += 1;
      if (isArray) {
        if (!reader.startsWith("]")) {
          errors.push("an array-of-tables header is never closed");
          break;
        }
        reader.index += 1;
        warnings.push(`the array of tables [${segments.join(".")}] is not read`);
        // Each instance of an array is its own scope, so two instances do
        // not look like a repeated declaration.
        const instance = [...segments, `~${instanceCount++}`];
        arrayInstances.set(JSON.stringify(segments), instance);
        scope = instance;
        currentUnsupported = true;
        skipping = true;
        continue;
      }
      const resolved = resolveScope(segments, [], arrayInstances);
      scope = resolved.scope;
      currentUnsupported = resolved.unsupported;
      skipping = false;
      tables.push([...scope]);
      // A table header is a whole statement, so nothing may follow it on
      // the line.
      reader.skipWhitespace();
      const after = reader.peek();
      if (after !== undefined && after !== "\n" && after !== "\r" && after !== "#") {
        errors.push(`the table header [${scope.join(".")}] has trailing content`);
        while (!reader.done && reader.peek() !== "\n") reader.index += 1;
        continue;
      }
      continue;
    }
    const read = readKey(reader);
    if (read === undefined) {
      errors.push("a key is never closed");
      break;
    }
    if (reader.peek() !== "=") {
      // A statement with no value is a syntax error, not a construct the
      // reader chose not to interpret.
      errors.push(`the entry ${read.key} has no value`);
      while (!reader.done && reader.peek() !== "\n") reader.index += 1;
      continue;
    }
    const key = read.key;
    // A compound key extends the table it sits in, so it never becomes a
    // field of the table that holds it.
    const resolved = resolveScope(read.path, scope, arrayInstances);
    const entryScope = resolved.scope;
    // The marking belongs to this entry: an assignment that names an array
    // is under that array, and it does not make the next assignment so.
    const entryUnsupported = currentUnsupported || resolved.unsupported;
    const identity = JSON.stringify([entryScope, read.key]);
    if (declared.has(identity)) {
      errors.push(`the entry ${read.key} is declared twice`);
      while (!reader.done && reader.peek() !== "\n") reader.index += 1;
      continue;
    }
    declared.add(identity);
    reader.index += 1;
    reader.skipWhitespace();
    const value = readValue(reader);
    const entry: TomlEntry = { scope: entryScope, key, value: value.raw ?? "" };
    if (entryUnsupported) entry.unsupported = true;
    if (value.error) entry.error = value.error;
    if (value.string !== undefined) entry.string = value.string;
    if (value.items !== undefined) entry.items = value.items;
    if (value.otherItems !== undefined) entry.otherItems = value.otherItems;
    if (value.inline !== undefined) entry.inline = value.inline;
    // A read error is recorded even when the entry is not retained: a
    // skipped region's syntax error still means the reader lost its place.
    if (entry.error) errors.push(`${entry.key}: ${entry.error}`);
    if (!skipping) entries.push(entry);
    // A statement ends at the end of its line, a comment, or the end of the
    // document. Anything else is content the reader did not understand.
    reader.skipWhitespace();
    const next = reader.peek();
    if (next === ",") {
      errors.push(`the entry ${entry.key} is not a statement`);
      while (!reader.done && reader.peek() !== "\n") reader.index += 1;
      continue;
    }
    if (next !== undefined && next !== "\n" && next !== "\r" && next !== "#") {
      errors.push(`the entry ${entry.key} has trailing content`);
      while (!reader.done && reader.peek() !== "\n") reader.index += 1;
      continue;
    }
    while (!reader.done && reader.peek() !== "\n") reader.index += 1;
  }
  return { entries, warnings, errors, uncertain: errors.length > 0, tables };
}
