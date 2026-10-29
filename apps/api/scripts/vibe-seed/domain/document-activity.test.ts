import { DocumentStatus } from "@repo/api/src/types/document";
import { describe, expect, it } from "vitest";
import { remainingHistory } from "./document-activity";

const HISTORY = [
  DocumentStatus.Draft,
  DocumentStatus.InReview,
  DocumentStatus.ChangesRequested,
  DocumentStatus.InReview,
  DocumentStatus.Approved,
];

describe("remainingHistory", () => {
  it("walks every change after the starting status on a first run", () => {
    expect(remainingHistory(HISTORY, 0)).toEqual(HISTORY.slice(1));
  });

  it("resumes after the changes an earlier run recorded, repeats included", () => {
    expect(remainingHistory(HISTORY, 3)).toEqual([DocumentStatus.Approved]);
  });

  it("has nothing left once every change is recorded", () => {
    expect(remainingHistory(HISTORY, 4)).toEqual([]);
    expect(remainingHistory(HISTORY, 9)).toEqual([]);
  });
});
