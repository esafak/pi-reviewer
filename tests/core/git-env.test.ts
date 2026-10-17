import { describe, expect, it } from "vite-plus/test";

import { gitEnv } from "../../src/core/git-env.js";

describe("gitEnv", () => {
  it("strips repository redirection while keeping the rest of the environment", () => {
    const env = gitEnv({
      PATH: "/usr/bin",
      HOME: "/home/user",
      GIT_DIR: "/somewhere/else/.git",
      GIT_WORK_TREE: "/somewhere/else",
      GIT_PREFIX: "sub/",
      GIT_CEILING_DIRECTORIES: "/tmp",
      GIT_COMMON_DIR: "/somewhere/else/.git",
      GIT_INDEX_FILE: "/somewhere/else/index",
    });

    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/user" });
  });

  it("drops undefined values", () => {
    expect(gitEnv({ PATH: undefined, HOME: "/home/user" })).toEqual({ HOME: "/home/user" });
  });
});
