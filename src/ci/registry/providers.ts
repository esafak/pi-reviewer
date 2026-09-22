import type { RegistryEcosystem, RegistryLookupParams, RegistryProvider } from "./types.js";
import {
  boundedArray,
  boundedRecord,
  boundedString,
  boundedStrings,
  isRecord,
  nestedProjection,
  optionalBoolean,
  optionalNumber,
  optionalString,
  optionalStringArray,
  requestJson,
} from "./helpers.js";

const sha256 = (value: unknown) =>
  isRecord(value) ? boundedRecord(value, { sha256: optionalString(128) }) : undefined;

function pypiInfo(value: unknown): Record<string, unknown> {
  const info = boundedRecord(value, {
    name: optionalString(200),
    version: optionalString(128),
    summary: optionalString(500),
    license: optionalString(300),
    license_expression: optionalString(200),
    requires_python: optionalString(200),
    requires_dist: optionalStringArray(30, 250),
    project_urls: (urls) => {
      if (!isRecord(urls)) return undefined;
      return Object.fromEntries(
        Object.entries(urls)
          .slice(0, 10)
          .flatMap(([key, url]) =>
            typeof url === "string" ? [[key.slice(0, 80), url.slice(0, 300)]] : [],
          ),
      );
    },
  });
  return info;
}

function pypiUrl(value: unknown): Record<string, unknown> {
  return boundedRecord(value, {
    filename: optionalString(200),
    packagetype: optionalString(40),
    python_version: optionalString(40),
    requires_python: optionalString(200),
    upload_time_iso_8601: optionalString(40),
    yanked: optionalBoolean,
    digests: sha256,
  });
}

function pypiVulnerability(value: unknown): Record<string, unknown> {
  return boundedRecord(value, {
    id: optionalString(100),
    aliases: optionalStringArray(10, 100),
    summary: optionalString(500),
    fixed_in: optionalStringArray(10, 100),
    link: optionalString(300),
    source: optionalString(80),
    withdrawn: optionalString(40),
  });
}

function projectPyPI(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) throw new Error("Registry response has an invalid shape");
  if (
    !isRecord(raw.info) ||
    typeof raw.info.name !== "string" ||
    typeof raw.info.version !== "string"
  )
    throw new Error("Registry response has an invalid shape");
  const output: Record<string, unknown> = {};
  if (raw.info !== undefined) output.info = pypiInfo(raw.info);
  if (raw.urls !== undefined) {
    output.urls = boundedArray(raw.urls, 10, pypiUrl) ?? [];
  }
  if (raw.vulnerabilities !== undefined) {
    output.vulnerabilities = boundedArray(raw.vulnerabilities, 10, pypiVulnerability) ?? [];
  }
  if (!output.info) throw new Error("Registry response has an invalid shape");
  return output;
}

function projectMaven(raw: unknown): Record<string, unknown> {
  if (
    !isRecord(raw) ||
    !isRecord(raw.response) ||
    typeof raw.response.numFound !== "number" ||
    !Array.isArray(raw.response.docs)
  )
    throw new Error("Registry response has an invalid shape");
  return {
    response: {
      numFound: typeof raw.response.numFound === "number" ? raw.response.numFound : 0,
      docs: raw.response.docs.slice(0, 5).map((doc) =>
        boundedRecord(doc, {
          id: optionalString(300),
          g: optionalString(200),
          a: optionalString(200),
          v: optionalString(128),
          p: optionalString(80),
          l: optionalString(80),
          latestVersion: optionalString(128),
          timestamp: optionalNumber,
          versionCount: optionalNumber,
        }),
      ),
    },
  };
}

function projectCrate(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw) || !isRecord(raw.crate) || typeof raw.crate.name !== "string")
    throw new Error("Registry response has an invalid shape");
  const crate = boundedRecord(raw.crate, {
    id: optionalString(200),
    name: optionalString(200),
    description: optionalString(600),
    repository: optionalString(300),
    homepage: optionalString(300),
    documentation: optionalString(300),
    downloads: optionalNumber,
    recent_downloads: optionalNumber,
    num_versions: optionalNumber,
    max_version: optionalString(128),
    newest_version: optionalString(128),
    most_recent_version: optionalString(128),
    max_stable_version: optionalString(128),
    default_version: optionalString(128),
    created_at: optionalString(40),
    updated_at: optionalString(40),
  });
  const output: Record<string, unknown> = { crate };
  if (raw.version !== undefined) {
    if (!isRecord(raw.version) || typeof raw.version.num !== "string")
      throw new Error("Registry response has an invalid shape");
    output.version = boundedRecord(raw.version, {
      num: optionalString(128),
      yanked: optionalBoolean,
      license: optionalString(200),
      rust_version: optionalString(50),
      checksum: optionalString(128),
      features: (value) => {
        if (!isRecord(value)) return undefined;
        return Object.fromEntries(
          Object.entries(value)
            .slice(0, 30)
            .map(([key, features]) => [key.slice(0, 100), boundedStrings(features, 20, 100) ?? []]),
        );
      },
      created_at: optionalString(40),
      downloads: optionalNumber,
      crate_size: optionalNumber,
    });
  }
  return output;
}

