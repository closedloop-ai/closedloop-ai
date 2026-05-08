import type { JSONContent } from "@tiptap/react";
import { describe, expect, test } from "vitest";
import { mergeCommentMarks } from "../merge-comment-marks";

const commentMark = (threadId: string) => ({
  type: "liveblocksCommentMark" as const,
  attrs: { threadId },
});

function textNode(text: string, marks?: JSONContent["marks"]): JSONContent {
  return { type: "text", text, marks };
}

function paragraph(...content: JSONContent[]): JSONContent {
  return { type: "paragraph", content };
}

function doc(...blocks: JSONContent[]): JSONContent {
  return { type: "doc", content: blocks };
}

describe("mergeCommentMarks", () => {
  test("returns snapshot when current has no comment marks", () => {
    const snapshot = doc(paragraph(textNode("Hello world")));
    const current = doc(paragraph(textNode("Hello world edited")));

    const result = mergeCommentMarks(snapshot, current);
    expect(result).toEqual(snapshot);
  });

  test("returns snapshot when snapshot has no content", () => {
    const snapshot: JSONContent = { type: "doc" };
    const current = doc(paragraph(textNode("text", [commentMark("thread-1")])));

    const result = mergeCommentMarks(snapshot, current);
    expect(result).toEqual(snapshot);
  });

  test("returns snapshot when current has no content", () => {
    const snapshot = doc(paragraph(textNode("Hello")));
    const current: JSONContent = { type: "doc" };

    const result = mergeCommentMarks(snapshot, current);
    expect(result).toEqual(snapshot);
  });

  test("preserves comment marks on unchanged text", () => {
    const snapshot = doc(paragraph(textNode("Hello world")));
    const current = doc(
      paragraph(textNode("Hello world", [commentMark("thread-1")]))
    );

    const result = mergeCommentMarks(snapshot, current);

    // The merged result should have the comment mark from current
    const firstBlock = result.content![0];
    const firstText = firstBlock.content![0];
    expect(firstText.marks).toEqual([commentMark("thread-1")]);
  });

  test("does not add marks when text was modified", () => {
    const snapshot = doc(paragraph(textNode("Original text")));
    const current = doc(
      paragraph(textNode("Modified text", [commentMark("thread-1")]))
    );

    const result = mergeCommentMarks(snapshot, current);

    // Text differs, so snapshot block stays as-is (no marks)
    const firstBlock = result.content![0];
    const firstText = firstBlock.content![0];
    expect(firstText.marks).toBeUndefined();
  });

  test("handles multiple blocks with different comment states", () => {
    const snapshot = doc(
      paragraph(textNode("First paragraph")),
      paragraph(textNode("Second paragraph")),
      paragraph(textNode("Third paragraph"))
    );
    const current = doc(
      paragraph(textNode("First paragraph", [commentMark("thread-1")])),
      paragraph(textNode("Second modified")),
      paragraph(textNode("Third paragraph", [commentMark("thread-2")]))
    );

    const result = mergeCommentMarks(snapshot, current);

    // First: unchanged text, marks preserved
    expect(result.content![0].content![0].marks).toEqual([
      commentMark("thread-1"),
    ]);
    // Second: text changed in current, no mark in snapshot anyway
    expect(result.content![1].content![0].text).toBe("Second paragraph");
    expect(result.content![1].content![0].marks).toBeUndefined();
    // Third: unchanged text, marks preserved
    expect(result.content![2].content![0].marks).toEqual([
      commentMark("thread-2"),
    ]);
  });

  test("handles duplicate text blocks with FIFO matching", () => {
    const snapshot = doc(
      paragraph(textNode("Same text")),
      paragraph(textNode("Same text"))
    );
    const current = doc(
      paragraph(textNode("Same text", [commentMark("thread-1")])),
      paragraph(textNode("Same text", [commentMark("thread-2")]))
    );

    const result = mergeCommentMarks(snapshot, current);

    // First occurrence gets thread-1, second gets thread-2
    expect(result.content![0].content![0].marks).toEqual([
      commentMark("thread-1"),
    ]);
    expect(result.content![1].content![0].marks).toEqual([
      commentMark("thread-2"),
    ]);
  });

  test("does not mutate the original snapshot", () => {
    const snapshot = doc(paragraph(textNode("Hello world")));
    const snapshotCopy = JSON.parse(JSON.stringify(snapshot));
    const current = doc(
      paragraph(textNode("Hello world", [commentMark("thread-1")]))
    );

    mergeCommentMarks(snapshot, current);

    expect(snapshot).toEqual(snapshotCopy);
  });

  test("skips blocks with empty text", () => {
    const snapshot = doc(
      paragraph(), // empty paragraph
      paragraph(textNode("Real content"))
    );
    const current = doc(
      paragraph(), // empty paragraph
      paragraph(textNode("Real content", [commentMark("thread-1")]))
    );

    const result = mergeCommentMarks(snapshot, current);

    // Empty paragraph untouched, second block gets marks
    expect(result.content![0].content ?? []).toEqual([]);
    expect(result.content![1].content![0].marks).toEqual([
      commentMark("thread-1"),
    ]);
  });
});
