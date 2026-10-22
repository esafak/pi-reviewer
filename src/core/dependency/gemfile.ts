import { decodeEscapes } from "./escapes.js";

/**
 * The nesting the reader follows.
 *
 * A file nested deeper than this is not one the reader can walk, and it
 * is reported rather than read. The bound also keeps the reader's work
 * linear in the file's length: a stack that grows without a bound is
 * copied and scanned once per statement.
 */
const MAX_NESTING = 32;

/**
 * A gem a Gemfile declares.
 */
export interface GemDeclaration {
  /** The gem's name. */
  readonly name: string;
  /**
   * The version requirements the declaration carries, as written.
   *
   * A declaration may carry more than one requirement — `gem "rails", ">= 7",
   * "< 8"` — and they are kept together, because a constraint with more
   * than one bound names no single version and the comparison must not
   * read one of the bounds as if it were the version.
   */
  readonly requirement?: string;
}

/** What a Gemfile declares, and what the reader could not read. */
export interface GemfileReadResult {
  /** The gems the file declares. */
  readonly gems: readonly GemDeclaration[];
  /** The declarations the reader did not read. */
  readonly warnings: string[];
}

/**
 * A block the reader is inside.
 *
 * A block is opened by a `do` and closed by an `end`, or opened by a brace
 * and closed by a brace, and the two are not the same block.
 */
interface GemBlock {
  /** What closes the block. */
  readonly kind: "end";
  /** The source the gems inside the block come from. */
  readonly source?: string;
}

/**
 * The token an unread value is replaced with.
 *
 * A value the reader does not read is not an empty value: it is a value
 * the reader cannot name, and a declaration that carries one is reported
 * rather than read.
 */
const UNREAD = "unread-value";

/**
 * A region of the file that is a string, and not code.
 *
 * A heredoc's body, a percent string's body, a block comment's body, and
 * a regular expression's body are text, and a text may hold a
 * declaration that means nothing.
 */
type GemRegion = GemHeredoc | GemComment | GemPercent | GemSlashy;

/** The terminator of a heredoc, and the way the heredoc was written. */
interface GemHeredocTerminator {
  /** The line that ends the heredoc. */
  readonly terminator: string;
  /**
   * The heredoc interpolates.
   *
   * A heredoc written with single quotes is a raw one: its text is the
   * text between the terminators, and an interpolation in it is only a
   * character.
   */
  readonly interpolates: boolean;
  /**
   * The terminator may be indented.
   *
   * The `<<-` and `<<~` forms allow it, and the plain form does not.
   */
  readonly indented: boolean;
}

/** A heredoc's body, which ends with a line that holds its terminator. */
interface GemHeredoc extends GemHeredocTerminator {
  readonly kind: "heredoc";
}

/** A block comment's body, which ends with the line that holds its `=end`. */
interface GemComment {
  readonly kind: "comment";
}

/** A percent string's body, which ends with its closing delimiter. */
interface GemPercent {
  readonly kind: "percent";
  /** The delimiter that opens it. */
  readonly open: string;
  /** The delimiter that closes it. */
  readonly close: string;
  /** The delimiter is a pair, so the content may nest it. */
  readonly paired: boolean;
  /** The string interpolates. */
  readonly interpolates: boolean;
  /** The nesting the content holds. */
  depth: number;
}

/** A string's body that ends with a single delimiter. */
interface GemSlashy {
  readonly kind: "slashy";
  /** The delimiter that closes it. */
  readonly close: string;
  /** The nesting the content holds. */
  depth: number;
}

/** A string literal, and the quote that wrote it. */
interface GemLiteral {
  /** The text between the quotes. */
  readonly value: string;
  /** The quote the literal was written with. */
  readonly quote: string;
}

/** A delimiter that is open. */
interface GemDelimiter {
  /** The delimiter itself. */
  readonly kind: "(" | "[" | "{";
  /** The statement continues while the delimiter is open. */
  readonly continues: boolean;
  /** The source the block the delimiter opens names. */
  readonly source?: string;
}

/** A string's extent, when the string ends in a single delimiter. */
interface GemExtent {
  /** The index the string starts at. */
  readonly start: number;
  /** The index just after the closing delimiter, or -1 when it spans lines. */
  readonly end: number;
  /**
   * The reader could not say whether the text is a string or a division.
   *
   * The text is masked either way, because it is not code in the first
   * case and not code in the second, but the reader reports that it did
   * not place it.
   */
  readonly ambiguous?: boolean;
}

/** A line without its comment. */
interface GemStripped {
  /** The line's code. */
  readonly text: string;
  /** The quote the line leaves open, when it leaves one open. */
  readonly quote?: string;
  /** The line holds an interpolation the reader cannot delimit. */
  readonly interpolated?: boolean;
}

/**
 * The keywords that name a source the gems inside do not come from the
 * registry.
 *
 * A gem named with one of them is not published by the registry: it comes
 * from a repository, a branch, or a directory beside the project, so the
 * registry has no release notes for it and the harness must not look.
 */
const SOURCE_KEYWORDS = new Set(["git", "path", "github", "gitlab", "bitbucket"]);

/** The source the public RubyGems registry is published at. */
const PUBLIC_SOURCE = /^https?:\/\/(?:www\.)?rubygems\.org\/?$/;

