export interface PullRequest {
  number: number;
  head: { sha: string; repo?: { full_name?: string } };
  base: { sha: string; repo?: { full_name?: string } };
  draft?: boolean;
  user?: { login?: string; type?: string };
  title?: string;
  body?: string | null;
}
export interface Review {
  id: number;
  body?: string | null;
  user?: { login?: string; type?: string };
  commit_id?: string;
  created_at?: string;
}
export interface ReviewComment {
  id: number;
  body: string;
  user?: { login?: string; type?: string };
  author_association?: string;
  path?: string;
  line?: number;
  side?: string;
  pull_request_review_id?: number;
  in_reply_to_id?: number;
  created_at?: string;
}
export interface PageInfo {
  hasNextPage: boolean;
  endCursor?: string;
}
export interface ReviewThreadComment {
  id: number;
}
export interface ReviewThread {
  id: string;
  isResolved: boolean;
  comments: { nodes: ReviewThreadComment[]; pageInfo: PageInfo };
}
export interface Reaction {
  id: number;
  content: string;
  user?: { login?: string };
}

/**
 * The conclusions a client may assign to a check run.
 *
 * The API can also report `stale` for a run it gave up on, but a client
 * cannot assign it, so it is not in the writable set.
 */
export type CheckRunConclusion =
  | "action_required"
  | "cancelled"
  | "failure"
  | "neutral"
  | "success"
  | "skipped"
  | "timed_out";

export type CheckRunStatus = "queued" | "in_progress" | "completed";

/**
 * The statuses the API reports for a run.
 *
 * A client can only assign the three writable statuses, but a run created
 * elsewhere — by GitHub Actions, say — reports one of the others.
 */
export type CheckRunReportedStatus = CheckRunStatus | "waiting" | "requested" | "pending";

/**
 * An annotation on a check run.
 *
 * The field names are the REST field names, so there is no camelCase-to-
 * snake_case mapping layer to get wrong. An annotation has no side: it always
 * refers to the head file of the commit the run belongs to.
 */
export interface CheckRunAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "notice" | "warning" | "failure";
  message: string;
  title?: string;
}

export interface CheckRunOutput {
  title: string;
  summary: string;
  annotations?: CheckRunAnnotation[];
}

/**
 * A run is created `in_progress` and concluded later, so the create input
 * carries no conclusion.
 */
export interface CreateCheckRunInput {
  head_sha: string;
  name: string;
  status: CheckRunStatus;
  output?: CheckRunOutput;
}

/**
 * The conclusion is optional so an in-progress update can carry annotations
 * alone. A `completed` update must carry one.
 */
export interface UpdateCheckRunInput {
  status: CheckRunStatus;
  conclusion?: CheckRunConclusion;
  output?: CheckRunOutput;
}

export interface CheckRun {
  id: number;
  name: string;
  head_sha: string;
  status: CheckRunReportedStatus;
  /** The API reports `null` for a run that has no conclusion yet, and `stale` for one it gave up on. */
  conclusion: CheckRunConclusion | "stale" | null;
}

/** The list endpoint answers with an envelope, not a bare array. */
export interface ListCheckRunsResult {
  total_count: number;
  check_runs: CheckRun[];
}

export class GitHubError extends Error {
  constructor(
    public status: number,
    message: string,
    public details = "",
  ) {
    super(message);
  }
}

function githubPath(...parts: (string | number)[]): string {
  return "/" + parts.join("/");
}

type GitHubPathRegistry = {
  graphql: string;
  user: () => string;
  pullRequest: (repo: string, number: number) => string;
  review: (repo: string, number: number, review: number) => string;
  reviews: (repo: string, number: number) => string;
  reviewComments: (repo: string, number: number) => string;
  issueComments: (repo: string, number: number) => string;
  issueComment: (repo: string, comment: number) => string;
  reviewComment: (repo: string, comment: number) => string;
  reviewCommentReactions: (repo: string, number: number, comment: number) => string;
  collaboratorPermission: (repo: string, login: string) => string;
  issueReactions: (repo: string, number: number) => string;
  issueReaction: (repo: string, number: number, reaction: number) => string;
  checkRuns: (repo: string) => string;
  checkRun: (repo: string, id: number) => string;
  commitCheckRuns: (repo: string, ref: string) => string;
};

