import { Octokit, RequestError } from "octokit";

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

export class GitHubError extends Error {
  constructor(
    public status: number,
    message: string,
    public details = "",
  ) {
    super(message);
  }
}

/** Split "owner/repo" into endpoint params. Route shapes come from octokit. */
function splitRepo(repo: string): { owner: string; repo: string } {
  const [owner, name] = repo.split("/");
  return { owner, repo: name };
}

/** Allowed reaction bodies for review-comment and issue reactions. */
type ReactionContent = "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes";

/** Inline comment payload for review creation. */
interface ReviewCommentInput {
  path: string;
  body: string;
  line?: number;
  side?: string;
}

/**
 * Maps an octokit failure back into the historical GitHubError shape so
 * callers and log-based triage observe the same status and details.
 */
function toGitHubError(error: unknown): GitHubError {
  if (error instanceof RequestError) {
    const status = error.status;
    const data = error.response?.data as unknown;
    const details = typeof data === "string" ? data : JSON.stringify(data ?? "");
    return new GitHubError(status, `GitHub API ${status}: ${error.message}`, details);
  }
  if (error instanceof GitHubError) return error;
  throw error;
}

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
  private readonly octokit: Octokit;
  constructor(token: string, base = "https://api.github.com") {
    this.octokit = new Octokit({
      auth: token,
      baseUrl: base,
      // The harness owns retry policy explicitly (e.g. the 422 body-only
      // repost): silent transport retries could double-post reviews.
      retry: { enabled: false },
      throttle: { enabled: false },
    });
  }
  async getUser() {
    try {
      const { data } = await this.octokit.rest.users.getAuthenticated();
      return { login: data.login, id: data.id, type: data.type };
    } catch (error) {
      const mapped = toGitHubError(error);
      if (
        !(mapped instanceof GitHubError) ||
        mapped.status !== 403 ||
        !mapped.details.includes("Resource not accessible by integration")
      )
        throw mapped;
      const data = await this.graphql<{
        viewer: { login: string; id: string; __typename?: string };
      }>(githubGraphqlDocuments.viewer, {});
      return { login: data.viewer.login, id: data.viewer.id, type: data.viewer.__typename };
    }
  }
  async getPullRequest(repo: string, number: number): Promise<PullRequest> {
    try {
      const { owner, repo: name } = splitRepo(repo);
      const { data } = await this.octokit.rest.pulls.get({
        owner,
        repo: name,
        pull_number: number,
      });
      return data as PullRequest;
    } catch (error) {
      throw toGitHubError(error);
    }
  }
  async getReview(repo: string, number: number, review: number): Promise<Review> {
    try {
      const { owner, repo: name } = splitRepo(repo);
      const { data } = await this.octokit.rest.pulls.getReview({
        owner,
        repo: name,
        pull_number: number,
        review_id: review,
      });
      return data as Review;
    } catch (error) {
      throw toGitHubError(error);
    }
  }
  async getCollaboratorPermission(repo: string, login: string): Promise<string | undefined> {
    try {
      const { owner, repo: name } = splitRepo(repo);
      const { data } = await this.octokit.rest.repos.getCollaboratorPermissionLevel({
        owner,
        repo: name,
        username: login,
      });
      return data.permission;
    } catch (error) {
      throw toGitHubError(error);
    }
  }
  async getIssueComment(repo: string, comment: number): Promise<ReviewComment> {
    try {
      const { owner, repo: name } = splitRepo(repo);
      const { data } = await this.octokit.rest.issues.getComment({
        owner,
        repo: name,
        comment_id: comment,
      });
      return data as ReviewComment;
    } catch (error) {
      throw toGitHubError(error);
    }
  }
  async listReviews(repo: string, number: number): Promise<Review[]> {
    try {
      const { owner, repo: name } = splitRepo(repo);
      const data = await this.octokit.paginate(this.octokit.rest.pulls.listReviews, {
        owner,
        repo: name,
        pull_number: number,
        per_page: 100,
      });
      return data as Review[];
    } catch (error) {
      throw toGitHubError(error);
    }
  }
  async listComments(repo: string, number: number): Promise<ReviewComment[]> {
    try {
      const { owner, repo: name } = splitRepo(repo);
      const data = await this.octokit.paginate(this.octokit.rest.pulls.listReviewComments, {
        owner,
        repo: name,
        pull_number: number,
        per_page: 100,
      });
      return data as ReviewComment[];
    } catch (error) {
      throw toGitHubError(error);
    }
  }
  async listIssueComments(repo: string, number: number): Promise<ReviewComment[]> {
    try {
      const { owner, repo: name } = splitRepo(repo);
      const data = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
        owner,
        repo: name,
        issue_number: number,
        per_page: 100,
      });
      return data as ReviewComment[];
    } catch (error) {
      throw toGitHubError(error);
    }
  }
  async createReview(
    repo: string,
    number: number,
    body: string,
    commit_id: string,
    comments: unknown[],
    event: "COMMENT" | "REQUEST_CHANGES" = "COMMENT",
  ): Promise<Review> {
    try {
      const { owner, repo: name } = splitRepo(repo);
      const { data } = await this.octokit.rest.pulls.createReview({
        owner,
        repo: name,
        pull_number: number,
        commit_id,
        body,
        event,
        comments: comments as ReviewCommentInput[],
      });
      return data as Review;
    } catch (error) {
      throw toGitHubError(error);
    }
  }
  async createIssueComment(repo: string, number: number, body: string): Promise<ReviewComment> {
    try {
      const { owner, repo: name } = splitRepo(repo);
      const { data } = await this.octokit.rest.issues.createComment({
        owner,
        repo: name,
        issue_number: number,
        body,
      });
      return data as ReviewComment;
    } catch (error) {
      throw toGitHubError(error);
    }
  }
  async updateReview(repo: string, number: number, review: number, body: string): Promise<Review> {
    try {
      const { owner, repo: name } = splitRepo(repo);
      const { data } = await this.octokit.rest.pulls.updateReview({
        owner,
        repo: name,
        pull_number: number,
        review_id: review,
        body,
      });
      return data as Review;
    } catch (error) {
      throw toGitHubError(error);
    }
  }
  async updateIssueComment(
    repo: string,
    number: number,
    comment: number,
    body: string,
  ): Promise<ReviewComment> {
    void number;
    try {
      const { owner, repo: name } = splitRepo(repo);
      const { data } = await this.octokit.rest.issues.updateComment({
        owner,
        repo: name,
        comment_id: comment,
        body,
      });
      return data as ReviewComment;
    } catch (error) {
      throw toGitHubError(error);
    }
  }
  async updateReviewComment(
    repo: string,
    number: number,
    comment: number,
    body: string,
  ): Promise<ReviewComment> {
    void number;
    try {
      const { owner, repo: name } = splitRepo(repo);
      const { data } = await this.octokit.rest.pulls.updateReviewComment({
        owner,
        repo: name,
        comment_id: comment,
        body,
      });
      return data as ReviewComment;
    } catch (error) {
      throw toGitHubError(error);
    }
  }
  async reply(repo: string, number: number, comment: number, body: string): Promise<ReviewComment> {
    try {
      const { owner, repo: name } = splitRepo(repo);
      // Replies address the parent comment resource directly; the endpoint
      // takes only the parent id plus the body, so no parameter cast is
      // needed and a wrong route fails compilation.
      const { data } = await this.octokit.rest.pulls.createReplyForReviewComment({
        owner,
        repo: name,
        pull_number: number,
        comment_id: comment,
        body,
      });
      return data as ReviewComment;
    } catch (error) {
      throw toGitHubError(error);
    }
  }
  async createReviewCommentReaction(
    repo: string,
    comment: number,
    content: string,
  ): Promise<{ id: number; content: string }> {
    try {
      const { owner, repo: name } = splitRepo(repo);
      const { data } = await this.octokit.rest.reactions.createForPullRequestReviewComment({
        owner,
        repo: name,
        comment_id: comment,
        content: content as ReactionContent,
      });
      return data as { id: number; content: string };
    } catch (error) {
      throw toGitHubError(error);
    }
  }
  async createReaction(
    repo: string,
    number: number,
    content = "+1",
  ): Promise<{ id: number; content: string }> {
    try {
      const { owner, repo: name } = splitRepo(repo);
      const { data } = await this.octokit.rest.reactions.createForIssue({
        owner,
        repo: name,
        issue_number: number,
        content: content as ReactionContent,
      });
      return data as { id: number; content: string };
    } catch (error) {
      throw toGitHubError(error);
    }
  }
  async listReactions(repo: string, number: number): Promise<Reaction[]> {
    try {
      const { owner, repo: name } = splitRepo(repo);
      const data = await this.octokit.paginate(this.octokit.rest.reactions.listForIssue, {
        owner,
        repo: name,
        issue_number: number,
        per_page: 100,
      });
      return data as Reaction[];
    } catch (error) {
      throw toGitHubError(error);
    }
  }
  async deleteReaction(repo: string, number: number, reaction: number): Promise<void> {
    try {
      const { owner, repo: name } = splitRepo(repo);
      await this.octokit.rest.reactions.deleteForIssue({
        owner,
        repo: name,
        issue_number: number,
        reaction_id: reaction,
      });
    } catch (error) {
      throw toGitHubError(error);
    }
  }
  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    try {
      return await this.octokit.graphql<T>(query, variables);
    } catch (error) {
      const errors = (error as { errors?: { message?: string }[] }).errors;
      if (Array.isArray(errors) && errors.length > 0)
        throw new Error(errors.map((e) => e.message ?? "GraphQL error").join("; "));
      // Transport failures carry no GraphQL payload; map them so callers
      // keep observing the historical GitHubError shape.
      throw toGitHubError(error);
    }
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
