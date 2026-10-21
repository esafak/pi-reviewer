import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import type { ExecFileException, ExecFileOptions } from "node:child_process";
import type { NonSharedBuffer } from "node:buffer";
import { execFile } from "node:child_process";
import { resolveSshState } from "../../src/core/ssh.js";

const execFileMock = vi.mocked(execFile);

function mockSsh(output: string): void {
  execFileMock.mockImplementation(
    (
      _file: string,
      _args: readonly string[] | null | undefined,
      _options: ExecFileOptions | null | undefined,
      callback:
        | ((
            error: ExecFileException | null,
            stdout: string | NonSharedBuffer,
            stderr: string | NonSharedBuffer,
          ) => void)
        | null
        | undefined,
    ) => {
      callback?.(null, output, "");
      return undefined as never;
    },
  );
}

beforeEach(() => {
  execFileMock.mockReset();
});

describe("resolveSshState", () => {
  it("resolves the cwd to a physical path", async () => {
    mockSsh("/physical/root\n");

    const state = await resolveSshState("user@host");

    expect(execFileMock).toHaveBeenCalledWith(
      "ssh",
      ["user@host", "pwd -P"],
      expect.anything(),
      expect.any(Function),
    );
    expect(state).toEqual({ remote: "user@host", remoteCwd: "/physical/root" });
  });

  it("resolves a user@host:/path cwd to a physical path", async () => {
    mockSsh("/physical/root/sub\n");

    const state = await resolveSshState("user@host:/outer/sub");

    expect(execFileMock).toHaveBeenCalledWith(
      "ssh",
      ["user@host", "cd /outer/sub && pwd -P"],
      expect.anything(),
      expect.any(Function),
    );
    expect(state).toEqual({ remote: "user@host", remoteCwd: "/physical/root/sub" });
  });
});
