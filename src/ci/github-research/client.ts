import { hasControlCharacters, truncateUtf8WithMarker } from "../registry/helpers.js";
import { defaultCacheDir, MAX_RANGE_LINES, saveCachedFile } from "./cache.js";
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
export interface ReadParams {
  kind: GitHubReadKind;
  owner: string;
  repo: string;
  path?: string;
  ref?: string;
  number?: number;
  comments?: boolean;
  name_only?: boolean;
  branch?: string;
  log?: boolean;
  exit_status?: boolean;
  attempt?: number;
  offset?: number;
  limit?: number;
}
export interface GitHubResearchClient {
  search(
    kind: GitHubSearchKind,
    query: string,
    limit: number,
    options?: SearchOptions,
  ): Promise<Record<string, unknown>>;
  read(params: ReadParams): Promise<Record<string, unknown>>;
}
export interface SearchOptions {
  state?: "open" | "closed" | "merged" | "all";
  label?: string;
  assignee?: string;
  author?: string;
  search?: string;
  language?: string;
  match?: string;
  sort?: string;
  order?: "asc" | "desc";
  workflow?: string;
  branch?: string;
  status?: string;
  event?: string;
  all?: boolean;
  exclude_drafts?: boolean;
  exclude_prereleases?: boolean;
}
// Keep these public research budgets sourced from the shared gh runner limits.
export const MAX_GITHUB_RESULT_BYTES = MAX_GH_RESULT_BYTES,
  MAX_GITHUB_TOTAL_BYTES = MAX_GH_TOTAL_BYTES,
  MAX_GITHUB_REQUESTS = MAX_GH_REQUESTS,
  GITHUB_REQUEST_TIMEOUT_MS = GH_TIMEOUT_MS,
  GITHUB_WALL_TIME_MS = GH_WALL_MS;
const listFields: Record<GitHubSearchKind, string> = {
  // Search JSON uses fullName/defaultBranch; repo view uses nameWithOwner/defaultBranchRef below.
  repositories: "name,fullName,description,url,visibility,defaultBranch",
  code: "path,repository,url",
  pull_requests: "number,title,state,url,repository,updatedAt",
  issues: "number,title,state,url,repository,updatedAt",
  runs: "databaseId,name,status,conclusion,url,headBranch,headSha",
  workflows: "id,name,state,path",
  releases: "tagName,name,isDraft,isLatest,publishedAt",
};
const searchSorts: Record<GitHubSearchKind, readonly string[]> = {
  repositories: ["forks", "help-wanted-issues", "stars", "updated"],
  code: [],
  pull_requests: ["comments", "created", "interactions", "reactions", "updated"],
  issues: ["comments", "created", "interactions", "reactions", "updated"],
  runs: [],
  workflows: [],
  releases: [],
};
const searchMatches: Partial<Record<GitHubSearchKind, readonly string[]>> = {
  repositories: ["name", "description", "readme"],
  code: ["file", "path"],
  pull_requests: ["title", "body", "comments"],
  issues: ["title", "body", "comments"],
};
const validRef = (v: string) =>
  v.length <= 256 &&
  /^[A-Za-z0-9._/-]+$/.test(v) &&
  !v.startsWith("-") &&
  !v.includes("..") &&
  !v.endsWith("/") &&
  !v.includes("//");
const validToken = (v: string, max: number) =>
  v.length <= max && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v);
const validWorkflow = (v: string) =>
  v.length <= 100 && /^[A-Za-z0-9._ /-]+$/.test(v) && !v.startsWith("-") && !v.includes("..");
