/**
 * The credential shapes the harness refuses to publish.
 *
 * The dependency prompt forbids reproducing a fetched page's text, and the
 * harness cannot verify that rule: a paraphrase carries a secret as surely as
 * a quotation does. The scan is therefore the harness's own, deterministic
 * check — narrow, on purpose.
 *
 * It reduces the risk of a secret reaching a public comment; it does not
 * eliminate it. A scan refuses a body it recognizes and publishes a body it
 * does not, so nothing in the code, the summary, or the documentation may
 * claim the review body is free of credentials.
 */

/** The credential shapes the scan recognizes, named so a log can say what it saw. */
export type CredentialShape =
  | "cloud access-key id"
  | "private-key header"
  | "secret-key assignment"
  | "bearer token"
  | "JWT";

/**
 * A cloud provider's access-key id: a fixed vendor prefix and a fixed-length
 * upper-case body. The shape is specific enough to refuse, because sixteen
 * upper-case characters and a vendor prefix do not occur in package prose.
 */
const ACCESS_KEY_ID = /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ABIA|ACCA)[0-9A-Z]{16}\b/;

/** The header a PEM private key opens with. */
const PRIVATE_KEY_HEADER = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

/**
 * A secret assignment written out: the key's name, then a value long enough to
 * be a credential rather than a placeholder.
 */
const SECRET_ASSIGNMENT =
  /\b(?:aws_secret_access_key|aws_session_token|secret[_-]?access[_-]?key|client[_-]?secret)\b\s*[:=]\s*["']?[A-Za-z0-9/+_-]{16,}/i;

/** An authorization header's bearer token. */
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}=*/;

/** A JSON Web Token: three base64url segments, the first a base64url JSON header. */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;

const SHAPES: ReadonlyArray<readonly [CredentialShape, RegExp]> = [
  ["cloud access-key id", ACCESS_KEY_ID],
  ["private-key header", PRIVATE_KEY_HEADER],
  ["secret-key assignment", SECRET_ASSIGNMENT],
  ["bearer token", BEARER_TOKEN],
  ["JWT", JWT],
];

/**
 * The first credential shape a text carries, or undefined when it carries
 * none the scan knows.
 */
export function findCredentialShape(text: string): CredentialShape | undefined {
  for (const [shape, pattern] of SHAPES) {
    if (pattern.test(text)) return shape;
  }
  return undefined;
}

/**
 * The text a reader sees in place of a value the scan refused.
 *
 * It says what happened without repeating the value, and it is owned by the
 * harness: a reader must be able to tell withheld text from model prose.
 */
export const WITHHELD_CREDENTIAL_TEXT = "withheld: the text carried a credential-shaped value";

/**
 * The text a reader may see.
 *
 * A value the scan recognizes is replaced rather than dropped, because the
 * harness still has to report that the value existed — an upgrade that stays
 * unverifiable, a disposition that stays named — and only the text may not
 * leave the runner.
 */
export function publishableText(text: string): string {
  return findCredentialShape(text) ? WITHHELD_CREDENTIAL_TEXT : text;
}
