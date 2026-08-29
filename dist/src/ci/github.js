export class GitHubError extends Error {
    status;
    details;
    constructor(status, message, details = "") {
        super(message);
        this.status = status;
        this.details = details;
    }
}
export class GitHubClient {
    token;
    base;
    constructor(token, base = "https://api.github.com") {
        this.token = token;
        this.base = base;
    }
    async request(url, init = {}) {
        const response = await fetch(url.startsWith("http") ? url : `${this.base}${url}`, {
            ...init, headers: { accept: "application/vnd.github+json", authorization: `Bearer ${this.token}`, "x-github-api-version": "2022-11-28", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
        });
        const text = await response.text();
        if (!response.ok)
            throw new GitHubError(response.status, `GitHub API ${response.status}: ${response.statusText}`, text);
        return (text ? JSON.parse(text) : undefined);
    }
    getUser() { return this.request("/user"); }
    getPullRequest(repo, number) { return this.request(`/repos/${repo}/pulls/${number}`); }
    async list(url) { const all = []; for (let page = 1;; page++) {
        const values = await this.request(`${url}?per_page=100&page=${page}`);
        all.push(...values);
        if (values.length < 100)
            return all;
    } }
    listReviews(repo, number) { return this.list(`/repos/${repo}/pulls/${number}/reviews`); }
    listComments(repo, number) { return this.list(`/repos/${repo}/pulls/${number}/comments`); }
    createReview(repo, number, body, commit_id, comments) { return this.request(`/repos/${repo}/pulls/${number}/reviews`, { method: "POST", body: JSON.stringify({ body, commit_id, event: "COMMENT", comments }) }); }
    updateReview(repo, number, review, body) { return this.request(`/repos/${repo}/pulls/${number}/reviews/${review}`, { method: "PUT", body: JSON.stringify({ body }) }); }
    reply(repo, number, comment, body) { return this.request(`/repos/${repo}/pulls/${number}/comments`, { method: "POST", body: JSON.stringify({ body, in_reply_to: comment }) }); }
    async graphql(query, variables) { const result = await this.request("https://api.github.com/graphql", { method: "POST", body: JSON.stringify({ query, variables }) }); if (result.errors?.length)
        throw new Error(result.errors.map(e => e.message).join("; ")); return result.data; }
    resolveThread(threadId) { return this.graphql("mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}", { id: threadId }); }
    async listThreads(repo, number) {
        const [owner, name] = repo.split("/");
        const all = [];
        let cursor;
        do {
            const page = await this.graphql("query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{id isResolved comments(first:100){nodes{id:databaseId body path line side author{login __typename}} pageInfo{hasNextPage endCursor}}} pageInfo{hasNextPage endCursor}}}}}", { owner, name, number, cursor });
            const connection = page.repository.pullRequest.reviewThreads;
            for (const t of connection.nodes) {
                const nodes = t.comments.nodes.map((c) => ({ ...c, user: c.author }));
                let commentCursor = t.comments.pageInfo.hasNextPage ? t.comments.pageInfo.endCursor : undefined;
                while (commentCursor) {
                    const next = await this.graphql("query($id:ID!,$cursor:String){node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$cursor){nodes{id:databaseId body path line side author{login __typename}} pageInfo{hasNextPage endCursor}}}}}", { id: t.id, cursor: commentCursor });
                    const comments = next.node.comments;
                    nodes.push(...comments.nodes.map((c) => ({ ...c, user: c.author })));
                    commentCursor = comments.pageInfo.hasNextPage ? comments.pageInfo.endCursor : undefined;
                }
                all.push({ id: t.id, isResolved: t.isResolved, comments: { nodes, pageInfo: { hasNextPage: false } } });
            }
            cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : undefined;
        } while (cursor);
        return all;
    }
}