/**
 * The directives a Gemfile may carry that are not gem declarations.
 *
 * Each names something the reader does not read, and each is reported: a
 * file the harness did not read is a file it cannot claim to have
 * covered.
 */
const UNREAD_DIRECTIVES: ReadonlyMap<string, string> = new Map([
  ["gemspec", "Gemfile names a gemspec, which is not read"],
  ["eval_gemfile", "Gemfile evaluates another file, which is not read"],
  ["ruby", "Gemfile pins a Ruby version, which is not read"],
]);

/** The Ruby keywords that open a block an `end` closes. */
const BLOCK_KEYWORD = /^(if|unless|case|begin|while|until|for|def|class|module)\b/;

/** A line that opens a block with a `do`. */
const OPENS_BLOCK = /\bdo\b\s*(\|[^|]*\|)?$/;

/** A line that declares a gem. */
const GEM_STATEMENT = /^gem(?![A-Za-z0-9_])/;

/** The delimiters a percent string may pair. */
interface PercentPairs {
  readonly "{": "}";
  readonly "(": ")";
  readonly "[": "]";
  readonly "<": ">";
}

const PERCENT_PAIRS: PercentPairs = {
  "{": "}",
  "(": ")",
  "[": "]",
  "<": ">",
};

/** The words a regular expression may follow. */
const REGEXP_KEYWORDS = new Set([
  "return",
  "when",
  "if",
  "unless",
  "while",
  "until",
  "and",
  "or",
  "not",
  "then",
  "else",
  "case",
  "when",
  "in",
  "match",
  "split",
  "scan",
  "gsub",
  "sub",
  "grep",
  "assert",
  "raise",
  "return",
  "=~",
]);

/**
 * Strips a comment from a line, respecting quoted strings.
 *
 * A `#` inside a string is part of the string, and a `#` outside one starts
 * a comment that runs to the end of the line. A string may span lines, so
 * the quote the line leaves open is reported, and the next line continues
 * it.
 */
function stripComment(line: string, openQuote: string | undefined): GemStripped {
  let quote = openQuote;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      // An interpolation holds a string of its own, and the reader cannot
      // say where it ends: the text it covers is not code, and the reader
      // does not read it.
      if (quote === '"' && char === "#" && line[index + 1] === "{") {
        return { text: line, interpolated: true };
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    // A regular expression is text, and its text is not the line's text.
    if (char === "/") {
      const regexp = findRegexpAt(line, index);
      if (regexp) {
        if (regexp.end === -1) return { text: line };
        index = regexp.end - 1;
        continue;
      }
    }
    // A percent string is a string, and its text is not the line's text.
    if (char === "%") {
      const percent = percentString(line, index);
      if (percent) {
        // A string that runs on into the next line holds the rest of the
        // line, and the reader skips the line as a region.
        if (percent.end === -1) return { text: line };
        index = percent.end - 1;
        continue;
      }
    }
    // A command string is a string, and its text is not the line's text.
    if (char === "`") {
      const command = findCommandStringAt(line, index);
      if (command) {
        if (command.end === -1) return { text: line };
        index = command.end - 1;
        continue;
      }
    }
    if (char === "#") return { text: line.slice(0, index) };
  }
  return { text: line, ...(quote ? { quote } : {}) };
}

/**
 * Reads a string literal, when the text is nothing but one.
 *
 * A literal that is followed by more text is an expression, not a
 * literal: `"7.0" + suffix` names a computed version, and reading the
 * literal out of it would name a version the project never pins.
 */
function readLiteral(text: string): GemLiteral | undefined {
  const trimmed = text.trim();
  const first = trimmed[0];
  if (first !== '"' && first !== "'") return undefined;
  for (let index = 1; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === first) {
      if (index !== trimmed.length - 1) return undefined;
      const value = decodeEscapes(trimmed.slice(1, index), first === "'" ? "ruby-raw" : "escaped");
      if (value === undefined) return undefined;
      return { value, quote: first };
    }
  }
  return undefined;
}

/**
 * Whether a literal interpolates something.
 *
 * A double-quoted literal may hold an interpolation, and an interpolated
 * name is not a name: the value is decided when the file runs, and the
 * file does not say which one it is.
 */
function interpolates(literal: GemLiteral): boolean {
  if (literal.quote !== '"') return false;
  // Ruby writes an interpolation as `#{}`, as `#@ivar`, as `#@@cvar`, or as
  // `#$global`.
  return /#\{[^}]*\}|#@@?[A-Za-z_][A-Za-z0-9_]*|#\$[A-Za-z_][A-Za-z0-9_]*/.test(literal.value);
}

/**
 * The first argument of a statement, when it is a literal.
 *
 * The argument may be written with parentheses, and it may be followed by
 * a block header, and neither changes the literal. A source whose address
 * is computed is not the public registry, and treating it as one would
 * read the gems of a mirror as the gems of the registry.
 */
