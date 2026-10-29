import type { Node } from "@tiptap/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";
import { Markdown, type MarkdownExtensionOptions } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { InlineImageNode } from "./inline-image";
import { isAllowedLinkUri } from "./link-uri-policy";
import { MermaidNode } from "./mermaid";

export type DocumentExtensionsOptions = {
  /** The `mermaid` node; the editor passes its node-view extension. */
  mermaidNode?: Node;
  /** The `inlineImage` node; the editor passes its node-view extension. */
  inlineImageNode?: Node;
  /** False when Yjs owns history (the Liveblocks / Collaboration paths). */
  undoRedo?: boolean;
  /**
   * The `marked` the markdown manager registers its tokenizers on. Omitted, it
   * is the process-wide `marked` singleton.
   */
  marked?: MarkdownExtensionOptions["marked"];
};

/**
 * The document's schema-bearing extensions, in schema order. The editor and
 * the service both build from this list; reordering it changes node order and
 * mark rank.
 */
export function createDocumentExtensions({
  mermaidNode = MermaidNode,
  inlineImageNode = InlineImageNode,
  undoRedo = true,
  marked,
}: DocumentExtensionsOptions = {}) {
  assertNodeName(mermaidNode, MermaidNode.name);
  assertNodeName(inlineImageNode, InlineImageNode.name);
  return [
    StarterKit.configure({
      // Configure heading levels to match markdown
      heading: {
        levels: [1, 2, 3],
      },
      // Keep the default codeBlock for non-mermaid code
      codeBlock: {
        languageClassPrefix: "language-",
      },
      ...(!undoRedo && { undoRedo: false }),
      // Pin the link-protocol policy so it can't silently change across
      // Tiptap upgrades. The bundled Link mark's default allowlist also
      // permits ftp/tel/sms/etc, so we reject any scheme other than
      // http(s)/mailto (this also blocks javascript:/data:). Schemeless URLs
      // — relative paths and in-page #fragments — fall through to Tiptap's
      // defaultValidate so existing markdown links keep working.
      // isAllowedUri is the real XSS gate in Tiptap v3 (it guards setLink,
      // toggleLink, paste, parseHTML and renderHTML), so pinning it here is
      // true defense-in-depth covering non-toolbar callers (e.g. programmatic
      // API consumers). HTMLAttributes pins the already-secure default (new
      // tab + rel="noopener noreferrer nofollow") so it survives upgrades too.
      link: {
        protocols: ["http", "https", "mailto"],
        isAllowedUri: (url, { defaultValidate }) =>
          isAllowedLinkUri(url, defaultValidate),
        HTMLAttributes: {
          rel: "noopener noreferrer nofollow",
          target: "_blank",
        },
      },
    }),
    Markdown.configure({
      marked,
      markedOptions: {
        // Claude Code uses GitHub Flavored Markdown
        gfm: true,
      },
    }),
    mermaidNode,
    inlineImageNode,
    Table.configure({
      resizable: true,
    }),
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem,
  ];
}

/** A substitute node must keep the base node's name, or the schema changes. */
function assertNodeName(node: Node, expected: string) {
  if (node.name !== expected) {
    throw new Error(
      `createDocumentExtensions expected a "${expected}" node, got "${node.name}"`
    );
  }
}
