/**
 * Escapes the markup delimiters a prompt section is fenced with.
 *
 * The sections are fenced with angle brackets, and untrusted text — a pull
 * request title, a manifest value, a skill body — must not be able to close
 * a section and speak for the harness. Escaping the delimiters keeps the
 * text inside the section it was put in.
 *
 * It lives in a module of its own because both the prompt builder and the
 * dependency section need it, and a shared helper that one of them imports
 * back would make the two modules depend on each other.
 */
export function escapePromptMarkup(value: string): string {
  return value.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}
