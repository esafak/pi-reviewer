import { describe, expect, it } from "vite-plus/test";
import { bodyFindingId, decodeBodyFindingMarkers, encodeBodyFindingMarker, reconstructBodyFindings, updateBodyFindingMarker } from "../../src/ci/batch.js";

const finding = { findingId: bodyFindingId(["src/a.ts", 1, "RIGHT", "issue"].join("\0")), file: "src/a.ts", line: 1, side: "RIGHT" as const, severity: "WARN" as const, body: "issue" };

describe("body finding markers", () => {
  it("round trips multiple findings and assigns positive stable IDs", () => {
    const body = [encodeBodyFindingMarker(finding), encodeBodyFindingMarker({ ...finding, findingId: bodyFindingId("other") })].join("\n");
    const decoded = decodeBodyFindingMarkers(body);
    expect(decoded).toHaveLength(2);
    expect(decoded[0]).toMatchObject(finding);
    expect(bodyFindingId("other")).toBeGreaterThan(0);
    expect(bodyFindingId("other")).toBe(bodyFindingId("other"));
  });

  it("reconstructs only active authenticated review-body findings", () => {
    const body = `summary\n${encodeBodyFindingMarker(finding)}\n${encodeBodyFindingMarker({ ...finding, findingId: bodyFindingId("resolved"), status: "RESOLVED" })}`;
    expect(reconstructBodyFindings([{ id: 9, body, user: { login: "bot" } }, { id: 10, body, user: { login: "human" } }], "bot")).toEqual([expect.objectContaining({ commentId: finding.findingId, reviewId: 9, bodyFinding: true, body: "issue" })]);
  });

  it("updates lifecycle metadata without changing visible review text", () => {
    const body = `summary\n\n${encodeBodyFindingMarker(finding)}\n> 🟡 issue`;
    const updated = updateBodyFindingMarker(body, finding.findingId, "RESOLVED", "head", "fixed");
    expect(updated).toContain("summary\n\n");
    expect(updated).toContain("> 🟡 issue");
    expect(decodeBodyFindingMarkers(updated)[0]).toMatchObject({ findingId: finding.findingId, status: "RESOLVED", targetSha: "head", explanation: "fixed" });
  });

  it("escapes comment terminators in metadata while preserving the finding text", () => {
    const value = { ...finding, body: "keep --> visible" };
    const encoded = encodeBodyFindingMarker(value);
    expect(encoded).not.toContain('"body":"keep --> visible"');
    expect(decodeBodyFindingMarkers(encoded)[0]).toMatchObject(value);
    expect(updateBodyFindingMarker(encoded, finding.findingId, "RESOLVED", "head", "fixed")).toContain('"body":"keep --\\u003e visible"');
    expect(decodeBodyFindingMarkers(updateBodyFindingMarker(encoded, finding.findingId, "RESOLVED", "head", "fixed"))[0]).toMatchObject({ ...value, status: "RESOLVED", targetSha: "head", explanation: "fixed" });
  });
});
