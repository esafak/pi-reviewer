const ENTITY_PATTERN = /&(?:#x([0-9a-f]+)|#([0-9]+)|amp|quot|lt|gt|nbsp|#39);/gi;

export function decodeHtmlEntities(value: string): string {
  return value.replace(ENTITY_PATTERN, (entity, hex, decimal) => {
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (entity.toLowerCase() === "&amp;") return "&";
    if (entity.toLowerCase() === "&quot;") return '"';
    if (entity.toLowerCase() === "&lt;") return "<";
    if (entity.toLowerCase() === "&gt;") return ">";
    if (entity.toLowerCase() === "&nbsp;") return " ";
    return "'";
  });
}

export function stripHtmlTags(value: string): string {
  let text = "";
  let inTag = false;
  for (const char of value) {
    if (char === "<") inTag = true;
    else if (char === ">") inTag = false;
    else if (!inTag) text += char;
  }
  return text;
}
