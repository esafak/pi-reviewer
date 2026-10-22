import { describe, expect, it, vi } from "vite-plus/test";
import { expandVersionRecords, fetchPackageSource } from "../../../src/ci/registry/source.js";

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
const text = (value: string) => new Response(value, { status: 200 });

const request = () => ({ signal: AbortSignal.timeout(1000), charge: () => {} });

describe("registry source lookups", () => {
  it("reads the npm current version document, which carries the repository", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        name: "react",
        version: "19.3.1",
        repository: { type: "git", url: "git+https://github.com/facebook/react.git" },
        homepage: "https://react.dev/",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchPackageSource("npm", "react", request());
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://registry.npmjs.org/react/latest");
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      headers: { accept: "application/json" },
    });
    expect(result.locations).toEqual([
      "git+https://github.com/facebook/react.git",
      "https://react.dev/",
    ]);
    vi.unstubAllGlobals();
  });

  it("reads the PyPI project URLs, preferring the source", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        info: {
          name: "demo",
          version: "1.0.0",
          project_urls: {
            Documentation: "https://docs.example",
            Source: "https://github.com/example/demo",
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchPackageSource("pypi", "demo", request());
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://pypi.org/pypi/demo/json");
    expect(result.locations).toEqual(["https://github.com/example/demo", "https://docs.example"]);
    vi.unstubAllGlobals();
  });

  it("reads the crates.io repository and homepage", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        crate: { name: "serde", repository: "https://github.com/serde-rs/serde", homepage: "" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchPackageSource("crates", "serde", request());
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://crates.io/api/v1/crates/serde");
    expect(result.locations).toEqual(["https://github.com/serde-rs/serde"]);
    vi.unstubAllGlobals();
  });

  it("reads the Go module proxy origin URL", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        Version: "v0.20.0",
        Time: "2026-01-01T00:00:00Z",
        Origin: { VCS: "git", URL: "https://go.googlesource.com/net", Hash: "abc", Ref: "tag" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchPackageSource("go", "golang.org/x/net", request());
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://proxy.golang.org/golang.org/x/net/@latest",
    );
    expect(result.locations).toEqual(["https://go.googlesource.com/net"]);
    vi.unstubAllGlobals();
  });

  it("reads the Maven POM for the artifact's current published version", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          response: { numFound: 1, docs: [{ g: "org.demo", a: "lib", latestVersion: "2.0.0" }] },
        }),
      )
      .mockResolvedValueOnce(
        text(
          `<project><scm><url>https://github.com/example/demo</url></scm><organization><url>https://example.org</url></organization></project>`,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchPackageSource("maven", "org.demo:lib", request());
    const pomUrl = new URL(String(fetchMock.mock.calls[1]![0]));
    expect(pomUrl.origin).toBe("https://search.maven.org");
    expect(pomUrl.searchParams.get("filepath")).toBe("org/demo/lib/2.0.0/lib-2.0.0.pom");
    expect(result.locations).toEqual(["https://github.com/example/demo", "https://example.org"]);
    vi.unstubAllGlobals();
  });

  it("yields no Maven candidate when the POM carries no URL of its own", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          response: { numFound: 1, docs: [{ g: "org.demo", a: "lib", latestVersion: "2.0.0" }] },
        }),
      )
      .mockResolvedValueOnce(text("<project><artifactId>lib</artifactId></project>"));
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchPackageSource("maven", "org.demo:lib", request());
    expect(result.locations).toEqual([]);
    expect(result.reason).toContain("no source URL");
    vi.unstubAllGlobals();
  });

  it("follows the Maven Central redirect to an allowed host and refuses the rest", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          response: { numFound: 1, docs: [{ g: "org.demo", a: "lib", latestVersion: "2.0.0" }] },
        }),
      )
      .mockResolvedValueOnce(
        new Response("", {
          status: 301,
          headers: { location: "https://repo1.maven.org/maven2/org/demo/lib/2.0.0/lib-2.0.0.pom" },
        }),
      )
      .mockResolvedValueOnce(
        text("<project><scm><url>https://github.com/example/demo</url></scm></project>"),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchPackageSource("maven", "org.demo:lib", request());
    expect(String(fetchMock.mock.calls[2]![0])).toBe(
      "https://repo1.maven.org/maven2/org/demo/lib/2.0.0/lib-2.0.0.pom",
    );
    expect(result.locations).toEqual(["https://github.com/example/demo"]);
    vi.unstubAllGlobals();

    const escaping = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          response: { numFound: 1, docs: [{ g: "org.demo", a: "lib", latestVersion: "2.0.0" }] },
        }),
      )
      .mockResolvedValueOnce(
        new Response("", { status: 301, headers: { location: "https://evil.example/lib.pom" } }),
      );
    vi.stubGlobal("fetch", escaping);
    await expect(fetchPackageSource("maven", "org.demo:lib", request())).rejects.toThrow(
      "allowed hosts",
    );
    vi.unstubAllGlobals();
  });

  it("reads the NuGet catalog entry through the registration pages", async () => {
    const catalogId =
      "https://api.nuget.org/v3/catalog0/data/2026.01.01/newtonsoft.json.13.0.3.json";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          items: [
            {
              "@id":
                "https://api.nuget.org/v3/registration5-gz-semver2/newtonsoft.json/page/1.0.0/2.0.0.json",
              items: [],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        json({
          items: [
            {
              catalogEntry: {
                "@id": catalogId,
                version: "13.0.3",
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        json({
          id: "Newtonsoft.Json",
          version: "13.0.3",
          projectUrl: "https://www.newtonsoft.com/json",
          repository: { type: "git", url: "https://github.com/JamesNK/Newtonsoft.Json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchPackageSource("nuget", "Newtonsoft.Json", request());
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://api.nuget.org/v3/registration5-gz-semver2/newtonsoft.json/index.json",
    );
    expect(String(fetchMock.mock.calls[2]![0])).toBe(catalogId);
    expect(result.locations).toEqual([
      "https://github.com/JamesNK/Newtonsoft.Json",
      "https://www.newtonsoft.com/json",
    ]);
    vi.unstubAllGlobals();
  });

  it("reads a non-GitHub NuGet location as a location", async () => {
    const catalogId = "https://api.nuget.org/v3/catalog0/data/2026.01.01/demo.json.1.0.0.json";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          items: [
            {
              "@id": "https://api.nuget.org/v3/registration5-gz-semver2/demo/index.json",
              items: [{ catalogEntry: { "@id": catalogId, version: "1.0.0" } }],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(json({ projectUrl: "https://codeberg.org/example/demo" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchPackageSource("nuget", "Demo", request());
    expect(result.locations).toEqual(["https://codeberg.org/example/demo"]);
    vi.unstubAllGlobals();
  });

  it("reads the RubyGems source and homepage", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        name: "rails",
        version: "8.1.4",
        source_code_uri: "https://github.com/rails/rails/tree/v8.1.4",
        homepage_uri: "https://rubyonrails.org",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchPackageSource("rubygems", "rails", request());
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://rubygems.org/api/v1/gems/rails.json");
    expect(result.locations).toEqual([
      "https://github.com/rails/rails/tree/v8.1.4",
      "https://rubyonrails.org",
    ]);
    vi.unstubAllGlobals();
  });

  it("reads the Packagist source and selects the current version out of the array", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        packages: {
          "monolog/monolog": [
            {
              name: "monolog/monolog",
              version: "3.12.1",
              homepage: "https://github.com/Seldaek/monolog",
              source: { type: "git", url: "https://github.com/Seldaek/monolog.git" },
            },
            {
              name: "monolog/monolog",
              version: "3.12.0",
              homepage: "https://github.com/Seldaek/monolog",
              source: { type: "git", url: "https://github.com/Seldaek/monolog.git" },
            },
          ],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchPackageSource("packagist", "monolog/monolog", request());
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://repo.packagist.org/p2/monolog/monolog.json",
    );
    expect(result.locations).toEqual([
      "https://github.com/Seldaek/monolog.git",
      "https://github.com/Seldaek/monolog",
    ]);
    vi.unstubAllGlobals();
  });

  it("selects the record of the current version, not another one", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        packages: {
          "demo/demo": [
            {
              name: "demo/demo",
              version: "2.0.0",
              source: { type: "git", url: "https://github.com/example/demo.git" },
            },
            {
              name: "demo/demo",
              version: "1.0.0",
              source: { type: "git", url: "https://github.com/example/old-demo.git" },
            },
          ],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchPackageSource("packagist", "demo/demo", request());
    // The lookup is version-independent, so the current version is the one
    // the metadata lists first.
    expect(result.locations).toEqual(["https://github.com/example/demo.git"]);
    vi.unstubAllGlobals();
  });

  it("expands the fields a Packagist record inherits from the entry before it", () => {
    const expanded = expandVersionRecords([
      { name: "demo/demo", version: "2.0.0", source: { url: "https://example/2.git" } },
      { name: "demo/demo", version: "1.0.0" },
    ]);
    expect(expanded).toHaveLength(2);
    // The second record inherits the fields it did not repeat.
    expect(expanded[1]).toMatchObject({
      version: "1.0.0",
      source: { url: "https://example/2.git" },
    });
    expect(expanded[0]).toMatchObject({ source: { url: "https://example/2.git" } });
  });

  it("refuses a POM that is not valid UTF-8 rather than repairing it", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          response: { numFound: 1, docs: [{ g: "org.demo", a: "lib", latestVersion: "2.0.0" }] },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          new Uint8Array([
            ...Buffer.from("<project><organization><url>https://example.org/rel"),
            0xff,
            ...Buffer.from("notes</url></organization></project>"),
          ]),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchPackageSource("maven", "org.demo:lib", request())).rejects.toThrow(
      "not valid UTF-8",
    );
    vi.unstubAllGlobals();
  });

  it("reads the repository an aqua recipe names", async () => {
    let charged = 0;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        text(
          [
            "packages:",
            "  - type: github_release",
            "    repo_owner: cli",
            "    repo_name: cli",
            "    version_source: github_tag",
          ].join("\n"),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchPackageSource("aqua", "cli/cli", {
      signal: AbortSignal.timeout(1000),
      charge: () => {
        charged += 1;
      },
    });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://raw.githubusercontent.com/aquaproj/aqua-registry/main/pkgs/cli/cli/registry.yaml",
    );
    expect(result.locations).toEqual(["https://github.com/cli/cli"]);
    // The lookup costs one request of the run's budget.
    expect(charged).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("reports no source for an aqua recipe that names no repository", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        text(["packages:", "  - type: http", "    url: https://example.test"].join("\n")),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchPackageSource("aqua", "example.test/tool", request());
    expect(result.locations).toEqual([]);
    expect(result.reason).toContain("names no repository");
    vi.unstubAllGlobals();
  });

  it("reports no source for an aqua recipe it could not read", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(text("packages: [unclosed"));
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchPackageSource("aqua", "cli/cli", request());
    expect(result.locations).toEqual([]);
    expect(result.reason).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("refuses a redirect that leaves the secure transport", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://raw.githubusercontent.com/aquaproj/registry.yaml" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchPackageSource("aqua", "cli/cli", request())).rejects.toThrow(
      "secure transport",
    );
    // The forbidden hop was never contacted.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("does not ask the registry for a recipe name that is not a path", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(text("packages: []"));
    vi.stubGlobal("fetch", fetchMock);
    for (const name of [
      "node",
      "../../etc/passwd",
      "cli/../cli",
      "cli/cli/extra/more/deep/deeper/deepest",
      `cli/${"x".repeat(300)}`,
    ]) {
      const result = await fetchPackageSource("aqua", name, request());
      expect(result.locations, name).toEqual([]);
      expect(result.reason, name).toContain("not a registry path");
    }
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("reads a recipe whose path is nested", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        text(
          [
            "packages:",
            "  - type: github_release",
            "    repo_owner: golang",
            "    repo_name: tools",
          ].join("\n"),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchPackageSource("aqua", "golang.org/x/tools/gopls", request());
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://raw.githubusercontent.com/aquaproj/aqua-registry/main/pkgs/golang.org/x/tools/gopls/registry.yaml",
    );
    expect(result.locations).toEqual(["https://github.com/golang/tools"]);
    vi.unstubAllGlobals();
  });

  it("drops a source that does not fit rather than shortening it", async () => {
    const long = `https://github.com/example/${"d".repeat(400)}`;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json({ name: "demo", version: "1.0.0", repository: long, homepage: long }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchPackageSource("npm", "demo", request());
    // A shortened location is a different location, so the source is unknown
    // rather than wrong.
    expect(result.locations).toEqual([]);
    expect(result.reason).toContain("no repository or homepage");
    vi.unstubAllGlobals();
  });

  it("drops a Maven version that does not fit rather than shortening it", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        response: {
          numFound: 1,
          docs: [{ g: "org.demo", a: "lib", latestVersion: "2".repeat(200) }],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchPackageSource("maven", "org.demo:lib", request());
    expect(result.locations).toEqual([]);
    expect(result.reason).toContain("no published version");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