export const githubPaths = {
  graphql: "https://api.github.com/graphql",
  user: () => githubPath("user"),
  pullRequest: (repo, number) => githubPath("repos", repo, "pulls", number),
  review: (repo, number, review) => githubPath("repos", repo, "pulls", number, "reviews", review),
  reviews: (repo, number) => githubPath("repos", repo, "pulls", number, "reviews"),
  reviewComments: (repo, number) => githubPath("repos", repo, "pulls", number, "comments"),
  issueComments: (repo, number) => githubPath("repos", repo, "issues", number, "comments"),
  issueComment: (repo, comment) => githubPath("repos", repo, "issues", "comments", comment),
  reviewComment: (repo, comment) => githubPath("repos", repo, "pulls", "comments", comment),
  reviewCommentReactions: (repo, number, comment) =>
    githubPath("repos", repo, "pulls", number, "comments", comment, "reactions"),
  collaboratorPermission: (repo, login) =>
    githubPath("repos", repo, "collaborators", login, "permission"),
  issueReactions: (repo, number) => githubPath("repos", repo, "issues", number, "reactions"),
  issueReaction: (repo, number, reaction) =>
    githubPath("repos", repo, "issues", number, "reactions", reaction),
  checkRuns: (repo) => githubPath("repos", repo, "check-runs"),
  checkRun: (repo, id) => githubPath("repos", repo, "check-runs", id),
  commitCheckRuns: (repo, ref) =>
    githubPath("repos", repo, "commits", encodeURIComponent(ref), "check-runs"),
} as const satisfies GitHubPathRegistry;

/**
 * The GraphQL response types, as the schema allows them.
 *
 * The schema makes most of this nullable — a repository, a pull request, a
 * node, a `fullDatabaseId` — and a selection set only guarantees the fields
 * it asks for. The types say so, and the reads below narrow before they
 * consume, rather than assuming a shape the API never promised.
 */
/** A GraphQL page cursor. */
interface GraphQLPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}
/**
 * A review-thread comment. The document aliases `fullDatabaseId` over `id`,
 * so the numeric database id arrives under `id`; the field is nullable
 * because `fullDatabaseId` is.
 */
interface GraphQLThreadComment {
  id: number | string | null;
}
interface GraphQLCommentConnection {
  nodes: (GraphQLThreadComment | null)[] | null;
  pageInfo: GraphQLPageInfo;
}
interface GraphQLReviewThread {
  id: string;
  isResolved: boolean;
  comments: GraphQLCommentConnection;
}
interface GraphQLReviewThreadConnection {
  nodes: (GraphQLReviewThread | null)[] | null;
  pageInfo: GraphQLPageInfo;
}
interface GraphQLPullRequest {
  reviewThreads: GraphQLReviewThreadConnection;
}
interface GraphQLRepository {
  pullRequest: GraphQLPullRequest | null;
}
interface ListThreadsResponse {
  repository: GraphQLRepository | null;
}
/**
 * The node a comment page is read from. `comments` is selected inside an
 * inline fragment on `PullRequestReviewThread`, so a node of another type
 * does not carry the field at all.
 */
interface GraphQLReviewThreadNode {
  comments?: GraphQLCommentConnection;
}
interface ListThreadCommentsResponse {
  node: GraphQLReviewThreadNode | null;
}
/** Narrows a nullable GraphQL value, or explains what was missing. */
function requireGraphQL<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`GitHub returned no ${what}`);
  return value;
}
function normalizeThreadComment(comment: GraphQLThreadComment): ReviewThreadComment {
  // `nodes { id: fullDatabaseId }` aliases the numeric database id to `id`, so the
  // REST-facing id is already under `comment.id`; no `fullDatabaseId` key is returned.
  const id = Number(comment.id);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new Error("GitHub returned a review-thread comment without a usable id");
  return { id };
}

export const githubGraphqlDocuments = {
  viewer: "query Viewer { viewer { login id __typename } }",
  listThreads: `query ListThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          nodes {
            id
            isResolved
            comments(first: 100) {
              nodes { id: fullDatabaseId }
              pageInfo { hasNextPage endCursor }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }`,
  listThreadComments: `query ListThreadComments($id: ID!, $cursor: String) {
    node(id: $id) {
      ... on PullRequestReviewThread {
        comments(first: 100, after: $cursor) {
          nodes { id: fullDatabaseId }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }`,
  resolveThread: `mutation ResolveThread($id: ID!) {
    resolveReviewThread(input: { threadId: $id }) {
      thread { id isResolved }
    }
  }`,
} as const;