const workflowEvents = new Set([
  "branch_protection_rule",
  "check_run",
  "check_suite",
  "create",
  "delete",
  "deployment",
  "deployment_status",
  "discussion",
  "discussion_comment",
  "fork",
  "gollum",
  "issue_comment",
  "issues",
  "label",
  "merge_group",
  "milestone",
  "page_build",
  "public",
  "pull_request",
  "pull_request_comment",
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request_target",
  "push",
  "registry_package",
  "release",
  "repository_dispatch",
  "schedule",
  "status",
  "watch",
  "workflow_call",
  "workflow_dispatch",
  "workflow_run",
]);
function validateSearchOptions(kind: GitHubSearchKind, o: SearchOptions): void {
  const fail = () => {
    throw new Error("GitHub search filter is invalid for this kind");
  };
  const only = (...keys: (keyof SearchOptions)[]) =>
    Object.keys(o).every((k) => keys.includes(k as keyof SearchOptions));
  if (kind === "pull_requests" || kind === "issues") {
    if (!only("state", "label", "assignee", "author", "search", "match", "sort", "order")) fail();
    if (o.state && !["open", "closed", "merged", "all"].includes(o.state)) fail();
    if (kind === "issues" && o.state === "merged") fail();
    if (o.label && !validToken(o.label, 50)) fail();
    if (o.assignee && !validToken(o.assignee, 39)) fail();
    if (o.author && !validToken(o.author, 39)) fail();
    if (
      o.search &&
      (o.search.length > 128 ||
        hasControlCharacters(o.search) ||
        o.search.startsWith("-") ||
        /[;&|`$<>]/.test(o.search))
    )
      fail();
    if (o.match && !searchMatches[kind]?.includes(o.match)) fail();
    if (o.sort && !searchSorts[kind].includes(o.sort)) fail();
    if (o.order && !["asc", "desc"].includes(o.order)) fail();
  } else if (kind === "repositories" || kind === "code") {
    if (!only("language", "match", "sort", "order")) fail();
    if (o.language && !/^[A-Za-z0-9+#.-]{1,40}$/.test(o.language)) fail();
    if (o.match && !searchMatches[kind]?.includes(o.match)) fail();
    if (o.sort && !searchSorts[kind].includes(o.sort)) fail();
    if (o.order && (!["asc", "desc"].includes(o.order) || kind === "code")) fail();
  } else if (kind === "runs") {
    if (!only("workflow", "branch", "status", "event")) fail();
    if (o.workflow && !validWorkflow(o.workflow)) fail();
    if (o.branch && !validRef(o.branch)) fail();
    if (
      o.status &&
      ![
        "queued",
        "completed",
        "in_progress",
        "requested",
        "waiting",
        "pending",
        "action_required",
        "cancelled",
        "failure",
        "neutral",
        "skipped",
        "stale",
        "startup_failure",
        "success",
        "timed_out",
      ].includes(o.status)
    )
      fail();
    if (o.event && !workflowEvents.has(o.event)) fail();
  } else if (kind === "workflows") {
    if (!only("all")) fail();
  } else if (kind === "releases") {
    if (!only("exclude_drafts", "exclude_prereleases", "order")) fail();
    if (o.order && !["asc", "desc"].includes(o.order)) fail();
  } else if (Object.keys(o).length) fail();
}
// Single source of truth for which read enrichments each kind accepts;
// shared with tool.ts so the contract is defined once. Kinds without
// enrichments map to [] so every GitHubReadKind stays compiler-checked.
export const enrichmentsByKind: Record<GitHubReadKind, readonly string[]> = {
  file: ["offset", "limit"],
  pull_request: ["comments"],
  issue: ["comments"],
  discussion: [],
  run: ["log", "exit_status", "attempt"],
  workflow: [],
  release: [],
  repository: ["branch"],
  diff: ["name_only"],
  checks: [],
  status: [],
};
const searchCmd: Record<GitHubSearchKind, string> = {
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
    async search(kind, query, limit, options = {}) {
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
      validateSearchOptions(kind, options);
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
          searchCmd[kind],
          query,
          "--limit",
          String(n),
          "--json",
          listFields[kind],
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
          listFields[kind],
          "--jq",
          `.[:${n}]`,
        ];
      else if (kind === "workflows")
        args = ["workflow", "list", "--json", listFields[kind], "--jq", `.[:${n}]`];
      else
        args = [
          "release",
          "list",
          "--limit",
          String(n),
          "--json",
          listFields[kind],
          "--jq",
          `.[:${n}]`,
        ];
      // Typed options append only reviewed flags; with no options the legacy argv remains byte-identical.
      const add = (flag: string, value?: string) => {
        if (value !== undefined) args.push(flag, value);
      };
      if (["pull_requests", "issues", "repositories", "code"].includes(kind)) {
        if (options.search) args[2] = `${options.search} ${args[2]}`;
        add(
          "--state",
          options.state && options.state !== "merged" && options.state !== "all"
            ? options.state
            : undefined,
        );
        if (options.state === "merged") args.push("--merged");
        add("--label", options.label);
        add("--assignee", options.assignee);
        add("--author", options.author);
        add("--language", options.language);
        add("--match", options.match);
        add("--sort", options.sort);
        add("--order", options.order);
      } else if (kind === "runs") {
        add("--workflow", options.workflow);
        add("--branch", options.branch);
        add("--status", options.status);
        add("--event", options.event);
      } else if (kind === "workflows") {
        if (options.all) args.push("--all");
      } else if (kind === "releases") {
        if (options.exclude_drafts) args.push("--exclude-drafts");
        if (options.exclude_prereleases) args.push("--exclude-pre-releases");
        add("--order", options.order);
      }
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
          const row = item as Record<string, unknown>;
          const rowRepo =
            row.repository && typeof row.repository === "object"
              ? (row.repository as Record<string, unknown>)
              : undefined;
          const name =
            typeof row.fullName === "string"
              ? row.fullName
              : typeof rowRepo?.nameWithOwner === "string"
                ? rowRepo.nameWithOwner
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
      const enrichments = [
        "comments",
        "name_only",
        "branch",
        "log",
        "exit_status",
        "attempt",
        "offset",
        "limit",
      ] as const;
      if (p.branch !== undefined && !validRef(p.branch))
        throw new Error("GitHub branch ref is invalid");
      if (p.attempt !== undefined && (!Number.isInteger(p.attempt) || p.attempt < 1))
        throw new Error("GitHub run attempt is invalid");
      if ((p.offset !== undefined || p.limit !== undefined) && p.kind !== "file")
        throw new Error("Offset and limit are only valid for file reads");
      if (
        (p.offset !== undefined && (!Number.isInteger(p.offset) || p.offset < 1)) ||
        (p.limit !== undefined &&
          (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > MAX_RANGE_LINES))
      )
        throw new Error("GitHub file range is invalid");
      if (enrichments.some((k) => p[k] !== undefined && !enrichmentsByKind[p.kind].includes(k)))
        throw new Error("GitHub read option is invalid for this kind");
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
          ...(p.branch ? ["--branch", p.branch] : []),
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
          p.comments
            ? "number,title,body,comments,state,url,headRefName,baseRefName,updatedAt,isDraft"
            : "number,title,body,state,url,headRefName,baseRefName,updatedAt,isDraft",
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
          p.comments
            ? "number,title,body,comments,state,url,updatedAt"
            : "number,title,body,state,url,updatedAt",
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
        // Contents payloads bypass the runner's model-facing budget (raised
        // fetch ceiling for the grep cache); parse here and enforce the
        // model-facing cap on the truncated preview below.
        const raw = await call([
          "api",
          endpoint,
          "--jq",
          "{path:.path,url:.html_url,content:.content}",
        ]);
        let file: unknown;
        try {
          file = JSON.parse(raw);
        } catch {
          throw new Error("gh returned invalid JSON");
        }
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
        const fullText = Buffer.from(encoded, "base64").toString("utf8");
        // The full download is cached for repeated greps and ranged reads;
        // the model receives a bounded slice plus full size/line counts so it
        // can page or grep instead of ingesting more. Cache failures never
        // fail the read itself.
        await saveCachedFile(
          defaultCacheDir(),
          { owner: p.owner, repo: p.repo, ref: p.ref, path: p.path },
          fullText,
        ).catch(() => undefined);
        const totalLines = fullText.split("\n").length;
        const size = Buffer.byteLength(fullText);
        if (p.offset !== undefined || p.limit !== undefined) {
          const lines = fullText.split("\n");
          const start = (p.offset ?? 1) - 1;
          const rangeLimit = p.limit ?? MAX_RANGE_LINES;
          const rawSlice = lines.slice(start, start + rangeLimit).join("\n");
          const content = truncateUtf8WithMarker(rawSlice, 4 * 1024);
          result = {
            ...(file as Record<string, unknown>),
            content,
            size,
            totalLines,
            offset: p.offset ?? 1,
            limit: p.limit ?? MAX_RANGE_LINES,
            truncated: start > 0 || start + rangeLimit < lines.length || content !== rawSlice,
          };
        } else {
          const preview = truncateUtf8WithMarker(fullText, 4 * 1024);
          result = {
            ...(file as Record<string, unknown>),
            content: preview,
            size,
            totalLines,
            truncated: preview.length < fullText.length,
          };
        }
      } else if (p.kind === "diff") {
        if (!num) throw new Error("A pull request number is required for this read");
        result = await call([
          "pr",
          "diff",
          String(num),
          "--repo",
          repo,
          ...(p.name_only ? ["--name-only"] : []),
        ]);
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
      else if (p.kind === "run") {
        const args = [
          "run",
          "view",
          String(num),
          "--repo",
          repo,
          ...(p.log ? ["--log"] : []),
          ...(p.exit_status ? ["--exit-status"] : []),
          ...(p.attempt !== undefined ? ["--attempt", String(p.attempt)] : []),
          ...(!p.log ? ["--json", "databaseId,name,status,conclusion,url,headBranch,headSha"] : []),
        ];
        result = p.log ? truncateUtf8WithMarker(await call(args), 4 * 1024) : await bounded(args);
      } else if (p.kind === "workflow")
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
      if (p.comments && result && typeof result === "object") {
        const row = result as Record<string, unknown>;
        if (typeof row.comments === "string")
          row.comments = truncateUtf8WithMarker(row.comments, 4 * 1024);
        else if (Array.isArray(row.comments))
          row.comments = truncateUtf8WithMarker(JSON.stringify(row.comments), 4 * 1024);
      }
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
