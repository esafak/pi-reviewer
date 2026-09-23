import {
  boundedRecord,
  boundedString,
  hasControlCharacters,
  isRecord,
} from "../registry/helpers.js";
import { githubResearchGraphqlDocuments } from "../github.js";

export type GitHubResearchScope = "public" | "token-accessible";
export type GitHubSearchKind = "repositories" | "code" | "pull_requests" | "issues" | "discussions";
export type GitHubReadKind = "file" | "pull_request" | "issue" | "discussion";

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

export const MAX_GITHUB_RESPONSE_BYTES = 128 * 1024;
export const MAX_GITHUB_RESULT_BYTES = 7 * 1024;
export const MAX_GITHUB_TOTAL_BYTES = 15 * 1024;
export const MAX_GITHUB_REQUESTS = 8;
export const GITHUB_REQUEST_TIMEOUT_MS = 5_000;
export const GITHUB_WALL_TIME_MS = 15_000;
// Pin research responses to the API version checked against the documented operation shapes.
const GITHUB_API_VERSION = "2026-03-10";
const MAX_QUERY_LENGTH = 256;
const MAX_RESULTS = 5;
const searchKinds = ["repositories", "code", "pull_requests", "issues", "discussions"] as const;
const readKinds = ["file", "pull_request", "issue", "discussion"] as const;

function boundedUtf8String(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const bytes = new TextEncoder().encode(value);
  return bytes.byteLength <= maxBytes ? value : new TextDecoder().decode(bytes.slice(0, maxBytes));
}

function validOwner(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(value);
}

function validRepo(value: string): boolean {
  return /^[A-Za-z0-9_.-]{1,100}$/u.test(value) && value !== "." && value !== "..";
}

function validRef(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    !value.startsWith("-") &&
    !value.includes("..") &&
    !hasControlCharacters(value) &&
    !/[ ~^:?*\\[\]]/u.test(value)
  );
}

function validPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 1024 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !hasControlCharacters(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function projectRepo(value: unknown): Record<string, unknown> {
  return boundedRecord(value, {
    full_name: (v) => boundedString(v, 200),
    name: (v) => boundedString(v, 100),
    description: (v) => boundedString(v, 200),
    html_url: (v) => boundedString(v, 300),
    default_branch: (v) => boundedString(v, 200),
    language: (v) => boundedString(v, 80),
    stargazers_count: (v) => (typeof v === "number" ? v : undefined),
  });
}

function projectIssue(value: unknown): Record<string, unknown> {
  if (!isRecord(value))
    throw new Error("GitHub issue was not found or returned an invalid response");
  return boundedRecord(value, {
    number: (v) => (typeof v === "number" ? v : undefined),
    title: (v) => boundedString(v, 300),
    body: (v) => boundedUtf8String(v, 2_000),
    state: (v) => boundedString(v, 30),
    html_url: (v) => boundedString(v, 300),
    created_at: (v) => boundedString(v, 40),
    updated_at: (v) => boundedString(v, 40),
    user: (v) =>
      isRecord(v) ? boundedRecord(v, { login: (x) => boundedString(x, 100) }) : undefined,
  });
}

function projectSearchIssue(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.repository))
    throw new Error("GitHub issue search returned an invalid result");
  return {
    kind: boundedString(value.__typename, 30),
    number: typeof value.number === "number" ? value.number : undefined,
    title: boundedString(value.title, 180),
    body: boundedUtf8String(value.body, 300),
    state: boundedString(value.state ?? value.issueState ?? value.pullRequestState, 30),
    url: boundedString(value.url, 300),
    createdAt: boundedString(value.createdAt, 40),
    updatedAt: boundedString(value.updatedAt, 40),
    repository: {
      nameWithOwner: boundedString(value.repository.nameWithOwner, 200),
      visibility: boundedString(value.repository.visibility, 20),
    },
  };
}

