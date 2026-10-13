import { hasControlCharacters } from "../registry/helpers.js";
import {
  createGhRunner,
  GH_TIMEOUT_MS,
  GH_WALL_MS,
  MAX_GH_REQUESTS,
  MAX_GH_RESULT_BYTES,
  MAX_GH_TOTAL_BYTES,
} from "./gh-runner.js";

export type GitHubResearchScope = "public" | "token-accessible";
export type GitHubSearchKind =
  | "repositories"
  | "code"
  | "pull_requests"
  | "issues"
  | "runs"
  | "workflows"
  | "releases";
export type GitHubReadKind =
  | "file"
  | "pull_request"
  | "issue"
  | "discussion"
  | "run"
  | "workflow"
  | "release"
  | "repository"
  | "diff"
  | "checks"
  | "status";
export interface GitHubResearchClient {
  search(kind: GitHubSearchKind, query: string, limit: number): Promise<Record<string, unknown>>;
  read(params: {
    kind: GitHubReadKind;
    owner: string;
    repo: string;
    path?: string;
    ref?: string;
    number?: number;
  }): Promise<Record<string, unknown>>;
}
// Keep these public research budgets sourced from the shared gh runner limits.
export const MAX_GITHUB_RESULT_BYTES = MAX_GH_RESULT_BYTES,
  MAX_GITHUB_TOTAL_BYTES = MAX_GH_TOTAL_BYTES,
  MAX_GITHUB_REQUESTS = MAX_GH_REQUESTS,
  GITHUB_REQUEST_TIMEOUT_MS = GH_TIMEOUT_MS,
  GITHUB_WALL_TIME_MS = GH_WALL_MS;
const listFields: Record<string, string> = {
  repositories: "name,fullName,description,url,visibility,defaultBranch",
  code: "path,repository,url",
  pull_requests: "number,title,state,url,repository,updatedAt",
  issues: "number,title,state,url,repository,updatedAt",
  runs: "databaseId,name,status,conclusion,url,headBranch,headSha",
  workflows: "id,name,state,path",
  releases: "tagName,name,isDraft,isLatest,publishedAt",
};
const searchCmd: Record<string, string> = {
  repositories: "repos",
  code: "code",
  pull_requests: "prs",
  issues: "issues",
  runs: "",
  workflows: "",
  releases: "",
};
const safeFailure = (e: unknown) =>
  Array.from(e instanceof Error ? e.message : "GitHub research failed", (c) =>
    c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c,
  )
    .join("")
    .replace(/(?:token|authorization|bearer)\s*[:=]?\s*\S+/gi, "[redacted]")
    .slice(0, 240);
const record = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    throw new Error("gh returned invalid JSON");
  }
};

