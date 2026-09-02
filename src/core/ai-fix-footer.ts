export const AI_FIX_FOOTER = "For each issue above, determine whether it is valid. If so, fix it iteratively with one reviewer agent until convergence.";

export interface AiFixContext {
  file: string;
  line: number;
  side?: string;
  severity?: string;
}

const AI_FIX_DETAILS = /<details>\s*<summary>Prompt to fix with AI<\/summary>[\s\S]*?<\/details>\s*$/;
const AI_FIX_CONTEXT = /^\*\*Context:\*\*[^\n]*\n\s*\n?/;

/** Removes either the current details prompt or the legacy plain-text footer. */
export function removeAiFixFooter(body: string): string {
  const details = body.match(AI_FIX_DETAILS);
  if (details) {
    const content = details[0]
      .replace(/^<details>\s*<summary>Prompt to fix with AI<\/summary>\s*/, "")
      .replace(/<\/details>\s*$/, "")
      .replace(AI_FIX_CONTEXT, "")
      .replace(AI_FIX_FOOTER, "")
      .trim();
    return `${body.slice(0, body.length - details[0].length)}${content}`.trimEnd();
  }
  return body.split(AI_FIX_FOOTER).join("").replace(/\n{3,}/g, "\n\n").trimEnd();
}

/**
 * Neutralizes details/summary tags in model-controlled text so they render as
 * literal text and cannot open or close the wrapper early. The zero-width
 * space keeps the visible text unchanged.
 */
function neutralizeDetailsTags(text: string): string {
  return text.replace(/<(\/?)(details|summary)(\s[^>]*)?>/gi, (tag) => tag.replace(/^</, "<\u200b"));
}

/** Renders a copyable, self-contained prompt for one actionable finding. */
export function renderAiFixPrompt(context: AiFixContext, body: string): string {
  const cleanBody = neutralizeDetailsTags(removeAiFixFooter(body));
  const details = [
    `<details>`,
    `<summary>Prompt to fix with AI</summary>`,
    ``,
    `**Context:** \`${context.file}:${context.line}\`${context.side ? ` · ${context.side}` : ""}${context.severity ? ` · ${context.severity}` : ""}`,
    ``,
    cleanBody,
    ``,
    AI_FIX_FOOTER,
    ``,
    `</details>`,
  ];
  return details.join("\n");
}

/** Appends the shared fix instruction without duplicating an existing footer. */
export function appendAiFixFooter(body: string): string {
  const withoutExistingFooter = removeAiFixFooter(body);
  return `${withoutExistingFooter}\n\n${AI_FIX_FOOTER}`;
}