export const githubResearchGraphqlDocuments = {
  searchDiscussions: `query SearchDiscussions($query: String!, $first: Int!) {
    search(query: $query, type: DISCUSSION, first: $first) {
      nodes {
        ... on Discussion {
          title body number url createdAt updatedAt
          repository { nameWithOwner visibility }
        }
      }
    }
  }`,
  readDiscussion: `query ReadDiscussion($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      visibility
      discussion(number: $number) {
        title body number url createdAt updatedAt
        repository { nameWithOwner visibility }
      }
    }
  }`,
  searchIssuesAndPullRequests: `query SearchIssuesAndPullRequests($query: String!, $first: Int!) {
    search(query: $query, type: ISSUE, first: $first) {
      nodes {
        ... on Issue {
          __typename number title body url createdAt updatedAt
          issueState: state
          repository { nameWithOwner visibility }
        }
        ... on PullRequest {
          __typename number title body url createdAt updatedAt
          pullRequestState: state
          repository { nameWithOwner visibility }
        }
      }
    }
  }`,
} as const;

export class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly base = "https://api.github.com",
  ) {}
  private resolveUrl(url: string) {
    return url.startsWith("http") ? url : this.base + url;
  }
  async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(this.resolveUrl(url), {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "x-github-api-version": "2022-11-28",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const text = await response.text();
    if (!response.ok)
      throw new GitHubError(
        response.status,
        `GitHub API ${response.status}: ${response.statusText}`,
        text,
      );
    return (text ? JSON.parse(text) : undefined) as T;
  }
  async getUser() {
    try {
      return await this.request<{ login: string; id: number; type?: string }>(githubPaths.user());
    } catch (error) {
      if (
        !(error instanceof GitHubError) ||
        error.status !== 403 ||
        !error.details.includes("Resource not accessible by integration")
      )
        throw error;
      const data = await this.graphql<{
        viewer: { login: string; id: string; __typename?: string };
      }>(githubGraphqlDocuments.viewer, {});
      return { login: data.viewer.login, id: data.viewer.id, type: data.viewer.__typename };
    }
  }
  getPullRequest(repo: string, number: number) {
    return this.request<PullRequest>(githubPaths.pullRequest(repo, number));
  }
  getReview(repo: string, number: number, review: number) {
    return this.request<Review>(githubPaths.review(repo, number, review));
  }
  async getCollaboratorPermission(repo: string, login: string): Promise<string | undefined> {
    const data = await this.request<{ permission?: string }>(
      githubPaths.collaboratorPermission(repo, login),
    );
    return data.permission;
  }
  private async list<T>(url: string): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; ; page++) {
      const pageUrl = new URL(this.resolveUrl(url));
      pageUrl.searchParams.set("per_page", "100");
      pageUrl.searchParams.set("page", String(page));
      const values = await this.request<T[]>(pageUrl.toString());
      all.push(...values);
      if (values.length < 100) return all;
    }
  }
  listReviews(repo: string, number: number) {
    return this.list<Review>(githubPaths.reviews(repo, number));
  }
  listComments(repo: string, number: number) {
    return this.list<ReviewComment>(githubPaths.reviewComments(repo, number));
  }
  listIssueComments(repo: string, number: number) {
    return this.list<ReviewComment>(githubPaths.issueComments(repo, number));
  }
  createReview(repo: string, number: number, body: string, commit_id: string, comments: unknown[]) {
    return this.request<Review>(githubPaths.reviews(repo, number), {
      method: "POST",
      body: JSON.stringify({ body, commit_id, event: "COMMENT", comments }),
    });
  }
  updateReview(repo: string, number: number, review: number, body: string) {
    return this.request<Review>(githubPaths.review(repo, number, review), {
      method: "PUT",
      body: JSON.stringify({ body }),
    });
  }
  updateIssueComment(repo: string, number: number, comment: number, body: string) {
    return this.request<ReviewComment>(githubPaths.issueComment(repo, comment), {
      method: "PATCH",
      body: JSON.stringify({ body }),
    });
  }
  updateReviewComment(repo: string, number: number, comment: number, body: string) {
    return this.request<ReviewComment>(githubPaths.reviewComment(repo, comment), {
      method: "PATCH",
      body: JSON.stringify({ body }),
    });
  }
  reply(repo: string, number: number, comment: number, body: string) {
    return this.request<ReviewComment>(githubPaths.reviewComments(repo, number), {
      method: "POST",
      body: JSON.stringify({ body, in_reply_to: comment }),
    });
  }
  createReviewCommentReaction(repo: string, number: number, comment: number, content: string) {
    return this.request<{ id: number; content: string }>(
      githubPaths.reviewCommentReactions(repo, number, comment),
      { method: "POST", body: JSON.stringify({ content }) },
    );
  }
  createReaction(repo: string, number: number, content = "+1") {
    return this.request<{ id: number; content: string }>(githubPaths.issueReactions(repo, number), {
      method: "POST",
      body: JSON.stringify({ content }),
    });
  }
  listReactions(repo: string, number: number) {
    return this.list<Reaction>(githubPaths.issueReactions(repo, number));
  }
  createCheckRun(repo: string, input: CreateCheckRunInput) {
    return this.request<CheckRun>(githubPaths.checkRuns(repo), {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  async updateCheckRun(repo: string, id: number, input: UpdateCheckRunInput) {
    if (input.status === "completed" && !input.conclusion)
      throw new Error("A completed check run update must carry a conclusion");
    return this.request<CheckRun>(githubPaths.checkRun(repo, id), {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }
  /**
   * Lists the check runs of a commit.
   *
   * The endpoint answers with an envelope rather than a bare array, so it
   * does not use the `list<T>()` array helper: it paginates `check_runs`
   * itself. It answers with the latest run per check name, which is the run
   * branch protection evaluates.
   *
   * The `ref` is the commit the runs belong to — a commit SHA. It is
   * encoded, so a value that is not a commit cannot address another route.
   */
  async listCheckRuns(repo: string, ref: string): Promise<CheckRun[]> {
    const all: CheckRun[] = [];
    for (let page = 1; ; page++) {
      const pageUrl = new URL(this.resolveUrl(githubPaths.commitCheckRuns(repo, ref)));
      pageUrl.searchParams.set("per_page", "100");
      pageUrl.searchParams.set("page", String(page));
      const result = await this.request<ListCheckRunsResult>(pageUrl.toString());
      all.push(...result.check_runs);
      if (result.check_runs.length < 100) return all;
    }
  }
  deleteReaction(repo: string, number: number, reaction: number) {
    return this.request<void>(githubPaths.issueReaction(repo, number, reaction), {
      method: "DELETE",
    });
  }
  async graphql<T>(query: string, variables: Record<string, unknown>) {
    const result = await this.request<{ data?: T; errors?: { message: string }[] }>(
      githubPaths.graphql,
      { method: "POST", body: JSON.stringify({ query, variables }) },
    );
    if (result.errors?.length) throw new Error(result.errors.map((e) => e.message).join("; "));
    return result.data as T;
  }
  resolveThread(threadId: string) {
    return this.graphql(githubGraphqlDocuments.resolveThread, { id: threadId });
  }
  async listThreads(repo: string, number: number) {
    const [owner, name] = repo.split("/");
    const all: ReviewThread[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.graphql<ListThreadsResponse>(githubGraphqlDocuments.listThreads, {
        owner,
        name,
        number,
        cursor,
      });
      const connection = requireGraphQL(
        requireGraphQL(page.repository, "repository").pullRequest?.reviewThreads,
        "review threads for the pull request",
      );
      for (const thread of requireGraphQL(connection.nodes, "review threads")) {
        const t = requireGraphQL(thread, "review thread");
        const nodes = requireGraphQL(t.comments.nodes, "review thread comments").map((comment) =>
          normalizeThreadComment(requireGraphQL(comment, "review thread comment")),
        );
        let commentCursor = t.comments.pageInfo.hasNextPage
          ? (t.comments.pageInfo.endCursor ?? undefined)
          : undefined;
        while (commentCursor) {
          const next = await this.graphql<ListThreadCommentsResponse>(
            githubGraphqlDocuments.listThreadComments,
            { id: t.id, cursor: commentCursor },
          );
          const comments = requireGraphQL(next.node?.comments, "comments for the review thread");
          nodes.push(
            ...requireGraphQL(comments.nodes, "review thread comments").map((comment) =>
              normalizeThreadComment(requireGraphQL(comment, "review thread comment")),
            ),
          );
          commentCursor = comments.pageInfo.hasNextPage
            ? (comments.pageInfo.endCursor ?? undefined)
            : undefined;
        }
        all.push({
          id: t.id,
          isResolved: t.isResolved,
          comments: { nodes, pageInfo: { hasNextPage: false } },
        });
      }
      cursor = connection.pageInfo.hasNextPage
        ? (connection.pageInfo.endCursor ?? undefined)
        : undefined;
    } while (cursor);
    return all;
  }
}
