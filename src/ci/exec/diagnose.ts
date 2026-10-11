import { readFileSync } from "node:fs";

// Diagnosis for bubblewrap setup failures on confined runtimes. The slave
// error fires when bwrap remounts / as rslave before any argv mount op, so a
// container profile denying mount fails it before userns/network setup runs.
// The proc error fires later when bwrap mounts a fresh procfs inside a nested
// user namespace, which the kernel refuses with EPERM regardless of LSM
// policy. Both fixes live outside any job step.
export type BwrapConfinementKind = "apparmor-confined" | "seccomp-denied" | "proc-mount-denied";

export interface BwrapDiagnosis {
  kind: BwrapConfinementKind;
  profile?: string;
  hint: string;
}

export const BWRAP_SLAVE_ERROR = "Failed to make / slave";
export const BWRAP_PROC_ERROR = "Can't mount proc";

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

// The kernel denies fresh procfs instantiation from inside a nested user
// namespace with EPERM even when the AppArmor profile allows mount, so
// tmpfs mounts succeed while proc mounts fail and bind-reuse works. The
// runner retries with --ro-bind /proc (reusing the existing mount, PID
// isolation retained), so this hint only surfaces when the fallback also
// fails or a probe runs --proc directly.
const PROC_MOUNT_HINT =
  "containerized runner: bubblewrap cannot mount a fresh procfs inside its nested user namespace (bwrap: Can't mount proc on /newroot/proc: Operation not permitted). This is a kernel namespace restriction, not an AppArmor or seccomp denial; the runner falls back to a read-only reuse of /proc (PID isolation retained, pod process table readable). See CI.md Containerized self-hosted runners.";

// Matches bwrap's mount-propagation failure regardless of container runtime
// name (cri-containerd.apparmor.d, docker-default, custom). Errno wording
// distinguishes the denying layer: EACCES implies AppArmor, EPERM seccomp.
export function diagnoseBwrapFailure(
  stderr: string,
  apparmorProfile: string | undefined,
): BwrapDiagnosis | undefined {
  if (stderr.includes(BWRAP_SLAVE_ERROR)) {
    if (stderr.includes("Operation not permitted")) {
      return { kind: "seccomp-denied", profile: apparmorProfile, hint: SECCOMP_HINT };
    }
    return { kind: "apparmor-confined", profile: apparmorProfile, hint: APPARMOR_HINT };
  }
  if (stderr.includes(BWRAP_PROC_ERROR)) {
    return { kind: "proc-mount-denied", profile: apparmorProfile, hint: PROC_MOUNT_HINT };
  }
  return undefined;
}
