// @vitest-environment jsdom

import { schema } from "@tiptap/pm/schema-basic";
import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import {
  createInlineImageUploadPlaceholderPlugin,
  findInlineImagePlaceholderPosition,
  inlineImageUploadPlaceholderKey,
} from "./inline-image-upload-placeholder";
import type { TiptapEditor } from "./types";

function createState() {
  return EditorState.create({
    schema,
    plugins: [createInlineImageUploadPlaceholderPlugin()],
  });
}

function decorationCount(state: EditorState) {
  return inlineImageUploadPlaceholderKey.getState(state)?.find().length ?? 0;
}

function asEditor(state: EditorState) {
  return { state } as TiptapEditor;
}

describe("inline image upload placeholder plugin", () => {
  it("starts with an empty decoration set", () => {
    const state = createState();
    expect(decorationCount(state)).toBe(0);
  });

  it("adds a placeholder widget at the requested position", () => {
    const state = createState().apply(
      createState().tr.setMeta(inlineImageUploadPlaceholderKey, {
        type: "add",
        id: "upload-1",
        pos: 1,
        label: "Uploading photo.png",
      })
    );

    expect(decorationCount(state)).toBe(1);
    expect(
      findInlineImagePlaceholderPosition(asEditor(state), "upload-1")
    ).toBe(1);
  });

  it("round-trips add then remove back to an empty set", () => {
    const initial = createState();
    const added = initial.apply(
      initial.tr.setMeta(inlineImageUploadPlaceholderKey, {
        type: "add",
        id: "upload-1",
        pos: 1,
        label: "Uploading photo.png",
      })
    );
    expect(decorationCount(added)).toBe(1);

    const removed = added.apply(
      added.tr.setMeta(inlineImageUploadPlaceholderKey, {
        type: "remove",
        id: "upload-1",
      })
    );

    expect(decorationCount(removed)).toBe(0);
    expect(
      findInlineImagePlaceholderPosition(asEditor(removed), "upload-1")
    ).toBeNull();
  });

  it("removes only the targeted placeholder when several are active", () => {
    let state = createState();
    for (const id of ["upload-1", "upload-2"]) {
      state = state.apply(
        state.tr.setMeta(inlineImageUploadPlaceholderKey, {
          type: "add",
          id,
          pos: 1,
          label: `Uploading ${id}`,
        })
      );
    }
    expect(decorationCount(state)).toBe(2);

    state = state.apply(
      state.tr.setMeta(inlineImageUploadPlaceholderKey, {
        type: "remove",
        id: "upload-1",
      })
    );

    expect(decorationCount(state)).toBe(1);
    expect(
      findInlineImagePlaceholderPosition(asEditor(state), "upload-1")
    ).toBeNull();
    expect(
      findInlineImagePlaceholderPosition(asEditor(state), "upload-2")
    ).toBe(1);
  });

  it("maps the placeholder position when content is inserted before it", () => {
    // Start from a paragraph containing "ab" so the widget sits in the
    // document interior (pos 3, after "b") and the insertion point is
    // unambiguously before it.
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("ab")]),
    ]);
    const initial = EditorState.create({
      doc,
      plugins: [createInlineImageUploadPlaceholderPlugin()],
    });
    const added = initial.apply(
      initial.tr.setMeta(inlineImageUploadPlaceholderKey, {
        type: "add",
        id: "upload-1",
        pos: 3,
        label: "Uploading photo.png",
      })
    );
    expect(
      findInlineImagePlaceholderPosition(asEditor(added), "upload-1")
    ).toBe(3);

    // Insert two characters before the widget; the decoration must shift by 2.
    const shifted = added.apply(added.tr.insertText("XY", 1));

    expect(decorationCount(shifted)).toBe(1);
    expect(
      findInlineImagePlaceholderPosition(asEditor(shifted), "upload-1")
    ).toBe(5);
  });

  it("returns null for an unknown upload id", () => {
    const state = createState();
    expect(
      findInlineImagePlaceholderPosition(asEditor(state), "missing")
    ).toBeNull();
  });

  it("ignores a remove for an id that was never added", () => {
    const initial = createState();
    const state = initial.apply(
      initial.tr.setMeta(inlineImageUploadPlaceholderKey, {
        type: "remove",
        id: "never-added",
      })
    );
    expect(decorationCount(state)).toBe(0);
  });
});