function firstArgumentLiteral(text: string): GemLiteral | undefined {
  let argument = text.trim();
  if (argument.startsWith("(")) {
    let depth = 0;
    let quote: string | undefined;
    for (let index = 0; index < argument.length; index += 1) {
      const char = argument[index];
      if (quote) {
        if (char === "\\") {
          index += 1;
          continue;
        }
        if (char === quote) quote = undefined;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === "(") depth += 1;
      else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          argument = argument.slice(1, index);
          break;
        }
      }
    }
  }
  // A block header follows the argument, and it is not part of it.
  argument = argument.replace(/\s+do\s*(\|[^|]*\|)?\s*$/, "").trim();
  return readLiteral(argument);
}

/**
 * The terminators of the heredocs a piece of text opens.
 *
 * A heredoc is a string, and a string may hold a declaration that means
 * nothing, so the reader skips the body rather than read it.
 */
function heredocTerminators(text: string): GemHeredocTerminator[] {
  const terminators: GemHeredocTerminator[] = [];
  let quote: string | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char !== "<" || text[index + 1] !== "<") continue;
    const marker = readHeredocMarker(text, index);
    if (!marker) continue;
    terminators.push({
      terminator: marker.terminator,
      interpolates: marker.interpolates,
      indented: marker.indented,
    });
    index = marker.end - 1;
  }
  return terminators;
}

/** A heredoc's marker, read whole. */
interface GemHeredocMarker extends GemHeredocTerminator {
  /** The index just after the marker. */
  readonly end: number;
}

/**
 * Reads a heredoc's marker at a place.
 *
 * A quoted delimiter runs to its matching quote, and it may hold spaces
 * and other quotes; an unquoted one is a word. A heredoc written with
 * single quotes is a raw one, and the dashed and the squiggly forms let
 * the terminator be indented.
 */
function readHeredocMarker(text: string, at: number): GemHeredocMarker | undefined {
  let marker = at + 2;
  let indented = false;
  if (text[marker] === "-" || text[marker] === "~") {
    indented = true;
    marker += 1;
  }
  const opening = text[marker];
  if (opening === '"' || opening === "'" || opening === "`") {
    const close = text.indexOf(opening, marker + 1);
    if (close === -1) return undefined;
    return {
      terminator: text.slice(marker + 1, close),
      interpolates: opening !== "'",
      indented,
      end: close + 1,
    };
  }
  const word = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(text.slice(marker));
  if (!word) return undefined;
  return {
    terminator: word[0],
    interpolates: true,
    indented,
    end: marker + word[0].length,
  };
}

/** A percent string a piece of text opens. */
interface PercentString {
  /** The index the percent sign is at. */
  readonly start: number;
  /**
   * The string interpolates.
   *
   * The lowercase `q` form is a raw string: its text is the text between
   * the delimiters, and an interpolation in it is only a character.
   */
  readonly interpolates: boolean;
  /** The delimiter that opens it. */
  readonly open: string;
  /** The delimiter that closes it. */
  readonly close: string;
  /** The delimiter is a pair, so the content may nest it. */
  readonly paired: boolean;
  /** The index just after the closing delimiter, or -1 when it spans lines. */
  readonly end: number;
  /** The nesting the content holds when the text ends. */
  readonly depth: number;
}

/**
 * The percent string a piece of text opens, when it opens one.
 *
 * A percent string is a string, and a string may hold a declaration that
 * means nothing, so the reader skips its body rather than read it.
 */
/**
 * Whether a piece of text holds an interpolation.
 *
 * An interpolation holds a string of its own, and the reader cannot say
 * where it ends: the text it covers is not code, and the reader does not
 * read it.
 */
function holdsInterpolation(text: string): boolean {
  return text.includes("#{");
}

function percentString(text: string, from: number): PercentString | undefined {
  if (text[from] !== "%") return undefined;
  const start = from;
  const letter = text[from + 1];
  const isLetter = letter !== undefined && /[qQwWiIrsx]/.test(letter);
  // The lowercase `q` form is the raw one.
  const interpolates = !isLetter || letter !== "q";
  const delimiterAt = from + (isLetter ? 2 : 1);
  const open = text[delimiterAt];
  if (!open) return undefined;
  const pairing = PERCENT_PAIRS[open as keyof PercentPairs];
  // The bare form pairs the delimiters it knows and takes any other
  // punctuation as its own; the letter form takes any punctuation too.
  if (/[A-Za-z0-9_]/.test(open)) return undefined;
  if (/\s/.test(open)) return undefined;
  const close = pairing ?? open;
  const paired = close !== open;
  let depth = 1;
  for (let index = delimiterAt + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (paired && char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return { start, open, close, paired, interpolates, end: index + 1, depth: 0 };
      }
    }
  }
  return { start, open, close, paired, interpolates, end: -1, depth };
}

/** A string a piece of text holds, and the kind it is. */
interface GemTextLiteral {
  /** The kind of the string. */
  readonly kind: "percent" | "command" | "regexp";
  /** The index the string starts at. */
  readonly start: number;
  /** The index just after the closing delimiter, or -1 when it spans lines. */
  readonly end: number;
  /** The reader could not say whether the text is a string or a division. */
  readonly ambiguous?: boolean;
  /** The percent string's own shape, when it is one. */
  readonly percent?: PercentString;
}

/**
 * The strings a piece of text holds.
 *
 * The scan is one pass, because a file may hold many strings and a scan
 * that started over for each of them would grow with the square of the
 * file.
 */
