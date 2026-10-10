# pi-reviewer runner AppArmor profile

Containerized ARC runners deny `mount` by default, so `bwrap` fails with
`Failed to make / slave` before userns/network setup runs. This folder ships
the pod-level fix (job steps cannot change the container's profile).

1. Load: apply `daemonset.yaml` (or bake `pi-reviewer-runner` into the node
   image). Verify on a node: `aa-status | grep pi-reviewer-runner`.
2. Reference from the runner pod (K8s 1.31+):
   `securityContext.appArmorProfile: { type: Localhost, localhostProfile: pi-reviewer-runner }`.
   Older clusters use the annotation
   `container.apparmor.security.beta.kubernetes.io/<container>: localhost/pi-reviewer-runner`.
3. If the profile isn't loaded, pods fail to start rather than running
   unconfined — that missing-profile start error is the signal the load step
   was skipped.

Full diagnosis steps are in `CI.md` under Containerized self-hosted runners.
