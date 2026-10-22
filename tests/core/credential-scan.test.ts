import { describe, expect, it } from "vite-plus/test";

import { findCredentialShape } from "../../src/core/credential-scan.js";

/**
 * The scan is a boundary, so its tests pin both directions: the shapes it must
 * refuse, and the package prose that must pass. A scan that refused ordinary
 * release-note text would fail the analysis it protects.
 */
describe("findCredentialShape", () => {
  it.each([
    ["cloud access-key id", "the notes showed AKIAIOSFODNN7EXAMPLE in the example"],
    ["private-key header", "-----BEGIN RSA PRIVATE KEY-----\nMIIE"],
    ["secret-key assignment", "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG"],
    ["bearer token", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345"],
    [
      "JWT",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ],
  ])("recognizes %s", (shape, text) => {
    expect(findCredentialShape(text)).toBe(shape);
  });

  it.each([
    "React 19 removed `createRoot` from react-dom and replaced it with `createRoot2`.",
    "AKIA is the prefix this release note is talking about.",
    "The changelog mentions SECRET_ACCESS_KEY_LIMIT without a value.",
  ])("publishes prose the scan does not recognize: %s", (text) => {
    expect(findCredentialShape(text)).toBeUndefined();
  });
});