function findLiterals(text: string): GemTextLiteral[] {
  const literals: GemTextLiteral[] = [];
  let index = 0;
  let quote: string | undefined;
  while (index < text.length) {
    const char = text[index]!;
    if (quote) {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === quote) quote = undefined;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      index += 1;
      continue;
    }
    // A heredoc's body is a region of its own, and the marker is not a
    // string of its own.
    if (char === "<" && text[index + 1] === "<") {
      const marker = readHeredocMarker(text, index);
      if (marker) {
        index = marker.end;
        continue;
      }
    }
    if (char === "%") {
      const percent = percentString(text, index);
      if (percent) {
        literals.push({ kind: "percent", start: percent.start, end: percent.end, percent });
        index = percent.end === -1 ? text.length : percent.end;
        continue;
      }
    }
    if (char === "`") {
      const command = findCommandStringAt(text, index);
      if (command) {
        literals.push({ kind: "command", start: command.start, end: command.end });
        index = command.end === -1 ? text.length : command.end;
        continue;
      }
    }
    if (char === "/") {
      const regexp = findRegexpAt(text, index);
      if (regexp) {
        literals.push({
          kind: "regexp",
          start: regexp.start,
          end: regexp.end,
          ...(regexp.ambiguous ? { ambiguous: true } : {}),
        });
        index = regexp.end === -1 ? text.length : regexp.end;
        continue;
      }
    }
    index += 1;
  }
  return literals;
}

/**
 * The text with the strings replaced by a value.
 *
 * A string's text is not the code's text, and a semicolon or a bracket
 * inside it does not separate two statements and does not open a pair.
 */
function maskLiterals(text: string, literals: readonly GemTextLiteral[]): string {
  let masked = "";
  let from = 0;
  for (const literal of literals) {
    if (literal.end === -1) break;
    masked += text.slice(from, literal.start) + UNREAD;
    from = literal.end;
  }
  return masked + text.slice(from);
}

/**
 * The command string the text holds at a place.
 */
function findCommandStringAt(text: string, at: number): GemExtent | undefined {
  // The backtick runs a command, and the command's body runs to the next
  // backtick.
  for (let end = at + 1; end < text.length; end += 1) {
    if (text[end] === "\\") {
      end += 1;
      continue;
    }
    if (text[end] === "`") return { start: at, end: end + 1 };
  }
  return { start: at, end: -1 };
}

/**
 * Whether a slash at this point opens a regular expression.
 *
 * A slash between two values is a division, and a slash where a value is
 * expected is a regular expression, whose body is text and not code.
 */
function regexpStart(text: string, at: number): boolean | undefined {
  // The text before the slash is read in place: a file may hold many
  // slashes, and copying the text before each of them would grow with the
  // square of the file.
  let index = at - 1;
  while (index >= 0 && /\s/.test(text[index]!)) index -= 1;
  if (index < 0) return true;
  const last = text[index]!;
  // An operator is followed by an operand, and an operand may be a
  // regular expression.
  if ("=([{,:~+&|!*-/%<>^".includes(last)) return true;
  let start = index;
  while (start >= 0 && /[A-Za-z0-9_]/.test(text[start]!)) start -= 1;
  const word = text.slice(start + 1, index + 1);
  if (REGEXP_KEYWORDS.has(word)) return true;
  // The word may be a local variable, and then the slash divides, or it
  // may be a method, and then the slash opens a regular expression. The
  // reader cannot say which, and it treats the text as a string so that
  // its contents are never declarations.
  return undefined;
}

/**
 * The regular expression the text holds at a place.
 */
function findRegexpAt(text: string, at: number): GemExtent | undefined {
  // The slash opens a regular expression when a value is expected, and
  // the expression's body runs to the next unescaped slash. A slash the
  // reader cannot place is treated as one anyway: its text is not code
  // either way, and the reader reports that it did not place it.
  const placement = regexpStart(text, at);
  if (placement === false) return undefined;
  if (placement === undefined) {
    // The reader cannot place the slash, and the text it opens may run
    // on into the next line. The text is not code either way, and the
    // reader reports that it did not place it.
    for (let end = at + 1; end < text.length; end += 1) {
      if (text[end] === "\\") {
        end += 1;
        continue;
      }
      if (text[end] === "/") return { start: at, end: end + 1, ambiguous: true };
    }
    return { start: at, end: -1, ambiguous: true };
  }
  for (let end = at + 1; end < text.length; end += 1) {
    if (text[end] === "\\") {
      end += 1;
      continue;
    }
    if (text[end] === "/") return { start: at, end: end + 1 };
  }
  return { start: at, end: -1 };
}

/**
 * Whether a region ends with a line, and how far into it the line ends.
 *
 * A heredoc's body ends with a line that holds its terminator, a block
 * comment's body ends with the line that holds its `=end`, and a string's
 * body ends with the line that holds its closing delimiter.
 */
