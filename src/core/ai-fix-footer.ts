export const AI_FIX_FOOTER = "For each issue above, determine whether it is valid. If so, fix it iteratively with one reviewer agent until convergence.";

/** Appends the shared fix instruction without duplicating an existing footer. */
export function appendAiFixFooter(body: string): string {
  const withoutExistingFooter = body.split(AI_FIX_FOOTER).join("").replace(/\n{3,}/g, "\n\n").trimEnd();
  return `${withoutExistingFooter}\n\n${AI_FIX_FOOTER}`;
}
