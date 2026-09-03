import { marked } from "marked";
import DOMPurify from "dompurify";
import { normalizeMarkdownText } from "../../../src/core/ai-fix-footer.js";

marked.use({ gfm: true, breaks: true });

export function renderMarkdown(src: string): string {
  const raw = marked.parse(normalizeMarkdownText(src)) as string;
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
}