function regionCloses(region: GemRegion, line: string): number {
  if (region.kind === "heredoc") {
    const ends = region.indented
      ? line.trimStart() === region.terminator
      : line === region.terminator;
    return ends ? line.length : -1;
  }
  // The `=end` marker is a word of its own: `=endless` is not the end of
  // a block comment.
  if (region.kind === "comment") return /^=end(\s|$)/.test(line.trim()) ? line.length : -1;
  let depth = region.depth;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (region.kind === "percent" && region.paired && char === region.open) depth += 1;
    else if (char === region.close) {
      depth -= 1;
      if (depth === 0) {
        region.depth = depth;
        return index + 1;
      }
    }
  }
  region.depth = depth;
  return -1;
}

/**
 * Tracks the delimiters a piece of text opens and closes.
 *
 * The delimiters inside a string are part of the string, and the ones
 * inside a comment are part of the comment. A closer that does not match
 * the delimiter it closes is a syntax error: the reader no longer knows
 * where the statement ends.
 *
 * A brace opens a block as well as a hash, and the block it opens may
 * name a source, so the source rides with the delimiter.
 */
function trackDelimiters(
  text: string,
  stack: GemDelimiter[],
  openQuote: string | undefined,
  source?: string,
): string | undefined {
  let quote = openQuote;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    // A percent string is a string, and the brackets inside it are the
    // string's, not the code's.
    if (char === "%") {
      const percent = percentString(text, index);
      if (percent) {
        if (percent.end === -1) return "a delimiter is nested too deeply";
        index = percent.end - 1;
        continue;
      }
    }
    if (char === "(" || char === "[") {
      if (stack.length >= MAX_NESTING) return "a delimiter is nested too deeply";
      stack.push({ kind: char, continues: true });
      continue;
    }
    if (char === "{") {
      // A brace inside a call is a hash, and the statement continues
      // while it is open. A brace on its own opens a block, and the
      // statement ends at the line's end.
      const inside = stack.some((entry) => entry.kind === "(" || entry.kind === "[");
      if (stack.length >= MAX_NESTING) return "a delimiter is nested too deeply";
      stack.push({ kind: "{", continues: inside, ...(source ? { source } : {}) });
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      const open = stack.pop();
      if (!open) return "a delimiter does not match";
      const openers: Readonly<Record<")" | "]" | "}", "(" | "[" | "{">> = {
        ")": "(",
        "]": "[",
        "}": "{",
      };
      if (openers[char] !== open.kind) return "a delimiter does not match";
    }
  }
  return undefined;
}

/**
 * Splits a statement at the semicolons that separate them.
 *
 * A semicolon inside a string, or inside a nested pair of brackets, is
 * part of its statement and does not separate two.
 */
function splitStatements(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let current = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (quote) {
      // An escaped quote is a character of the string, and it does not
      // close it.
      if (char === "\\") {
        current += char;
        const escaped = text[index + 1];
        if (escaped !== undefined) {
          current += escaped;
          index += 1;
        }
        index += 1;
        continue;
      }
      current += char;
      index += 1;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      index += 1;
      continue;
    }
    if (char === "%") {
      const percent = percentString(text, index);
      if (percent) {
        if (percent.end === -1) break;
        current += text.slice(index, percent.end);
        index = percent.end;
        continue;
      }
    }
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      current += char;
      index += 1;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      current += char;
      index += 1;
      continue;
    }
    if (char === ";" && depth === 0) {
      if (current.trim().length) parts.push(current.trim());
      current = "";
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  if (current.trim().length) parts.push(current.trim());
  return parts;
}

/**
 * Splits a declaration's arguments at the commas that separate them.
 *
 * A comma inside a string, or inside a nested pair of brackets, is part of
 * its argument and does not separate two.
 */
function splitArguments(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let current = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (quote) {
      // An escaped quote is a character of the string, and it does not
      // close it.
      if (char === "\\") {
        current += char;
        const escaped = text[index + 1];
        if (escaped !== undefined) {
          current += escaped;
          index += 1;
        }
        index += 1;
        continue;
      }
      current += char;
      index += 1;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      index += 1;
      continue;
    }
    // A percent string is a value, and the comma inside it does not
    // separate two arguments.
    if (char === "%") {
      const percent = percentString(text, index);
      if (percent) {
        if (percent.end === -1) break;
        current += text.slice(index, percent.end);
        index = percent.end;
        continue;
      }
    }
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      current += char;
      index += 1;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      current += char;
      index += 1;
      continue;
    }
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  if (current.trim().length) parts.push(current.trim());
  return parts;
}

/**
 * Splits a piece of text at the separators that are not inside a string or
 * a nested pair of brackets.
 */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let current = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (quote) {
      // An escaped quote is a character of the string, and it does not
      // close it.
      if (char === "\\") {
        current += char;
        const escaped = text[index + 1];
        if (escaped !== undefined) {
          current += escaped;
          index += 1;
        }
        index += 1;
        continue;
      }
      current += char;
      index += 1;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      index += 1;
      continue;
    }
    if (char === "%") {
      const percent = percentString(text, index);
      if (percent) {
        if (percent.end === -1) break;
        current += text.slice(index, percent.end);
        index = percent.end;
        continue;
      }
    }
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      current += char;
      index += 1;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      current += char;
      index += 1;
      continue;
    }
    if (char === separator && depth === 0) {
      parts.push(current);
      current = "";
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  parts.push(current);
  return parts;
}

