import { describe, expect, it } from "vite-plus/test";
import { findMirror } from "../../../src/ci/dependency/mirrors.js";
import { findToolSource } from "../../../src/ci/dependency/tool-sources.js";

describe("mirror table", () => {
  it("finds the mapping by the upstream's own identity", () => {
    expect(findMirror("go", "google.golang.org/protobuf")).toBe(
      "github.com/protocolbuffers/protobuf-go",
    );
    expect(findMirror("go", "golang.org/x/net")).toBe("github.com/golang/net");
  });

  it("normalizes a .git suffix and a trailing slash", () => {
    expect(findMirror("go", "golang.org/x/net.git")).toBe("github.com/golang/net");
    expect(findMirror("go", "golang.org/x/net/")).toBe("github.com/golang/net");
    // Either spelling may come last.
    expect(findMirror("go", "golang.org/x/net.git/")).toBe("github.com/golang/net");
  });

  it("never treats a nested path as its parent", () => {
    expect(findMirror("go", "golang.org/x/net/http2")).toBeUndefined();
    expect(findMirror("go", "google.golang.org/protobuf/protoc-gen-go")).toBeUndefined();
  });

  it("does not carry a mapping into another registry", () => {
    expect(findMirror("npm", "golang.org/x/net")).toBeUndefined();
  });
});

describe("tool source table", () => {
  it("resolves the core runtimes and the common tools", () => {
    expect(findToolSource("node")).toBe("nodejs/node");
    expect(findToolSource("python")).toBe("python/cpython");
    expect(findToolSource("go")).toBe("golang/go");
    expect(findToolSource("rust")).toBe("rust-lang/rust");
    expect(findToolSource("java")).toBe("openjdk/jdk");
    expect(findToolSource("ruby")).toBe("ruby/ruby");
    expect(findToolSource("pnpm")).toBe("pnpm/pnpm");
  });

  it("resolves an asdf plugin name to the tool's own repository", () => {
    // The asdf plugin's repository is the installer, not the tool.
    expect(findToolSource("nodejs")).toBe("nodejs/node");
    expect(findToolSource("golang")).toBe("golang/go");
  });

  it("leaves a tool it does not cover unresolved", () => {
    expect(findToolSource("atlassian.com/acli")).toBeUndefined();
    expect(findToolSource("")).toBeUndefined();
  });
});
