export interface PullRequest { number: number; head: { sha: string; repo?: { full_name?: string } }; base: { sha: string; repo?: { full_name?: string } }; draft?: boolean }
export interface Review { id: number; body?: string | null; user?: { login?: string; type?: string }; commit_id?: string; created_at?: string }
export interface ReviewComment { id: number; body: string; user?: { login?: string; type?: string }; path?: string; line?: number; side?: string; pull_request_review_id?: number; in_reply_to_id?: number; created_at?: string }
export interface PageInfo { hasNextPage: boolean; endCursor?: string }
export interface ReviewThreadComment { id: number }
export interface ReviewThread { id: string; isResolved: boolean; comments: { nodes: ReviewThreadComment[]; pageInfo: PageInfo } }
export interface Reaction { id: number; content: string; user?: { login?: string } }

export class GitHubError extends Error { constructor(public status: number, message: string, public details = "") { super(message); } }

function normalizeThreadComment(comment: any): ReviewThreadComment {
  return { id: Number(comment.id) };
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

export class GitHubClient {
  constructor(private readonly token: string, private readonly base = "https://api.github.com") {}
  async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(url.startsWith("http") ? url : `${this.base}${url}`, {
      ...init, headers: { accept: "application/vnd.github+json", authorization: `Bearer ${this.token}`, "x-github-api-version": "2022-11-28", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
    });
    const text = await response.text();
    if (!response.ok) throw new GitHubError(response.status, `GitHub API ${response.status}: ${response.statusText}`, text);
    return (text ? JSON.parse(text) : undefined) as T;
  }
  async getUser() {
    try {
      return await this.request<{ login: string; id: number; type?: string }>("/user");
    } catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 403 || !error.details.includes("Resource not accessible by integration")) throw error;
      const data = await this.graphql<{ viewer: { login: string; id: string; __typename?: string } }>(githubGraphqlDocuments.viewer, {});
      return { login: data.viewer.login, id: data.viewer.id, type: data.viewer.__typename };
    }
  }
  getPullRequest(repo: string, number: number) { return this.request<PullRequest>(`/repos/${repo}/pulls/${number}`); }
  getReview(repo: string, number: number, review: number) { return this.request<Review>(`/repos/${repo}/pulls/${number}/reviews/${review}`); }
  private async list<T>(url: string): Promise<T[]> { const all: T[] = []; for (let page = 1;; page++) { const values = await this.request<T[]>(`${url}?per_page=100&page=${page}`); all.push(...values); if (values.length < 100) return all; } }
  listReviews(repo: string, number: number) { return this.list<Review>(`/repos/${repo}/pulls/${number}/reviews`); }
  listComments(repo: string, number: number) { return this.list<ReviewComment>(`/repos/${repo}/pulls/${number}/comments`); }
  listIssueComments(repo: string, number: number) { return this.list<ReviewComment>(`/repos/${repo}/issues/${number}/comments`); }
  createReview(repo: string, number: number, body: string, commit_id: string, comments: unknown[]) { return this.request<Review>(`/repos/${repo}/pulls/${number}/reviews`, { method: "POST", body: JSON.stringify({ body, commit_id, event: "COMMENT", comments }) }); }
  updateReview(repo: string, number: number, review: number, body: string) { return this.request<Review>(`/repos/${repo}/pulls/${number}/reviews/${review}`, { method: "PUT", body: JSON.stringify({ body }) }); }
  updateIssueComment(repo: string, number: number, comment: number, body: string) { return this.request<ReviewComment>(`/repos/${repo}/issues/comments/${comment}`, { method: "PATCH", body: JSON.stringify({ body }) }); }
  reply(repo: string, number: number, comment: number, body: string) { return this.request<ReviewComment>(`/repos/${repo}/pulls/${number}/comments`, { method: "POST", body: JSON.stringify({ body, in_reply_to: comment }) }); }
  createReviewCommentReaction(repo: string, number: number, comment: number, content: string) { return this.request<{ id: number; content: string }>(`/repos/${repo}/pulls/${number}/comments/${comment}/reactions`, { method: "POST", body: JSON.stringify({ content }) }); }
  createReaction(repo: string, number: number, content = "+1") { return this.request<{ id: number; content: string }>(`/repos/${repo}/issues/${number}/reactions`, { method: "POST", body: JSON.stringify({ content }) }); }
  listReactions(repo: string, number: number) { return this.list<Reaction>(`/repos/${repo}/issues/${number}/reactions`); }
  async graphql<T>(query: string, variables: Record<string, unknown>) { const result = await this.request<{ data?: T; errors?: { message: string }[] }>("https://api.github.com/graphql", { method: "POST", body: JSON.stringify({ query, variables }) }); if (result.errors?.length) throw new Error(result.errors.map(e => e.message).join("; ")); return result.data as T; }
  resolveThread(threadId: string) { return this.graphql(githubGraphqlDocuments.resolveThread, { id: threadId }); }
  async listThreads(repo: string, number: number) {
    const [owner, name] = repo.split("/"); const all: ReviewThread[] = []; let cursor: string | undefined;
    do {
      const page = await this.graphql<any>(githubGraphqlDocuments.listThreads, { owner, name, number, cursor });
      const connection = page.repository.pullRequest.reviewThreads;
      for (const t of connection.nodes) {
        const nodes = t.comments.nodes.map(normalizeThreadComment);
        let commentCursor = t.comments.pageInfo.hasNextPage ? t.comments.pageInfo.endCursor : undefined;
        while (commentCursor) {
          const next = await this.graphql<any>(githubGraphqlDocuments.listThreadComments, { id: t.id, cursor: commentCursor });
          const comments = next.node.comments;
          nodes.push(...comments.nodes.map(normalizeThreadComment));
          commentCursor = comments.pageInfo.hasNextPage ? comments.pageInfo.endCursor : undefined;
        }
        all.push({ id: t.id, isResolved: t.isResolved, comments: { nodes, pageInfo: { hasNextPage: false } } });
      }
      cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : undefined;
    } while (cursor);
    return all;
  }
}