export function createGitHubResearchClient(
  token: string,
  scope: GitHubResearchScope = "public",
  _now: () => number = Date.now,
  exec?: Parameters<typeof createGhRunner>[1],
): GitHubResearchClient {
  const gh = createGhRunner(token, exec);
  const call = async (args: string[]) => {
    try {
      return await gh(args);
    } catch (e) {
      throw new Error(safeFailure(e));
    }
  };
  const bounded = async (args: string[]) => {
    const value = record(await call(args));
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > MAX_GITHUB_RESULT_BYTES)
      throw new Error("GitHub research result exceeded the byte limit");
    return value;
  };
  return {
    async search(kind, query, limit) {
      if (
        !(kind in listFields) ||
        !query.trim() ||
        query.length > 256 ||
        hasControlCharacters(query) ||
        !Number.isInteger(limit) ||
        limit < 1
      )
        throw new Error("GitHub search query is invalid");
      const n = Math.min(limit, 5);
      let args: string[];
      const localKinds = kind === "runs" || kind === "workflows" || kind === "releases";
      if (localKinds && scope === "public") {
        // List commands infer their repository from cwd, so visibility must be resolved from that same checkout without -R.
        const currentRepository = await bounded([
          "repo",
          "view",
          "--json",
          "isPrivate,nameWithOwner",
        ]);
        if (
          !currentRepository ||
          typeof currentRepository !== "object" ||
          typeof (currentRepository as Record<string, unknown>).isPrivate !== "boolean" ||
          typeof (currentRepository as Record<string, unknown>).nameWithOwner !== "string"
        )
          throw new Error("Current repository visibility could not be verified");
        if ((currentRepository as { isPrivate: boolean }).isPrivate)
          throw new Error("Private repositories are unavailable in public scope");
      }
      if (searchCmd[kind])
        args = [
          "search",
          searchCmd[kind]!,
          query,
          "--limit",
          String(n),
          "--json",
          listFields[kind]!,
          "--jq",
          `.[:${n}]`,
        ];
      else if (kind === "runs")
        args = [
          "run",
          "list",
          "--limit",
          String(n),
          "--json",
          listFields[kind]!,
          "--jq",
          `.[:${n}]`,
        ];
      else if (kind === "workflows")
        args = ["workflow", "list", "--json", listFields[kind]!, "--jq", `.[:${n}]`];
      else
        args = [
          "release",
          "list",
          "--limit",
          String(n),
          "--json",
          listFields[kind]!,
          "--jq",
          `.[:${n}]`,
        ];
      let items = await bounded(args);
      if (!Array.isArray(items)) throw new Error("GitHub search returned an invalid response");
      if (localKinds) {
        const terms = query.trim().toLowerCase().split(/\s+/u);
        items = items.filter((item) => {
          if (!item || typeof item !== "object") return false;
          const row = item as Record<string, unknown>;
          const fields =
            kind === "runs"
              ? [row.name]
              : kind === "workflows"
                ? [row.name, row.path]
                : [row.name, row.tagName];
          const text = fields
            .filter((field): field is string => typeof field === "string")
            .join(" ")
            .toLowerCase();
          return terms.every((term) => text.includes(term));
        });
      } else if (scope === "public") {
        const visible = [];
        for (const item of items) {
          if (!item || typeof item !== "object") continue;
          const row = item as Record<string, any>;
          const name =
            typeof row.fullName === "string"
              ? row.fullName
              : typeof row.repository?.nameWithOwner === "string"
                ? row.repository.nameWithOwner
                : undefined;
          if (!name) {
            if (
              row.visibility === "PUBLIC" ||
              row.visibility === "public" ||
              row.isPrivate === false
            )
              visible.push(item);
            continue;
          }
          const privacy = String(await call(["api", `repos/${name}`, "--jq", ".private"])).trim();
          if (privacy === "false") visible.push(item);
        }
        items = visible;
      }
      const result = { kind, query, results: items };
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_GITHUB_RESULT_BYTES)
        throw new Error("GitHub research result exceeded the byte limit");
      return result;
    },
    async read(p) {
      if (!/^[A-Za-z0-9-]{1,39}$/.test(p.owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(p.repo))
        throw new Error("GitHub repository identifier is invalid");
      const repo = `${p.owner}/${p.repo}`,
        num = p.number;
      if (scope === "public") {
        const privacy = String(await call(["api", `repos/${repo}`, "--jq", ".private"])).trim();
        if (privacy !== "false")
          throw new Error("Private repositories are unavailable in public scope");
      }
      let result: unknown;
      if (p.kind === "repository")
        result = await bounded([
          "repo",
          "view",
          repo,
          "--json",
          "name,nameWithOwner,description,url,visibility,defaultBranchRef",
        ]);
      else if (p.kind === "pull_request") {
        if (!num) throw new Error("An issue number is required for this read");
        result = await bounded([
          "pr",
          "view",
          String(num),
          "--repo",
          repo,
          "--json",
          "number,title,body,state,url,headRefName,baseRefName,updatedAt,isDraft",
        ]);
      } else if (p.kind === "issue") {
        if (!num) throw new Error("An issue number is required for this read");
        result = await bounded([
          "issue",
          "view",
          String(num),
          "--repo",
          repo,
          "--json",
          "number,title,body,state,url,updatedAt",
        ]);
      } else if (p.kind === "file") {
        if (
          !p.path ||
          p.path.startsWith("-") ||
          p.path.includes("..") ||
          hasControlCharacters(p.path)
        )
          throw new Error("GitHub file path is invalid");
        const endpoint = `repos/${repo}/contents/${p.path.split("/").map(encodeURIComponent).join("/")}${p.ref ? `?ref=${encodeURIComponent(p.ref)}` : ""}`;
        const file = await bounded([
          "api",
          endpoint,
          "--jq",
          "{path:.path,url:.html_url,content:.content}",
        ]);
        if (
          !file ||
          typeof file !== "object" ||
          typeof (file as Record<string, unknown>).content !== "string"
        )
          throw new Error("GitHub file content is unavailable");
        const encoded = (file as Record<string, string>).content.replace(/\s/gu, "");
        if (
          !encoded ||
          encoded.length % 4 !== 0 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)
        )
          throw new Error("GitHub file content is invalid base64");
        result = {
          ...(file as Record<string, unknown>),
          content: Buffer.from(encoded, "base64").toString("utf8"),
        };
      } else if (p.kind === "diff") {
        if (!num) throw new Error("A pull request number is required for this read");
        result = await call(["pr", "diff", String(num), "--repo", repo]);
      } else if (p.kind === "checks")
        result = await bounded([
          "pr",
          "checks",
          String(num),
          "--repo",
          repo,
          "--json",
          "name,state,workflow",
        ]);
      else if (p.kind === "status")
        result = await bounded([
          "pr",
          "status",
          "--repo",
          repo,
          "--json",
          "createdAt,headRefName,isDraft,number,state,statusCheckRollup,title,url",
        ]);
      else if (p.kind === "run")
        result = await bounded([
          "run",
          "view",
          String(num),
          "--repo",
          repo,
          "--json",
          "databaseId,name,status,conclusion,url,headBranch,headSha",
        ]);
      else if (p.kind === "workflow")
        result = await bounded([
          "api",
          `repos/${repo}/actions/workflows/${num}`,
          "--jq",
          "{id,name,state,path,url,html_url}",
        ]);
      else if (p.kind === "release")
        result = await bounded([
          "api",
          `repos/${repo}/releases/${num}`,
          "--jq",
          // A single release payload has no reliable latest-release indicator, so omit isLatest.
          "{tagName:.tag_name,name,isDraft:.draft,url:.html_url,publishedAt:.published_at}",
        ]);
      else if (p.kind === "discussion") {
        if (!num) throw new Error("A discussion number is required for this read");
        result = await bounded([
          "api",
          `repos/${repo}/discussions/${num}`,
          "--jq",
          "{number,title,body,html_url,created_at,updated_at,category:.category.name,user:.user.login}",
        ]);
      } else throw new Error("Unsupported GitHub read kind");
      const text = typeof result === "string" ? result : JSON.stringify(result);
      if (Buffer.byteLength(text) > MAX_GITHUB_RESULT_BYTES)
        throw new Error("GitHub research result exceeded the byte limit");
      if (p.kind === "discussion") return { kind: p.kind, repository: repo, discussion: result };
      if (p.kind === "pull_request")
        return { kind: p.kind, repository: repo, pull_request: result };
      if (p.kind === "issue") return { kind: p.kind, repository: repo, issue: result };
      if (p.kind === "file" && result && typeof result === "object")
        return {
          kind: p.kind,
          repository: repo,
          ...(result as Record<string, unknown>),
          ref: p.ref,
        };
      return { kind: p.kind, repository: repo, result };
    },
  };
}
export { safeFailure };
