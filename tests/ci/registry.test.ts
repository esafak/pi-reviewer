import { describe, expect, it, vi } from "vite-plus/test";
import { createRegistryClient } from "../../src/ci/registry/client.js";
import { MAX_RESPONSE_BYTES } from "../../src/ci/registry/helpers.js";
import {
  createRegistryProvider,
  registryProjectionInternals,
} from "../../src/ci/registry/providers.js";
import { createRegistryTools, lookupSchema } from "../../src/ci/registry/tool.js";

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

describe("registry providers", () => {
  it("uses PyPI's release endpoint and drops unbounded and unknown fields", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        info: {
          name: "demo",
          version: "1.2.3",
          summary: "summary",
          description: "huge",
          requires_dist: ["dep>=1"],
        },
        urls: [
          {
            filename: "demo.whl",
            packagetype: "bdist_wheel",
            yanked: false,
            digests: { sha256: "abc", md5: "ignored" },
            ignored: "x",
          },
        ],
        vulnerabilities: [{ id: "PYSEC-1", summary: "bad", details: "omit" }],
        releases: { all: "omit" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await createRegistryProvider("python").lookup(
      { ecosystem: "python", name: "demo", version: "1.2.3" },
      AbortSignal.timeout(1000),
    );
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://pypi.org/pypi/demo/1.2.3/json");
    expect(result).toEqual({
      info: { name: "demo", version: "1.2.3", summary: "summary", requires_dist: ["dep>=1"] },
      urls: [
        {
          filename: "demo.whl",
          packagetype: "bdist_wheel",
          yanked: false,
          digests: { sha256: "abc" },
        },
      ],
      vulnerabilities: [{ id: "PYSEC-1", summary: "bad" }],
    });
    vi.unstubAllGlobals();
  });

  it("constructs Maven Central selectors and caps returned rows", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        response: {
          numFound: 1,
          docs: [{ g: "org.demo", a: "lib", v: "2", p: "jar", l: "sources", secret: "drop" }],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await createRegistryProvider("java").lookup(
      {
        ecosystem: "java",
        name: "org.demo:lib",
        version: "2",
        packaging: "jar",
        classifier: "sources",
        rows: 99,
      },
      AbortSignal.timeout(1000),
    );
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.origin).toBe("https://search.maven.org");
    expect(url.searchParams.get("q")).toBe("g:org.demo AND a:lib AND v:2 AND p:jar AND l:sources");
    expect(url.searchParams.get("core")).toBe("gav");
    expect(url.searchParams.get("rows")).toBe("5");
    expect(result).toEqual({
      response: {
        numFound: 1,
        docs: [{ g: "org.demo", a: "lib", v: "2", p: "jar", l: "sources" }],
      },
    });
    vi.unstubAllGlobals();
  });

  it("projects crates.io crate and exact-version data without ID arrays or descriptions", async () => {
    const result = registryProjectionInternals.projectCrate({
      crate: {
        id: "serde",
        name: "serde",
        description: "x".repeat(1000),
        max_version: "1",
        num_versions: 9,
        versions: [123, 456],
        unknown: true,
      },
      version: {
        num: "1.0.0",
        yanked: false,
        license: "MIT",
        rust_version: "1.60",
        checksum: "abc",
        features: { std: [], extra: ["std"] },
        description: "omit",
      },
    });
    expect(result).toMatchObject({
      crate: {
        id: "serde",
        name: "serde",
        description: "x".repeat(600),
        max_version: "1",
        num_versions: 9,
      },
      version: {
        num: "1.0.0",
        yanked: false,
        license: "MIT",
        rust_version: "1.60",
        checksum: "abc",
        features: { std: [], extra: ["std"] },
      },
    });
    expect((result as any).crate).not.toHaveProperty("versions");
    expect(JSON.stringify(result)).not.toContain("unknown");
  });

  it("queries crates.io exact version endpoint with crawler user agent", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ crate: { name: "serde" }, version: { num: "1.0.0" } }));
    vi.stubGlobal("fetch", fetchMock);
    await createRegistryProvider("rust").lookup(
      { ecosystem: "rust", name: "serde", version: "1.0.0" },
      AbortSignal.timeout(1000),
    );
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://crates.io/api/v1/crates/serde/1.0.0");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      redirect: "error",
      headers: { "user-agent": expect.stringContaining("pi-reviewer") },
    });
    vi.unstubAllGlobals();
  });

  it("uses the abbreviated npm packument for name-only lookups and version documents for exact versions", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({ name: "@scope/pkg", "dist-tags": { latest: "3.0.0" }, versions: { huge: "omit" } }),
      )
      .mockResolvedValueOnce(
        json({
          name: "@scope/pkg",
          version: "3.0.0",
          description: "pkg",
          license: "MIT",
          dependencies: { dep: "^1" },
          engines: { node: ">=20" },
          deprecated: "old",
          readme: "omit",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const provider = createRegistryProvider("javascript");
    const latest = await provider.lookup(
      { ecosystem: "javascript", name: "@scope/pkg" },
      AbortSignal.timeout(1000),
    );
    const exact = await provider.lookup(
      { ecosystem: "javascript", name: "@scope/pkg", version: "3.0.0" },
      AbortSignal.timeout(1000),
    );
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://registry.npmjs.org/%40scope%2fpkg");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: { accept: "application/vnd.npm.install-v1+json" },
    });
    expect(latest).toEqual({ name: "@scope/pkg", "dist-tags": { latest: "3.0.0" } });
    expect(exact).toEqual({
      name: "@scope/pkg",
      version: "3.0.0",
      description: "pkg",
      license: "MIT",
      dependencies: { dep: "^1" },
      engines: { node: ">=20" },
      deprecated: "old",
    });
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      "https://registry.npmjs.org/%40scope%2fpkg/3.0.0",
    );
    vi.unstubAllGlobals();
  });

  it("applies Go uppercase escaping before path encoding", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          Version: "v1.2.3",
          Time: "2026-01-01T00:00:00Z",
          Origin: { VCS: "git", URL: "https://example.test", Hash: "abc", Ref: "tag" },
          ignored: true,
        }),
      )
      .mockResolvedValueOnce(json({ Version: "v1.2.3", Time: "2026-01-01T00:00:00Z" }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createRegistryProvider("go");
    const result = await provider.lookup(
      { ecosystem: "go", name: "example.com/Mod/HTTP" },
      AbortSignal.timeout(1000),
    );
    await provider.lookup(
      { ecosystem: "go", name: "example.com/Mod/HTTP", version: "v1.2.3" },
      AbortSignal.timeout(1000),
    );
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://proxy.golang.org/example.com/!mod/!h!t!t!p/@latest",
    );
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      "https://proxy.golang.org/example.com/!mod/!h!t!t!p/@v/v1.2.3.info",
    );
    expect(result).toEqual({
      Version: "v1.2.3",
      Time: "2026-01-01T00:00:00Z",
      Origin: { VCS: "git", URL: "https://example.test", Hash: "abc", Ref: "tag" },
    });
    vi.unstubAllGlobals();
  });

  it("fails closed on oversized streamed response bodies and redirects", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES + 1));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status: 200 })),
    );
    await expect(
      createRegistryProvider("go").lookup(
        { ecosystem: "go", name: "example.com/mod" },
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow("byte limit");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 302 })),
    );
    await expect(
      createRegistryProvider("go").lookup(
        { ecosystem: "go", name: "example.com/mod" },
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow("302");
    vi.unstubAllGlobals();
  });

  it("honors the request abort signal", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockImplementation(
          async (_input, init) =>
            new Promise((_resolve, reject) =>
              init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
            ),
        ),
    );
    await expect(
      createRegistryProvider("go").lookup(
        { ecosystem: "go", name: "example.com/mod" },
        AbortSignal.timeout(1),
      ),
    ).rejects.toThrow("timed out");
    vi.unstubAllGlobals();
  });
});

