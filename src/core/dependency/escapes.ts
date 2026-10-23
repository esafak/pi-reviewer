/**
 * Decodes the escapes a string literal may carry.
 *
 * A literal names a package, and a package's name is the text the
 * literal stands for: `"ra\x69ls"` names `rails`, and a reader that
 * keeps the escape names a package that does not exist.
 *
 * The escapes a language writes are the ones the readers know: the
 * control characters, the quote and the backslash, and the hexadecimal,
 * the Unicode, and the octal forms. An escape the reader does not know
 * makes the literal not a literal: the reader reports it rather than
 * guessing at an identity that may not exist.
 *
 * A single-quoted string is a raw string: only the backslash and the
 * quote itself are escapes in it, and every other backslash is a
 * character of the text.
 */
export function decodeEscapes(text: string, mode: "ruby-raw" | "escaped"): string | undefined {
  if (!text.includes("\\")) return text;
  let decoded = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char !== "\\") {
      decoded += char;
      continue;
    }
    const body = text.slice(index + 1);
    if (mode === "ruby-raw") {
      // A raw string keeps every escape but the backslash and the quote.
      if (body.startsWith("\\") || body.startsWith("'")) {
        decoded += body[0]!;
        index += 1;
        continue;
      }
      decoded += char;
      continue;
    }
    const escape = decodeEscape(body);
    if (escape === undefined) return undefined;
    decoded += escape.text;
    // The backslash is at the index, and the escape is written with the
    // characters that follow it.
    index += escape.length;
  }
  return decoded;
}

/** The text an escape stands for, and how long the escape is. */
interface DecodedEscape {
  /** The text the escape stands for. */
  readonly text: string;
  /** The number of characters the escape is written with. */
  readonly length: number;
}

/**
 * The text an escape stands for.
 *
 * The escape is the longest one the reader knows, and it is undefined
 * when the reader does not know it.
 */
function decodeEscape(body: string): DecodedEscape | undefined {
  const hex = /^x([0-9A-Fa-f]{2})/.exec(body);
  if (hex) return { text: String.fromCharCode(Number.parseInt(hex[1]!, 16)), length: 3 };
  const unicode = /^u([0-9A-Fa-f]{4})/.exec(body);
  if (unicode) {
    const code = Number.parseInt(unicode[1]!, 16);
    if (!Number.isSafeInteger(code)) return undefined;
    return { text: String.fromCodePoint(code), length: 5 };
  }
  const octal = /^([0-7]{1,3})/.exec(body);
  if (octal)
    return { text: String.fromCharCode(Number.parseInt(octal[1]!, 8)), length: octal[0]!.length };
  switch (body[0]) {
    case "n":
      return { text: "\n", length: 1 };
    case "t":
      return { text: "\t", length: 1 };
    case "r":
      return { text: "\r", length: 1 };
    case "b":
      return { text: "\b", length: 1 };
    case "f":
      return { text: "\f", length: 1 };
    case "0":
      return { text: "\0", length: 1 };
    case "\\":
      return { text: "\\", length: 1 };
    case '"':
      return { text: '"', length: 1 };
    case "'":
      return { text: "'", length: 1 };
    default:
      break;
  }
  // An escape the reader does not know is not decoded.
  return undefined;
}