/**
 * The value an option argument names.
 *
 * The value is the text after the key's separator, and a hash's value
 * carries no hash syntax around it.
 */
function optionValue(argument: string, key: string): string | undefined {
  const trimmed = argument.trim();
  if (trimmed.startsWith("{")) {
    for (const item of splitTopLevel(trimmed.slice(1, -1), ",")) {
      const entry = item.trim();
      const match = /^:?["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*(?::|=>)\s*([\s\S]*)$/.exec(entry);
      if (match?.[1] === key) return match[2]?.trim();
    }
    return undefined;
  }
  const match = /^:?["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*(?::|=>)\s*([\s\S]*)$/.exec(trimmed);
  if (match?.[1] !== key) return undefined;
  return match[2]?.trim();
}

/**
 * The braces a statement opens.
 *
 * A brace opens a block, and a hash literal's braces balance within the
 * statement that holds them.
 */
function countBraces(statement: string): number {
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < statement.length; index += 1) {
    const char = statement[index]!;
    if (quote) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
  }
  return depth;
}

/**
 * The keys an option argument names.
 *
 * A gem may carry its options as keyword arguments, as a hash, or as a
 * hash written with the hash rocket, and a key names the option.
 */
function optionKeys(argument: string): string[] {
  const trimmed = argument.trim();
  if (trimmed.startsWith("{")) {
    const keys: string[] = [];
    for (const item of splitTopLevel(trimmed.slice(1, -1), ",")) {
      const key = /^:?["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*(?::|=>)/.exec(item.trim())?.[1];
      if (key) keys.push(key);
    }
    return keys;
  }
  const keyword = keywordOf(trimmed);
  if (keyword) return [keyword];
  const rocket = /^:([A-Za-z_][A-Za-z0-9_]*)\s*=>/.exec(trimmed)?.[1];
  return rocket ? [rocket] : [];
}

/**
 * Whether an argument is an option rather than a version.
 *
 * A gem may carry options in a keyword argument, in a hash, or in a hash
 * written with the hash rocket, and none of them is a version.
 */
function isOptionArgument(argument: string): boolean {
  const trimmed = argument.trim();
  if (trimmed.startsWith("{")) return true;
  if (keywordOf(trimmed) !== undefined) return true;
  return /^:[A-Za-z_][A-Za-z0-9_]*\s*=>/.test(trimmed);
}

/** The keyword an argument names, when the argument is a keyword argument. */
function keywordOf(argument: string): string | undefined {
  const match = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(argument.trim());
  return match?.[1];
}

/**
 * The text of a declaration's arguments.
 *
 * A declaration may be written with parentheses or without them, and the
 * text runs to the end of the statement either way. A declaration whose
 * parentheses are never closed is not read: the reader no longer knows
 * where the declaration ends.
 */
function argumentText(statement: string): string | undefined {
  const trimmed = statement.trim();
  if (!trimmed.startsWith("(")) return trimmed;
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (quote) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        // Nothing may follow the closing parenthesis: a declaration that
        // does is not one the reader understands.
        if (trimmed.slice(index + 1).trim().length) return undefined;
        return trimmed.slice(1, index);
      }
    }
  }
  return undefined;
}

/**
 * The source the gems a statement declares come from.
 *
 * A source block names where the gems inside come from, and a source that
 * is not the public registry means the gems are not published by the
 * registry at all.
 */
function sourceLabel(statement: string): string | undefined {
  const keyword = /^([A-Za-z_][A-Za-z0-9_]*)\b/.exec(statement)?.[1];
  if (!keyword) return undefined;
  if (SOURCE_KEYWORDS.has(keyword)) return keyword;
  if (keyword !== "source") return undefined;
  const url = firstArgumentLiteral(statement.slice(keyword.length));
  return url && PUBLIC_SOURCE.test(url.value) ? undefined : "source";
}

/**
 * Reads the gems a Gemfile declares.
 *
 * A gem is declared by a `gem` statement, and its name is a string
 * literal. A declaration that names no version is reported rather than
 * read: a gem the project does not pin is a gem whose version the harness
 * cannot compare.
 *
 * A gem the registry does not publish is not read either. A declaration
 * that names a repository or a directory is a gem from somewhere else, and
 * so is every gem inside a block that names one.
 *
 * A file the reader could not read to its end yields no gems at all: a
 * document the reader lost its place in must not become a document that
 * declares what it does not.
 */
