/**
 * A small XML reader for the elements a Maven manifest uses.
 *
 * The reader tokenizes the document rather than matching tags, so the
 * constructs a tag-matching walk would read as markup are handled: a
 * comment is skipped, a CDATA section is character data, and a processing
 * instruction or a declaration is skipped. A document that is not
 * well formed is reported, never half-read.
 */

/** An element and its content. */
export interface XmlElement {
  name: string;
  /** The element's text content, with CDATA sections included. */
  text: string;
  /** The element's child elements. */
  children: XmlElement[];
  /**
   * The element's attributes, by name.
   *
   * The names are the ones the document wrote, because an attribute name is
   * case-sensitive: a NuGet manifest writes `Include` and a `packages.config`
   * writes `id`, and the two name different attributes.
   */
  attributes: Record<string, string>;
}

/** The result of reading a document. */
export interface XmlDocument {
  /** The document's root element. */
  root?: XmlElement;
  /** The document is not well formed. */
  error?: string;
}

/** The constructs an XML document is made of. */
export type XmlToken =
  | { kind: "text"; value: string }
  | { kind: "cdata"; value: string }
  | { kind: "open"; name: string; selfClosing: boolean; attributes: Record<string, string> }
  | { kind: "close"; name: string };

/** What a tokenizer produced. */
export interface XmlTokenization {
  tokens: XmlToken[];
  /** The document could not be tokenized. */
  error?: string;
}

/** Tokenizes a document into text, character data, and tags. */
function tokenize(text: string): XmlTokenization {
  const tokens: XmlToken[] = [];
  let index = 0;
  while (index < text.length) {
    const next = text.indexOf("<", index);
    if (next === -1) {
      tokens.push({ kind: "text", value: text.slice(index) });
      break;
    }
    if (next > index) tokens.push({ kind: "text", value: text.slice(index, next) });
    index = next;
    if (text.startsWith("<!--", index)) {
      const end = text.indexOf("-->", index + 4);
      if (end === -1) return { tokens, error: "a comment is never closed" };
      // A comment may not contain a double hyphen.
      if (text.slice(index + 4, end).includes("--"))
        return { tokens, error: "a comment contains a double hyphen" };
      index = end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", index)) {
      const end = text.indexOf("]]>", index + 9);
      if (end === -1) return { tokens, error: "a character data section is never closed" };
      tokens.push({ kind: "cdata", value: text.slice(index + 9, end) });
      index = end + 3;
      continue;
    }
    if (text.startsWith("<?", index)) {
      const end = text.indexOf("?>", index + 2);
      if (end === -1) return { tokens, error: "a processing instruction is never closed" };
      index = end + 2;
      continue;
    }
    if (text.startsWith("<!", index)) {
      // A declaration. Its boundary is found without reading a quoted
      // string as markup, so text inside a system identifier cannot become
      // an element. A declaration with an internal subset — a document type
      // definition — is not supported and is reported.
      let end = index + 2;
      let quote: string | undefined;
      let subset = false;
      while (end < text.length) {
        const char = text[end];
        if (quote) {
          if (char === quote) quote = undefined;
          end += 1;
          continue;
        }
        if (char === '"' || char === "'") {
          quote = char;
          end += 1;
          continue;
        }
        if (char === "[") {
          subset = true;
          end += 1;
          continue;
        }
        if (char === ">") break;
        end += 1;
      }
      if (end >= text.length) return { tokens, error: "a declaration is never closed" };
      if (subset) return { tokens, error: "a document type definition is not supported" };
      index = end + 1;
      continue;
    }
    if (text.startsWith("</", index)) {
      const end = text.indexOf(">", index + 2);
      if (end === -1) return { tokens, error: "a closing tag is never closed" };
      const name = text.slice(index + 2, end).trim();
      if (!/^[A-Za-z_][\w.:-]*$/.test(name))
        return { tokens, error: `a closing tag has an invalid name: ${name}` };
      tokens.push({ kind: "close", name });
      index = end + 1;
      continue;
    }
    const end = findTagEnd(text, index + 1);
    if (end === -1) return { tokens, error: "a tag is never closed" };
    const body = text.slice(index + 1, end);
    const selfClosing = body.trimEnd().endsWith("/");
    const name = (selfClosing ? body.trimEnd().slice(0, -1) : body).trim().split(/\s+/)[0] ?? "";
    if (!/^[A-Za-z_][\w.:-]*$/.test(name))
      return { tokens, error: `a tag has an invalid name: ${name}` };
    // The attributes are parsed, because a tag the reader does not
    // understand is a tag it cannot trust to have ended where it says — and
    // because a manifest may carry a version in an attribute rather than in
    // the element's text.
    const attributes = parseAttributes(selfClosing ? body.trimEnd().slice(0, -1) : body);
    if (!attributes) return { tokens, error: `a tag has invalid attributes: ${name}` };
    tokens.push({ kind: "open", name, selfClosing, attributes });
    index = end + 1;
  }
  return { tokens };
}

