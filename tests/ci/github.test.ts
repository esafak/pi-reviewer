import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { GitHubClient, GitHubError, githubGraphqlDocuments } from "../../src/ci/github.js";

afterEach(() => vi.unstubAllGlobals());

function response(body: unknown, ok = true, status = 200) {
  return { ok, status, statusText: ok ? "OK" : "Bad Request", text: vi.fn().mockResolvedValue(JSON.stringify(body)) };
}

describe("GitHubClient", () => {
  it("paginates REST collections", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(Array.from({ length: 100 }, (_, id) => ({ id }))))
      .mockResolvedValueOnce(response([{ id: 100 }]));
    vi.stubGlobal("fetch", fetchMock);
    const reviews = await new GitHubClient("token").listReviews("owner/repo", 1);
    expect(reviews).toHaveLength(101);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain("page=2");
  });
  it("surfaces status and response details", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ message: "no" }, false, 403)));
    await expect(new GitHubClient("token").getUser()).rejects.toMatchObject({ status: 403, details: '{"message":"no"}' } satisfies Partial<GitHubError>);
  });
  it("uses the authenticated custom App identity", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ login: "review-app[bot]", id: 42, type: "Bot" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(new GitHubClient("token").getUser()).resolves.toMatchObject({ login: "review-app[bot]", type: "Bot" });
    expect(fetchMock).toHaveBeenCalledWith("https://api.github.com/user", expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer token" }) }));
  });
  it("uses GraphQL viewer identity for installation tokens", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ message: "Resource not accessible by integration" }, false, 403))
      .mockResolvedValueOnce(response({ data: { viewer: { login: "review-app[bot]", id: "42", __typename: "Bot" } } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(new GitHubClient("token").getUser()).resolves.toMatchObject({ login: "review-app[bot]", type: "Bot" });
    expect(fetchMock).toHaveBeenLastCalledWith("https://api.github.com/graphql", expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer token" }), body: JSON.stringify({ query: githubGraphqlDocuments.viewer, variables: {} }) }));
  });
  it("creates a thumbs-up reaction on a pull request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ id: 7, content: "+1" }));
    vi.stubGlobal("fetch", fetchMock);
    await new GitHubClient("token").createReaction("owner/repo", 42);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/issues/42/reactions",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ content: "+1" }) }),
    );
  });
  it("creates a reaction on a specific review comment", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ id: 8, content: "eyes" }));
    vi.stubGlobal("fetch", fetchMock);
    await new GitHubClient("token").createReviewCommentReaction("owner/repo", 42, 99, "eyes");
    expect(fetchMock).toHaveBeenCalledWith("https://api.github.com/repos/owner/repo/pulls/42/comments/99/reactions", expect.objectContaining({ method: "POST", body: JSON.stringify({ content: "eyes" }) }));
  });
  it("resolves a review thread through GraphQL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ data: { resolveReviewThread: { thread: { id: "thread-1", isResolved: true } } } }));
    vi.stubGlobal("fetch", fetchMock);

    await new GitHubClient("token").resolveThread("thread-1");

    expect(fetchMock).toHaveBeenCalledWith("https://api.github.com/graphql", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ query: githubGraphqlDocuments.resolveThread, variables: { id: "thread-1" } }),
    }));
  });
  it("updates a review comment", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ id: 9, body: "updated" }));
    vi.stubGlobal("fetch", fetchMock);
    await new GitHubClient("token").updateReviewComment("owner/repo", 42, 9, "updated");
    expect(fetchMock).toHaveBeenCalledWith("https://api.github.com/repos/owner/repo/pulls/comments/9", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ body: "updated" }) }));
  });
  it("lists pull request issue comments separately from review comments", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([{ id: 1, body: "marker" }]));
    vi.stubGlobal("fetch", fetchMock);
    await new GitHubClient("token").listIssueComments("owner/repo", 42);
    expect(fetchMock).toHaveBeenCalledWith("https://api.github.com/repos/owner/repo/issues/42/comments?per_page=100&page=1", expect.anything());
  });
  it("fetches an individual review body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ id: 42, body: "fresh body" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(new GitHubClient("token").getReview("owner/repo", 1, 42)).resolves.toMatchObject({ body: "fresh body" });
    expect(fetchMock).toHaveBeenCalledWith("https://api.github.com/repos/owner/repo/pulls/1/reviews/42", expect.anything());
  });
  it("follows GraphQL thread cursors", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        data: { repository: { pullRequest: { reviewThreads: {
          nodes: [{ id: "t1", isResolved: false, comments: { nodes: [{ id: "101", author: { login: "bot" } }], pageInfo: { hasNextPage: true, endCursor: "comment-1" } } }],
          pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
        } } }, },
      }))
      .mockResolvedValueOnce(response({
        data: { node: { comments: { nodes: [{ id: "102", author: { login: "bot" } }], pageInfo: { hasNextPage: false } } } },
      }))
      .mockResolvedValueOnce(response({
        data: { repository: { pullRequest: { reviewThreads: {
          nodes: [{ id: "t2", isResolved: true, comments: { nodes: [], pageInfo: { hasNextPage: false } } }],
          pageInfo: { hasNextPage: false },
        } } }, },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const threads = await new GitHubClient("token").listThreads("owner/repo", 1);
    expect(threads).toHaveLength(2);
    expect(threads[0].comments.nodes.map(comment => comment.id)).toEqual([101, 102]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([url, init]) => url === "https://api.github.com/graphql" && !JSON.parse((init as RequestInit).body as string).query.match(/\bdatabaseId\b|\bside\b/))).toBe(true);
  });
});
