import { readFileSync } from "node:fs";

// Diagnosis for bubblewrap's mount-namespace setup failure on confined
// runtimes. bwrap remounts / as rslave before any argv mount op, so a
// container profile denying mount fails it before userns/network setup runs.
// The fix lives in the pod spec, never in a job step.
export type BwrapConfinementKind = "apparmor-confined" | "seccomp-denied";

export interface BwrapDiagnosis {
  kind: BwrapConfinementKind;
  profile?: string;
  hint: string;
}

export const BWRAP_SLAVE_ERROR = "Failed to make / slave";

// Reads the caller's own AppArmor confinement, if any. Best-effort: missing
// or unreadable confinement means unknown, never an error.
export function readApparmorProfile(
  readFile: () => string = () => readFileSync("/proc/self/attr/current", "utf8"),
): string | undefined {
  try {
    const raw = readFile().trim();
    if (!raw) return undefined;
    // Kernels append " (enforce)" / " (complain)"; the profile name precedes it.
    const name = raw.split(" ")[0]?.trim();
    if (!name) return undefined;
    return name;
  } catch {
    return undefined;
  }
}

const APPARMOR_HINT =
  "containerized runner: bubblewrap cannot create its mount namespace under the container's AppArmor profile (bwrap: Failed to make / slave). Configure a pod-level AppArmor profile that allows mount/userns; see CI.md Containerized self-hosted runners.";

const SECCOMP_HINT =
  "containerized runner: bubblewrap cannot create its mount namespace under the container's seccomp profile (bwrap: Failed to make / slave, Operation not permitted). Configure securityContext.seccompProfile to allow mount; see CI.md Containerized self-hosted runners.";

// Matches bwrap's mount-propagation failure regardless of container runtime
// name (cri-containerd.apparmor.d, docker-default, custom). Errno wording
// distinguishes the denying layer: EACCES implies AppArmor, EPERM seccomp.
export function diagnoseBwrapFailure(
  stderr: string,
  apparmorProfile: string | undefined,
): BwrapDiagnosis | undefined {
  if (!stderr.includes(BWRAP_SLAVE_ERROR)) return undefined;
  if (stderr.includes("Operation not permitted")) {
    return { kind: "seccomp-denied", profile: apparmorProfile, hint: SECCOMP_HINT };
  }
  return { kind: "apparmor-confined", profile: apparmorProfile, hint: APPARMOR_HINT };
}