/**
 * The end of a tag, which is the `>` that is outside every quoted
 * attribute value.
 */
function findTagEnd(text: string, from: number): number {
  let quote: string | undefined;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return index;
  }
  return -1;
}

/**
 * Reads a tag's attributes.
 *
 * An attribute is a name, an equals sign, and a quoted value. Anything else
 * — an unquoted value, a missing value — is rejected, so a tag the reader
 * does not understand leaves the document uncertain. A name that repeats is
 * rejected too, because there would be no unambiguous value to choose.
 *
 * The values are returned decoded, the way the element's text is: a
 * character reference in an attribute value names the character it stands
 * for, not a literal ampersand.
 */
function parseAttributes(text: string): Record<string, string> | undefined {
  // The text starts with the element's name, which is not an attribute.
  const element = /^[A-Za-z_][\w.:-]*/.exec(text);
  if (!element) return undefined;
  const attributes: Record<string, string> = {};
  let index = element[0].length;
  const seen = new Set<string>();
  while (index < text.length) {
    // Attributes are separated by whitespace, so a name that runs into the
    // previous value is not an attribute.
    const separator = /^\s+/.exec(text.slice(index));
    if (!separator) return undefined;
    index += separator[0].length;
    if (index >= text.length) break;
    const name = /^[A-Za-z_][\w.:-]*/.exec(text.slice(index));
    if (!name) return undefined;
    if (seen.has(name[0])) return undefined;
    seen.add(name[0]);
    index += name[0].length;
    while (index < text.length && /\s/.test(text[index] as string)) index += 1;
    if (text[index] !== "=") return undefined;
    index += 1;
    while (index < text.length && /\s/.test(text[index] as string)) index += 1;
    const quote = text[index];
    if (quote !== '"' && quote !== "'") return undefined;
    index += 1;
    const end = text.indexOf(quote, index);
    if (end === -1) return undefined;
    const value = text.slice(index, end);
    // A raw `<` in an attribute value is not well formed.
    if (value.includes("<")) return undefined;
    attributes[name[0]] = decodeCharacterReferences(value);
    index = end + 1;
  }
  return attributes;
}

/**
 * Decodes the character references in a text run.
 *
 * The five predefined entities and the numeric forms are decoded. Any other
 * named entity is left as it was written: an external entity is never
 * resolved, so the value stays inert text rather than becoming a fetch.
 */
function decodeCharacterReferences(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body: string) => {
    switch (body) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        break;
    }
    if (body.startsWith("#x")) {
      const code = Number.parseInt(body.slice(2), 16);
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return String.fromCodePoint(code);
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return String.fromCodePoint(code);
    }
    return whole;
  });
}

/** Reads a document into its root element. */
export function readXmlDocument(text: string): XmlDocument {
  const tokenized = tokenize(text);
  if (tokenized.error) return { error: tokenized.error };
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  for (const token of tokenized.tokens) {
    if (token.kind === "text") {
      if (stack.length === 0) {
        if (token.value.trim())
          return { error: "the document has content outside its root element" };
        continue;
      }
      stack[stack.length - 1].text += decodeCharacterReferences(token.value);
      continue;
    }
    if (token.kind === "cdata") {
      if (stack.length === 0) return { error: "the document has content outside its root element" };
      stack[stack.length - 1].text += token.value;
      continue;
    }
    if (token.kind === "open") {
      const element: XmlElement = {
        name: token.name,
        text: "",
        children: [],
        attributes: token.attributes,
      };
      if (stack.length === 0) {
        if (root) return { error: "the document has more than one root element" };
        root = element;
      } else {
        stack[stack.length - 1].children.push(element);
      }
      if (!token.selfClosing) stack.push(element);
      continue;
    }
    const open = stack.pop();
    if (!open) return { error: `unexpected closing tag </${token.name}>` };
    if (open.name !== token.name) return { error: `mismatched tag </${token.name}>` };
  }
  if (stack.length > 0) return { error: "a tag is never closed" };
  if (!root) return { error: "the document has no root element" };
  return { root };
}

/** The first child element with a name, if there is one. */
export function findChild(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((child) => child.name === name);
}

/** Every descendant element with a name, in document order. */
export function findDescendants(element: XmlElement, name: string): XmlElement[] {
  const found: XmlElement[] = [];
  for (const child of element.children) {
    if (child.name === name) found.push(child);
    found.push(...findDescendants(child, name));
  }
  return found;
}