function projectNpm(raw: unknown, exactVersion: boolean): Record<string, unknown> {
  if (!isRecord(raw)) throw new Error("Registry response has an invalid shape");
  if (typeof raw.name !== "string" || (exactVersion && typeof raw.version !== "string"))
    throw new Error("Registry response has an invalid shape");
  if (!exactVersion) {
    return boundedRecord(raw, {
      name: optionalString(200),
      "dist-tags": (value) => {
        if (!isRecord(value)) return undefined;
        return Object.fromEntries(
          Object.entries(value)
            .slice(0, 20)
            .flatMap(([tag, version]) =>
              typeof version === "string" ? [[tag.slice(0, 80), version.slice(0, 128)]] : [],
            ),
        );
      },
    });
  }
  return boundedRecord(raw, {
    name: optionalString(200),
    version: optionalString(128),
    description: optionalString(600),
    license: (value) =>
      typeof value === "string"
        ? value.slice(0, 200)
        : nestedProjection(value, { type: optionalString(100), url: optionalString(300) }),
    dependencies: (value) => {
      if (!isRecord(value)) return undefined;
      return Object.fromEntries(
        Object.entries(value)
          .slice(0, 50)
          .map(([name, version]) => [name.slice(0, 120), boundedString(version, 120) ?? ""]),
      );
    },
    engines: (value) =>
      nestedProjection(value, { node: optionalString(100), npm: optionalString(100) }),
    deprecated: optionalString(400),
  });
}

function projectGo(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw) || typeof raw.Version !== "string" || typeof raw.Time !== "string")
    throw new Error("Registry response has an invalid shape");
  return boundedRecord(raw, {
    Version: optionalString(128),
    Time: optionalString(40),
    Origin: (value) =>
      nestedProjection(value, {
        VCS: optionalString(40),
        URL: optionalString(300),
        Hash: optionalString(128),
        Ref: optionalString(200),
      }),
  });
}

function encodeGoModulePath(path: string): string {
  const escaped = Array.from(path, (char) =>
    char >= "A" && char <= "Z" ? `!${char.toLowerCase()}` : char,
  ).join("");
  return escaped.split("/").map(encodeURIComponent).join("/");
}

function npmPath(name: string): string {
  return encodeURIComponent(name).replace(/%2F/giu, "%2f");
}

export function createRegistryProvider(ecosystem: RegistryEcosystem): RegistryProvider {
  return {
    async lookup(params: RegistryLookupParams, signal: AbortSignal) {
      if (ecosystem === "python") {
        const suffix = params.version ? `/${encodeURIComponent(params.version)}` : "";
        const raw = await requestJson(
          new URL(`https://pypi.org/pypi/${encodeURIComponent(params.name)}${suffix}/json`),
          signal,
        );
        return projectPyPI(raw);
      }
      if (ecosystem === "java") {
        const coordinate = params.name.split(":");
        if (coordinate.length !== 2 || coordinate.some((part) => !part))
          throw new Error("Maven package name must be group:artifact");
        const url = new URL("https://search.maven.org/solrsearch/select");
        const query = [`g:${coordinate[0]}`, `a:${coordinate[1]}`];
        if (params.version) query.push(`v:${params.version}`);
        if (params.packaging) query.push(`p:${params.packaging}`);
        if (params.classifier) query.push(`l:${params.classifier}`);
        url.searchParams.set("q", query.join(" AND "));
        url.searchParams.set("rows", String(Math.min(params.rows ?? 5, 5)));
        url.searchParams.set("wt", "json");
        if (params.version) url.searchParams.set("core", "gav");
        return projectMaven(await requestJson(url, signal));
      }
      if (ecosystem === "rust") {
        const name = encodeURIComponent(params.name);
        const suffix = params.version ? `/${encodeURIComponent(params.version)}` : "";
        const raw = await requestJson(
          new URL(`https://crates.io/api/v1/crates/${name}${suffix}`),
          signal,
          {
            "user-agent": "pi-reviewer (https://github.com/esafak/pi-reviewer)",
          },
        );
        return projectCrate(raw);
      }
      if (ecosystem === "javascript") {
        const packagePath = npmPath(params.name);
        const url = params.version
          ? new URL(
              `https://registry.npmjs.org/${packagePath}/${encodeURIComponent(params.version)}`,
            )
          : new URL(`https://registry.npmjs.org/${packagePath}`);
        return projectNpm(
          await requestJson(url, signal, { accept: "application/vnd.npm.install-v1+json" }),
          Boolean(params.version),
        );
      }
      const path = encodeGoModulePath(params.name);
      const version = params.version ? `@v/${encodeGoModulePath(params.version)}` : "@latest";
      return projectGo(
        await requestJson(new URL(`https://proxy.golang.org/${path}/${version}.info`), signal),
      );
    },
  };
}

export const registryProjectionInternals = {
  projectPyPI,
  projectMaven,
  projectCrate,
  projectNpm,
  projectGo,
  encodeGoModulePath,
};