describe("registry client and tool", () => {
  it("enforces lookup count, per-result output size, and aggregate output size", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      json({
        info: {
          name: "pkg",
          version: "1.0.0",
          requires_dist: Array.from({ length: 22 }, () => "x".repeat(250)),
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createRegistryClient();
    await client.lookup({ ecosystem: "python", name: "pkg" });
    await client.lookup({ ecosystem: "python", name: "pkg" });
    await expect(client.lookup({ ecosystem: "python", name: "pkg" })).rejects.toThrow(
      "aggregate output budget",
    );
    vi.unstubAllGlobals();
  });

  it("limits each run to five requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockImplementation(async () => json({ Version: "v1", Time: "2026-01-01" })),
    );
    const client = createRegistryClient();
    for (let i = 0; i < 5; i++)
      await client.lookup({ ecosystem: "go", name: `example.com/mod${i}` });
    await expect(client.lookup({ ecosystem: "go", name: "example.com/mod6" })).rejects.toThrow(
      "lookup budget",
    );
    vi.unstubAllGlobals();
  });

  it("exposes the flat schema and always includes one advisory lookup tool", () => {
    expect((lookupSchema as any).additionalProperties).toBe(false);
    expect((lookupSchema as any).properties.ecosystem.enum).toEqual([
      "python",
      "java",
      "rust",
      "javascript",
      "go",
    ]);
    const tools = createRegistryTools({ lookup: vi.fn() } as any);
    expect(tools.map((tool) => tool.name)).toEqual(["package_lookup"]);
  });

  it("returns registry-native JSON in an untrusted content block and rejects non-Maven filters", async () => {
    const lookup = vi
      .fn()
      .mockResolvedValue({ metadata: { info: { name: "example" } }, remainingLookups: 4 });
    const [tool] = createRegistryTools({ lookup } as any);
    const result = await tool.execute("id", { ecosystem: "python", name: "example" } as any);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining('"info"'),
    });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Untrusted") });
    await tool.execute("id", { ecosystem: "python", name: "example", rows: 2 } as any);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("does not return tool content over the model-facing result cap", async () => {
    const [tool] = createRegistryTools({
      lookup: vi.fn().mockResolvedValue({
        metadata: { info: { summary: "x".repeat(9_000) } },
        remainingLookups: 4,
      }),
    } as any);
    const result = await tool.execute("id", { ecosystem: "python", name: "example" } as any);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("byte limit") });
    expect(new TextEncoder().encode(result.content[0].text).byteLength).toBeLessThan(8 * 1024);
  });
});
