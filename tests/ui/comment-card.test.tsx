// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";
import { AI_FIX_FOOTER } from "../../src/core/ai-fix-footer.js";
import { CommentCard } from "../../ui/src/components/CommentCard.js";
import { FileDiff } from "../../ui/src/components/diff/FileDiff.js";
import { OrphanComments } from "../../ui/src/components/diff/OrphanComments.js";
import { SettingsProvider } from "../../ui/src/context/SettingsContext.js";
import { parseDiff } from "../../ui/src/utils/diff-parser.js";

const comment = {
  file: "src/example.ts",
  line: 12,
  severity: "WARN",
  body: "**Please handle this error.**\n\n```ts\nreturn fallback;\n```",
};

describe("CommentCard response disclosure", () => {
  it("starts closed and toggles while keeping decision controls available", async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn();
    const view = render(<CommentCard comment={comment} idx={0} onDecide={onDecide} />);

    const summary = view.container.querySelector("summary") as HTMLElement;
    const details = summary.closest("details");
    expect(details).not.toBeNull();
    expect((details as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();

    await user.click(summary);
    expect((details as HTMLDetailsElement).open).toBe(true);
    expect(screen.getByText("Please handle this error.")).toBeTruthy();
    const footer = view.container.querySelector(".cc-response-footer");
    expect(footer).toBeTruthy();
    expect(footer?.textContent?.trim()).toBeTruthy();
    expect(document.activeElement).toBe(summary);

    await user.click(screen.getByRole("button", { name: "Accept" }));
    expect(onDecide).toHaveBeenCalledWith(0, "accept", "");
  });

  it("preserves the open state when the parent rerenders", async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn();
    const view = render(<CommentCard comment={comment} idx={0} onDecide={onDecide} />);
    await user.click(view.container.querySelector("summary") as HTMLElement);

    view.rerender(<CommentCard comment={comment} idx={0} decision="accept" onDecide={onDecide} />);
    expect((view.container.querySelector("details") as HTMLDetailsElement).open).toBe(true);
  });

  it("renders the same disclosure for orphan comments", () => {
    const onDecide = vi.fn();
    render(
      <OrphanComments
        comments={[{ comment, idx: 3 }]}
        decisions={{}}
        onDecide={onDecide}
      />,
    );

    expect(document.querySelector("#cmt-3 details")).toBeTruthy();
  });

  it("renders the same disclosure for comments attached to a diff", () => {
    const onDecide = vi.fn();
    const [file] = parseDiff(
      "diff --git a/src/example.ts b/src/example.ts\n@@ -12,1 +12,1 @@\n-old\n+new\n",
    );
    render(
      <SettingsProvider initial={{ viewMode: "split", autoCollapseViewed: false }} availableModels={[]}>
        <FileDiff
          file={file}
          comments={[{ comment: { ...comment, side: "RIGHT" }, idx: 4 }]}
          decisions={{}}
          onDecide={onDecide}
        />
      </SettingsProvider>,
    );

    expect(document.querySelector("#cmt-4 details")).toBeTruthy();
  });

  it("copies the complete self-contained prompt shown in the disclosure", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const onDecide = vi.fn();
    const view = render(<CommentCard comment={{ ...comment, side: "RIGHT" }} idx={6} onDecide={onDecide} />);

    const disclosure = view.container.querySelector(".cc-body");
    expect(disclosure?.textContent).toContain("Context:");
    expect(disclosure?.textContent).toContain("src/example.ts:12");

    await user.click(view.container.querySelector(".cc-copy") as HTMLElement);
    expect(writeText).toHaveBeenCalledWith(
      `**Context:** \`src/example.ts:12\` · RIGHT · WARN\n\n${comment.body}\n\n${AI_FIX_FOOTER}`,
    );
  });
});