function projectPull(value: unknown): Record<string, unknown> {
  if (!isRecord(value))
    throw new Error("GitHub pull request was not found or returned an invalid response");
  return boundedRecord(value, {
    number: (v) => (typeof v === "number" ? v : undefined),
    title: (v) => boundedString(v, 300),
    body: (v) => boundedUtf8String(v, 2_000),
    state: (v) => boundedString(v, 30),
    html_url: (v) => boundedString(v, 300),
    created_at: (v) => boundedString(v, 40),
    updated_at: (v) => boundedString(v, 40),
    merged_at: (v) => boundedString(v, 40),
    draft: (v) => (typeof v === "boolean" ? v : undefined),
    head: (v) =>
      isRecord(v)
        ? boundedRecord(v, {
            sha: (x) => boundedString(x, 40),
            ref: (x) => boundedString(x, 200),
          })
        : undefined,
    base: (v) =>
      isRecord(v)
        ? boundedRecord(v, {
            sha: (x) => boundedString(x, 40),
            ref: (x) => boundedString(x, 200),
          })
        : undefined,
  });
}

function projectDiscussion(value: unknown): Record<string, unknown> {
  if (!isRecord(value))
    throw new Error("GitHub Discussion was not found or returned an invalid response");
  return boundedRecord(value, {
    title: (v) => boundedString(v, 300),
    body: (v) => boundedUtf8String(v, 2_000),
    number: (v) => (typeof v === "number" ? v : undefined),
    url: (v) => boundedString(v, 300),
    createdAt: (v) => boundedString(v, 40),
    updatedAt: (v) => boundedString(v, 40),
    repository: (v) =>
      isRecord(v)
        ? boundedRecord(v, {
            nameWithOwner: (x) => boundedString(x, 200),
            visibility: (x) => boundedString(x, 20),
          })
        : undefined,
  });
}

