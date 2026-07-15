import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { MermaidTransformPlugin } from "./mermaid-transform-plugin";

function getAppendTransaction() {
  const fn = MermaidTransformPlugin.spec.appendTransaction;
  if (!fn) {
    throw new Error("MermaidTransformPlugin must define appendTransaction");
  }
  return fn;
}

const appendTransaction = getAppendTransaction();

// Minimal ProseMirror schema mirroring the codeBlock + mermaid node types the
// plugin transforms between. No DOM serialization is exercised.
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    text: { group: "inline" },
    codeBlock: {
      group: "block",
      content: "text*",
      code: true,
      attrs: { language: { default: null } },
    },
    mermaid: {
      group: "block",
      atom: true,
      attrs: { content: { default: "" } },
    },
  },
});

const schemaWithoutMermaid = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    text: { group: "inline" },
    codeBlock: {
      group: "block",
      content: "text*",
      code: true,
      attrs: { language: { default: null } },
    },
  },
});

describe("MermaidTransformPlugin appendTransaction", () => {
  it("replaces a mermaid codeBlock with a mermaid node", () => {
    const state = createState(schema, [
      schema.node("paragraph", null, [schema.text("intro")]),
      schema.node("codeBlock", { language: "mermaid" }, [
        schema.text("graph TD; A-->B;"),
      ]),
    ]);

    const result = runAppend(state);

    expect(result).not.toBeNull();
    if (!result) {
      return;
    }
    expect(collectMermaidContent(result.doc)).toEqual(["graph TD; A-->B;"]);
    expect(countCodeBlocks(result.doc)).toBe(0);
  });

  it("replaces multiple mermaid code blocks while preserving their content", () => {
    const state = createState(schema, [
      schema.node("paragraph", null, [schema.text("intro")]),
      schema.node("codeBlock", { language: "mermaid" }, [
        schema.text("graph TD; A-->B;"),
      ]),
      schema.node("paragraph", null, [schema.text("middle")]),
      schema.node("codeBlock", { language: "mermaid" }, [
        schema.text("sequenceDiagram; A->>B: hi"),
      ]),
    ]);

    const result = runAppend(state);

    expect(result).not.toBeNull();
    if (!result) {
      return;
    }
    expect(collectMermaidContent(result.doc)).toEqual([
      "graph TD; A-->B;",
      "sequenceDiagram; A->>B: hi",
    ]);
    expect(countCodeBlocks(result.doc)).toBe(0);
  });

  it("leaves non-mermaid code blocks untouched", () => {
    const state = createState(schema, [
      schema.node("paragraph", null, [schema.text("intro")]),
      schema.node("codeBlock", { language: "mermaid" }, [
        schema.text("graph TD; A-->B;"),
      ]),
      schema.node("codeBlock", { language: "ts" }, [
        schema.text("const a = 1;"),
      ]),
    ]);

    const result = runAppend(state);

    expect(result).not.toBeNull();
    if (!result) {
      return;
    }
    expect(collectMermaidContent(result.doc)).toEqual(["graph TD; A-->B;"]);
    expect(countCodeBlocks(result.doc)).toBe(1);
  });

  it("returns null when no transaction changed the document", () => {
    const state = createState(schema, [
      schema.node("codeBlock", { language: "mermaid" }, [
        schema.text("graph TD; A-->B;"),
      ]),
    ]);

    // An empty transaction reports docChanged === false.
    const result = appendTransaction([state.tr], state, state);

    expect(result).toBeNull();
  });

  it("returns null when the document has no mermaid code blocks", () => {
    const state = createState(schema, [
      schema.node("paragraph", null, [schema.text("intro")]),
      schema.node("codeBlock", { language: "ts" }, [
        schema.text("const a = 1;"),
      ]),
    ]);

    expect(runAppend(state)).toBeNull();
  });

  it("returns null when the schema lacks a mermaid node type", () => {
    const state = createState(schemaWithoutMermaid, [
      schemaWithoutMermaid.node("paragraph", null, [
        schemaWithoutMermaid.text("intro"),
      ]),
      schemaWithoutMermaid.node("codeBlock", { language: "mermaid" }, [
        schemaWithoutMermaid.text("graph TD; A-->B;"),
      ]),
    ]);

    expect(runAppend(state)).toBeNull();
  });
});

function createState(nodeSchema: Schema, content: ProseMirrorNode[]) {
  return EditorState.create({
    schema: nodeSchema,
    doc: nodeSchema.node("doc", null, content),
  });
}

// Apply a document-changing transaction so the plugin's docChanged guard
// passes, then run the plugin's appendTransaction against the new state.
function runAppend(state: EditorState) {
  const changeTr = state.tr.insertText("x", 1);
  const changedState = state.apply(changeTr);
  return appendTransaction([changeTr], state, changedState);
}

function collectMermaidContent(doc: ProseMirrorNode) {
  const contents: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === "mermaid") {
      contents.push(node.attrs.content);
    }
    return true;
  });
  return contents;
}

function countCodeBlocks(doc: ProseMirrorNode) {
  let count = 0;
  doc.descendants((node) => {
    if (node.type.name === "codeBlock") {
      count += 1;
    }
    return true;
  });
  return count;
}
