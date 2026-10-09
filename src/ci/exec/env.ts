// Shared secret scrubber for every sandbox backend. Names match anywhere in
// the variable name so credentials cannot smuggle through prefixes or
// suffixes alike; the per-backend allowlists stay the primary gate and this
// is defense in depth over the composed environment.
const SECRET_NAME_PATTERN = /(TOKEN|SECRET|PASSW|CREDENTIAL|PRIVATE|API[-_]?KEY|(^|_)KEY(_|$))/i;

export function isSecretEnvName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}

// Pick an explicit allowlist out of the host environment, dropping secrets.
// Every backend builds its sandbox environment through here so no backend
// can drift back to inheriting ambient credentials.
export function pickEnv(allow: ReadonlySet<string> | readonly string[]): Record<string, string> {
  const allowed = new Set<string>(allow as Iterable<string>);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (!allowed.has(key) && !allowed.has(key.toUpperCase())) continue;
    if (isSecretEnvName(key)) continue;
    env[key] = value;
  }
  return env;
}
