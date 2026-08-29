import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { GitHubClient, GitHubError } from "../../src/ci/github.js";

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
  it("follows GraphQL thread cursors", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: "t1", isResolved: false, comments: { nodes: [], pageInfo: { hasNextPage: false } } }], pageInfo: { hasNextPage: true, endCursor: "cursor-1" } } } } } }))
      .mockResolvedValueOnce(response({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: "t2", isResolved: true, comments: { nodes: [], pageInfo: { hasNextPage: false } } }], pageInfo: { hasNextPage: false } } } } } }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await new GitHubClient("token").listThreads("owner/repo", 1)).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
