/** Escapes HTML comment delimiters without changing the value after JSON.parse. */
export function escapeHtmlCommentText(json: string): string {
  return json.replaceAll("--", "-\\u002d");
}
