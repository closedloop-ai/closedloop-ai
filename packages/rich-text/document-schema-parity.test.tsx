// @vitest-environment jsdom

import { createDocumentExtensions } from "@repo/document-schema/extensions";
import { markdownToDocument } from "@repo/document-schema/markdown";
import { act, render, waitFor } from "@testing-library/react";
import { getSchema } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";
import { TiptapEditorCore } from "./tiptap-editor-core";
import type { TiptapEditor } from "./types";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(() => new Promise(() => undefined)),
  },
}));

const ATTACHMENT_SRC = "attachment://00000000-0000-4000-8000-000000000001";
const MERMAID_FENCE = "```mermaid\ngraph TD; A-->B\n```";

const CORPUS: ReadonlyArray<{ name: string; markdown: string }> = [
  {
    name: "headings, inline marks and links",
    markdown: [
      "# One",
      "## Two",
      "### Three",
      "#### Four",
      "**bold** *italic* ~~strike~~ `code`",
      "[allowed](https://example.com) [script](javascript:alert(1)) https://bare.example.com",
    ].join("\n\n"),
  },
  {
    name: "lists, tasks, quote, rule and hard break",
    markdown: [
      "- one\n  - nested\n- two",
      "1. first\n   1. inner\n2. second",
      "- [ ] open\n- [x] done",
      "> quoted",
      "---",
      "line one  \nline two",
    ].join("\n\n"),
  },
  {
    name: "code block and mermaid mid-document",
    markdown: `\`\`\`ts\nconst a = 1;\n\`\`\`\n\n${MERMAID_FENCE}\n\nAfter`,
  },
  { name: "mermaid last", markdown: `Before\n\n${MERMAID_FENCE}` },
  {
    name: "regular and ragged tables",
    markdown:
      "| a | b |\n|---|---|\n| 1 | 2 |\n\nBetween\n\n| a | b | c |\n|---|---|---|\n| 1 |\n",
  },
  {
    name: "attachment and external images",
    markdown: `![Card](${ATTACHMENT_SRC} "width=480 align=right") and ![ext](https://example.com/a.png)`,
  },
  {
    name: "table cell with a saved <br>",
    markdown: "| h |\n| --- |\n| a<br>b |\n",
  },
  {
    name: "legacy attachment <img>",
    markdown: `Before\n\n<img src="${ATTACHMENT_SRC}">\n\nAfter`,
  },
  { name: "empty input", markdown: "" },
];

async function renderEditor(): Promise<TiptapEditor> {
  let editor: TiptapEditor | null = null;
  render(
    <TiptapEditorCore
      externalToolbar
      onChange={() => undefined}
      onEditorReady={(instance) => {
        editor = instance;
      }}
      value=""
    />
  );
  await waitFor(() => expect(editor).not.toBeNull());
  if (!editor) {
    throw new Error("editor never became ready");
  }
  return editor;
}

/** The `setEditorMarkdown` path the Liveblocks room seed takes. */
async function seed(editor: TiptapEditor, markdown: string) {
  await act(async () => {
    editor.resetContent?.(markdown);
    await Promise.resolve();
  });
}

describe("editor and service build the same document", () => {
  it.each(CORPUS)("$name", async ({ markdown }) => {
    const editor = await renderEditor();
    await seed(editor, markdown);

    const serviceJson = markdownToDocument(markdown).toJSON();
    expect(editor.getJSON()).toEqual(serviceJson);

    act(() => {
      editor.commands.setContent(serviceJson);
    });
    expect(editor.getJSON()).toEqual(serviceJson);
  });

  it("registers exactly the shared schema's nodes and marks, in order", async () => {
    const editor = await renderEditor();
    const shared = getSchema(createDocumentExtensions());

    expect(Object.keys(editor.schema.nodes)).toEqual(Object.keys(shared.nodes));
    expect(Object.keys(editor.schema.marks)).toEqual(Object.keys(shared.marks));
  });
});