export function readGemfile(text: string): GemfileReadResult {
  const gems: GemDeclaration[] = [];
  const warnings: string[] = [];
  const lines = text.split("\n");
  /** The blocks the reader is inside. */
  const blocks: GemBlock[] = [];
  /** The regions of the file that are strings, and not code. */
  const regions: GemRegion[] = [];
  /** The source the whole file takes, when a directive names one. */
  let fileSource: string | undefined;
  /** The statement the reader is reading. */
  let pending = "";
  /** The quote the last line left open. */
  let openQuote: string | undefined;
  /** The delimiters the file leaves open. */
  const delimiters: GemDelimiter[] = [];
  /** How deep the reader is in the statements it is reading. */
  let depth = 0;
  /** The text the region the reader is inside covers. */
  let regionText = "";

  const uncertain = (reason: string): GemfileReadResult => {
    warnings.push(`the Gemfile could not be read: ${reason}`);
    return { gems: [], warnings };
  };

  /**
   * Reads one statement: the block it belongs to, and the gems it
   * declares.
   *
   * A statement may hold more than one, separated by a semicolon, and
   * each is read on its own.
   */
  const processStatement = (statement: string, inherited?: string): string | undefined => {
    depth += 1;
    if (depth > MAX_NESTING) {
      depth -= 1;
      return "the Gemfile is nested too deeply";
    }
    try {
      return readStatement(statement, inherited);
    } finally {
      depth -= 1;
    }
  };

  /**
   * Reads one statement: the block it belongs to, and the gems it
   * declares.
   */
  const readStatement = (statement: string, inherited?: string): string | undefined => {
    // The block the statement belongs to. A block is closed by an `end`,
    // and a block the reader does not know about is a block whose
    // contents it cannot place.
    if (statement === "end") {
      const block = blocks.at(-1);
      if (!block || block.kind !== "end") return "an `end` has no block";
      blocks.pop();
    }
    const source = sourceLabel(statement);
    const opensBlock = OPENS_BLOCK.test(statement) || BLOCK_KEYWORD.test(statement);
    // A source that opens a brace block is scoped to that block, and the
    // gems outside it come from the registry.
    const opensBrace = countBraces(statement) > 0;
    // A source block scopes the gems inside it, a source directive scopes
    // the whole file to it, and a statement that names a source and closes
    // its own block scopes only itself. A block opened by a brace carries
    // its source with the delimiter.
    let lineSource: string | undefined;
    if (opensBlock) {
      if (blocks.length >= MAX_NESTING) return "a block is nested too deeply";
      blocks.push({ kind: "end", ...(source ? { source } : {}) });
    } else if (source !== undefined) {
      if (source === "source" && !opensBrace) fileSource = source;
      else lineSource = source;
    }
    // A gem inside a source scope does not come from the registry.
    const inSource =
      fileSource !== undefined ||
      lineSource !== undefined ||
      inherited !== undefined ||
      blocks.some((block) => block.source !== undefined) ||
      delimiters.some((delimiter) => delimiter.source !== undefined);
    // A block whose body is on the same line: the body holds statements
    // of its own, and they are read with the block's scope. A hash
    // literal is an argument, and it holds no statements.
    const oneLine = /^[A-Za-z_][A-Za-z0-9_]*\s*(\([^)]*\))?\s*\{([\s\S]*)\}$/.exec(statement);
    if (oneLine?.[2]?.trim()) {
      const scope = lineSource ?? inherited;
      for (const part of splitStatements(oneLine[2].trim())) {
        const failure = processStatement(part, scope);
        if (failure) return failure;
      }
    }

    const directive = /^([A-Za-z_][A-Za-z0-9_]*)\b/.exec(statement)?.[1];
    if (directive && UNREAD_DIRECTIVES.has(directive)) {
      warnings.push(UNREAD_DIRECTIVES.get(directive) as string);
      return undefined;
    }
    if (!GEM_STATEMENT.test(statement)) return undefined;
    const argumentsText = argumentText(statement.slice("gem".length));
    if (argumentsText === undefined) {
      warnings.push("a gem declaration is not read");
      return undefined;
    }
    const args = splitArguments(argumentsText);
    const name = args[0] === undefined ? undefined : readLiteral(args[0]);
    if (!name || !name.value.trim().length) {
      warnings.push("a gem declaration names no gem");
      return undefined;
    }
    if (name.value === UNREAD) {
      warnings.push("a gem declaration names a gem the reader does not read");
      return undefined;
    }
    // A gem whose name interpolates names no gem: the value is decided
    // when the file runs, and the file does not say which one it is.
    if (interpolates(name)) {
      warnings.push(`gem ${name.value} has a name the reader does not read`);
      return undefined;
    }
    // A gem that names a source comes from that source, and not from the
    // registry. The source may be named by a keyword argument, by a hash,
    // or by a hash written with the hash rocket.
    const options = args.slice(1).flatMap((argument) => optionKeys(argument));
    const sourceArgument = options.find((value) => SOURCE_KEYWORDS.has(value));
    if (sourceArgument) {
      warnings.push(`gem ${name.value} comes from ${sourceArgument}, which is not read`);
      return undefined;
    }
    if (options.includes("source")) {
      const argument = args.slice(1).find((value) => optionKeys(value).includes("source")) ?? "";
      const url = firstArgumentLiteral(optionValue(argument, "source") ?? "");
      if (!url || !PUBLIC_SOURCE.test(url.value)) {
        warnings.push(`gem ${name.value} comes from a source, which is not read`);
        return undefined;
      }
    }
    if (inSource) {
      warnings.push(`gem ${name.value} comes from a source, which is not read`);
      return undefined;
    }
    const requirements: string[] = [];
    let computed = false;
    for (const argument of args.slice(1)) {
      if (isOptionArgument(argument)) continue;
      const literal = readLiteral(argument);
      if (literal === undefined) {
        computed = true;
        continue;
      }
      if (literal.value.trim().length) requirements.push(literal.value);
    }
    if (computed) {
      warnings.push(`gem ${name.value} has a version the reader does not read`);
      return undefined;
    }
    if (!requirements.length) {
      warnings.push(`gem ${name.value} has no version`);
      return undefined;
    }
    gems.push({
      name: name.value,
      requirement: requirements.length === 1 ? requirements[0] : requirements.join(", "),
    });
    return undefined;
  };

  for (const raw of lines) {
    // A region that is a string, and not code. The statement continues
    // after it, and the rest of the line it ends on is code again.
    let code: string;
    let resumed = false;
    if (regions.length) {
      const closed = regionCloses(regions[0]!, raw);
      if (closed < 0) {
        regionText += `\n${raw}`;
        continue;
      }
      const region = regions.shift()!;
      // The text the region covered is read before the region ends: an
      // interpolation inside it holds a string the reader cannot delimit.
      // A comment holds no string, and a raw string's extent is known.
      const interpolates =
        region.kind !== "comment" &&
        (region.kind !== "percent" || region.interpolates) &&
        (region.kind !== "heredoc" || region.interpolates);
      if (interpolates && holdsInterpolation(`${regionText}\n${raw}`)) {
        return uncertain("a string with an interpolation is not read");
      }
      regionText = "";
      code = raw.slice(closed);
      resumed = true;
    } else {
      code = raw;
    }
    const quoteAtStart = openQuote;
    // A block comment opens with a marker, and the marker may carry a
    // quote that is not a string.
    if (!quoteAtStart && code.trimStart().startsWith("=begin")) {
      regions.push({ kind: "comment" });
      continue;
    }
    const stripped = stripComment(code, quoteAtStart);
    if (stripped.interpolated) {
      return uncertain("a string with an interpolation is not read");
    }
    openQuote = stripped.quote;
    let text = stripped.text.trim();
    if (!text && !resumed) continue;
    // The data section is data, and not code.
    if (!openQuote && text === "__END__") break;
    if (!openQuote) {
      // The strings the text holds are strings, and a string is not code.
      // A string that runs on into the next line swallows it, and a string
      // that ends within the line is a value the statement carries.
      const literals = findLiterals(text);
      for (const literal of literals) {
        const covered = text.slice(literal.start, literal.end === -1 ? text.length : literal.end);
        if (literal.kind !== "percent" || literal.percent?.interpolates) {
          if (holdsInterpolation(covered)) {
            return uncertain("a string with an interpolation is not read");
          }
        }
        if (literal.ambiguous) {
          warnings.push("a slash the reader cannot place, which is not read");
        } else if (literal.kind === "percent") warnings.push("a percent string is not read");
        else if (literal.kind === "command") warnings.push("a command string is not read");
        else warnings.push("a regular expression is not read");
      }
      const spanning = literals.find((literal) => literal.end === -1);
      if (spanning) {
        // The string runs on into the next line: the code before it is
        // the statement, and the string's text is not.
        const before = text.slice(0, spanning.start).trim();
        if (before) {
          pending = pending ? `${pending} ${before}` : before;
          const failure = trackDelimiters(before, delimiters, quoteAtStart, sourceLabel(before));
          if (failure) return uncertain(failure);
        }
        pending = pending ? `${pending} ${UNREAD}` : UNREAD;
        if (spanning.kind === "percent" && spanning.percent) {
          regions.push({
            kind: "percent",
            ...spanning.percent,
            depth: spanning.percent.depth,
          });
        } else {
          regions.push({
            kind: "slashy",
            close: spanning.kind === "command" ? "`" : "/",
            depth: 1,
          });
        }
        continue;
      }
      // The strings end within the line: their text is not the code's.
      if (literals.length) text = maskLiterals(text, literals);
      // The heredocs the statement opens.
      for (const heredoc of heredocTerminators(text)) {
        warnings.push("a heredoc is not read");
        regions.push({ kind: "heredoc", ...heredoc });
      }
    }

    // A statement continues while a delimiter is open, a string is open,
    // or a comma ends it.
    if (text) {
      pending = pending ? `${pending} ${text}` : text;
      const failure = trackDelimiters(text, delimiters, quoteAtStart, sourceLabel(text));
      if (failure) return uncertain(failure);
    }
    if (delimiters.some((delimiter) => delimiter.continues) || openQuote) continue;
    if (pending.endsWith(",")) continue;
    const statement = pending;
    pending = "";
    for (const part of splitStatements(statement)) {
      const failure = processStatement(part);
      if (failure) return uncertain(failure);
    }
  }
  if (openQuote) return uncertain("a string is never closed");
  if (regions.length) {
    const region = regions[0]!;
    return uncertain(
      region.kind === "comment"
        ? "a block comment is never closed"
        : region.kind === "heredoc"
          ? "a heredoc is never closed"
          : "a string is never closed",
    );
  }
  if (pending.length) return uncertain("a statement is never closed");
  if (delimiters.length) return uncertain("a delimiter is never closed");
  if (blocks.length) return uncertain("a block is never closed");
  // A source that is not the public registry takes the gems of the whole
  // file, whatever order the file declares them in.
  if (fileSource) {
    warnings.push("the Gemfile takes its gems from a source, which is not read");
    return { gems: [], warnings };
  }
  return { gems, warnings };
}