export function createGitHubResearchClient(
  token: string,
  scope: GitHubResearchScope = "public",
  now: () => number = Date.now,
): GitHubResearchClient {
  const startedAt = now();
  let requestCount = 0;
  let outputBytes = 0;

  const request = async (url: URL, method = "GET", body?: unknown): Promise<unknown> => {
    const elapsed = now() - startedAt;
    if (elapsed >= GITHUB_WALL_TIME_MS) throw new Error("GitHub research time budget exhausted");
    if (requestCount >= MAX_GITHUB_REQUESTS)
      throw new Error("GitHub research request budget exhausted");
    requestCount++;
    const signal = AbortSignal.timeout(
      Math.min(GITHUB_REQUEST_TIMEOUT_MS, GITHUB_WALL_TIME_MS - elapsed),
    );
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        redirect: "error",
        signal,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": GITHUB_API_VERSION,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error(
        signal.aborted ? "GitHub research request timed out" : "GitHub research request failed",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 403 || response.status === 429)
        throw new Error("GitHub research is rate limited or forbidden");
      throw new Error(`GitHub research request failed: ${response.status}`);
    }
    return readBoundedJson(response);
  };

  const graphql = async (query: string, variables: Record<string, unknown>) =>
    request(new URL("https://api.github.com/graphql"), "POST", { query, variables });

  const ensureVisibility = async (owner: string, repo: string) => {
    const url = new URL(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    );
    const value = await request(url);
    if (!isRecord(value) || typeof value.private !== "boolean")
      throw new Error("GitHub repository visibility could not be verified");
    if (scope === "public" && value.private)
      throw new Error("Private repositories are unavailable in public scope");
    return value;
  };

  const projectSearchItem = (
    kind: "repositories" | "code",
    value: unknown,
  ): Record<string, unknown> => {
    if (!isRecord(value)) throw new Error("GitHub search returned an invalid result");
    const repo = kind === "repositories" ? value : value.repository;
    if (!isRecord(repo) || typeof repo.private !== "boolean")
      throw new Error("GitHub search result visibility could not be verified");
    if (scope === "public" && repo.private) return {};
    if (kind === "repositories") return projectRepo(value);
    if (kind === "code")
      return boundedRecord(value, {
        name: (v) => boundedString(v, 200),
        path: (v) => boundedString(v, 500),
        html_url: (v) => boundedString(v, 300),
        repository: () => projectRepo(repo),
      });
    throw new Error("GitHub search type is invalid");
  };

  const recordOutput = <T extends Record<string, unknown>>(result: T): T => {
    const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
    if (bytes > MAX_GITHUB_RESULT_BYTES)
      throw new Error("GitHub research result exceeded the byte limit");
    if (outputBytes + bytes > MAX_GITHUB_TOTAL_BYTES)
      throw new Error("GitHub research aggregate output budget exhausted");
    outputBytes += bytes;
    return result;
  };

  const recordSearchOutput = (result: Record<string, unknown>): Record<string, unknown> => {
    const results = Array.isArray(result.results) ? [...result.results] : [];
    let candidate: Record<string, unknown> = { ...result, results };
    let truncated = result.truncated === true;
    while (
      results.length > 0 &&
      new TextEncoder().encode(JSON.stringify(candidate)).byteLength > MAX_GITHUB_RESULT_BYTES
    ) {
      results.pop();
      truncated = true;
      candidate = { ...result, results, truncated };
    }
    if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength > MAX_GITHUB_RESULT_BYTES)
      throw new Error("GitHub search response exceeded the result byte limit");
    return recordOutput(candidate);
  };

  return {
    async search(kind, query, limit) {
      if (!searchKinds.includes(kind)) throw new Error("GitHub search type is invalid");
      if (!query.trim() || query.length > MAX_QUERY_LENGTH || hasControlCharacters(query))
        throw new Error("GitHub search query is invalid");
      if (!Number.isInteger(limit) || limit < 1) throw new Error("GitHub result limit is invalid");
      const max = Math.min(limit, MAX_RESULTS);
      let items: unknown[];
      if (kind === "discussions") {
        const data = await graphql(githubResearchGraphqlDocuments.searchDiscussions, {
          query,
          first: max,
        });
        const nodes =
          isRecord(data) && isRecord(data.data) && isRecord(data.data.search)
            ? data.data.search.nodes
            : undefined;
        if (!Array.isArray(nodes))
          throw new Error("GitHub Discussion search returned an invalid response");
        items = nodes;
        const projected = items.flatMap((item) => {
          if (!isRecord(item) || !isRecord(item.repository)) return [];
          if (scope === "public" && item.repository.visibility !== "PUBLIC") return [];
          return [projectDiscussion(item)];
        });
        return recordSearchOutput({
          kind,
          query,
          results: projected,
          truncated: nodes.length >= max,
        });
      }
      if (kind === "issues" || kind === "pull_requests") {
        const queryWithType = `${query} is:${kind === "pull_requests" ? "pr" : "issue"}`;
        if (queryWithType.length > MAX_QUERY_LENGTH)
          throw new Error("GitHub search query is too long for the selected type");
        const data = await graphql(githubResearchGraphqlDocuments.searchIssuesAndPullRequests, {
          query: queryWithType,
          first: max,
        });
        const nodes =
          isRecord(data) && isRecord(data.data) && isRecord(data.data.search)
            ? data.data.search.nodes
            : undefined;
        if (!Array.isArray(nodes))
          throw new Error("GitHub issue search returned an invalid response");
        const projected = nodes.flatMap((item) => {
          if (!isRecord(item) || !isRecord(item.repository)) return [];
          if (scope === "public" && item.repository.visibility !== "PUBLIC") return [];
          return [projectSearchIssue(item)];
        });
        return recordSearchOutput({
          kind,
          query,
          results: projected,
          truncated: nodes.length >= max,
        });
      }
      const endpoint = kind === "repositories" ? "repositories" : "code";
      const url = new URL(`https://api.github.com/search/${endpoint}`);
      url.searchParams.set("q", query);
      url.searchParams.set("per_page", String(max));
      const data = await request(url);
      if (!isRecord(data) || !Array.isArray(data.items))
        throw new Error("GitHub search returned an invalid response");
      items = data.items;
      const projected = items
        .map((item) => projectSearchItem(kind, item))
        .filter((item) => Object.keys(item).length > 0);
      return recordSearchOutput({
        kind,
        query,
        results: projected,
        truncated: items.length >= max || data.incomplete_results === true,
      });
    },
    async read(params) {
      if (!readKinds.includes(params.kind)) throw new Error("GitHub read type is invalid");
      if (!validOwner(params.owner) || !validRepo(params.repo))
        throw new Error("GitHub repository identifier is invalid");
      if (params.path && !validPath(params.path)) throw new Error("GitHub file path is invalid");
      if (params.ref && !validRef(params.ref)) throw new Error("GitHub ref is invalid");
      if (
        ["pull_request", "issue", "discussion"].includes(params.kind) &&
        (!Number.isInteger(params.number) || params.number! < 1)
      )
        throw new Error("GitHub item number is invalid");
      const owner = encodeURIComponent(params.owner);
      const repo = encodeURIComponent(params.repo);
      const repository = await ensureVisibility(params.owner, params.repo);
      let result: Record<string, unknown>;
      if (params.kind === "file") {
        if (!params.path) throw new Error("A file path is required");
        const path = params.path.split("/").map(encodeURIComponent).join("/");
        const url = new URL(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`);
        if (params.ref) url.searchParams.set("ref", params.ref);
        const value = await request(url);
        if (!isRecord(value) || value.type !== "file" || typeof value.content !== "string")
          throw new Error("GitHub file content is unavailable or not a regular file");
        const decoded = Buffer.from(value.content, "base64").toString("utf8");
        const contentBytes = new TextEncoder().encode(decoded);
        const content = new TextDecoder().decode(contentBytes.slice(0, 3_000));
        result = {
          kind: params.kind,
          repository: boundedString(repository.full_name, 200) ?? `${params.owner}/${params.repo}`,
          ref: params.ref ?? boundedString(repository.default_branch, 200),
          path: boundedString(value.path, 500),
          url: boundedString(value.html_url, 300),
          content,
          truncated:
            contentBytes.byteLength > 3_000 ||
            (typeof value.size === "number" && value.size > 3_000),
        };
      } else if (params.kind === "pull_request") {
        const value = await request(
          new URL(`https://api.github.com/repos/${owner}/${repo}/pulls/${params.number}`),
        );
        const filesUrl = new URL(
          `https://api.github.com/repos/${owner}/${repo}/pulls/${params.number}/files`,
        );
        filesUrl.searchParams.set("per_page", "5");
        const files = await request(filesUrl);
        if (!Array.isArray(files))
          throw new Error("GitHub pull request files returned an invalid response");
        result = {
          kind: params.kind,
          repository: `${params.owner}/${params.repo}`,
          pull_request: projectPull(value),
          changed_files: files.slice(0, 5).map((file) =>
            boundedRecord(file, {
              filename: (v) => boundedString(v, 300),
              status: (v) => boundedString(v, 30),
              additions: (v) => (typeof v === "number" ? v : undefined),
              deletions: (v) => (typeof v === "number" ? v : undefined),
            }),
          ),
          truncated: files.length >= 5,
        };
      } else if (params.kind === "issue") {
        result = {
          kind: params.kind,
          repository: `${params.owner}/${params.repo}`,
          issue: projectIssue(
            await request(
              new URL(`https://api.github.com/repos/${owner}/${repo}/issues/${params.number}`),
            ),
          ),
        };
      } else {
        const data = await graphql(githubResearchGraphqlDocuments.readDiscussion, {
          owner: params.owner,
          name: params.repo,
          number: params.number,
        });
        const repositoryData =
          isRecord(data) && isRecord(data.data) ? data.data.repository : undefined;
        if (
          !isRecord(repositoryData) ||
          (scope === "public" && repositoryData.visibility !== "PUBLIC")
        )
          throw new Error("GitHub Discussion repository visibility could not be verified");
        result = { kind: params.kind, discussion: projectDiscussion(repositoryData.discussion) };
      }
      return recordOutput(result);
    },
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_GITHUB_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("GitHub response exceeded the byte limit");
  }
  if (!response.body) throw new Error("GitHub response body is empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_GITHUB_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("GitHub response exceeded the byte limit");
      }
      chunks.push(value.slice());
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("GitHub returned invalid JSON");
  }
}

export { validOwner, validRepo, validRef, validPath };
