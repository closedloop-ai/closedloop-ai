"use client";

import { mergeAttributes, Node } from "@tiptap/core";
import {
  type NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer,
} from "@tiptap/react";
import mermaid from "mermaid";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { MermaidTransformPlugin } from "./mermaid-transform-plugin";
import { MermaidViewer } from "./mermaid-viewer";

type MermaidExtensionOptions = {
  /**
   * When true, render the rendered SVG via the interactive `MermaidViewer`
   * (pan/zoom, fullscreen, minimap, export). When false, render a static
   * SVG with a hover-reveal edit button (the pre-FEA-658 behavior). Gated
   * at call sites by the `mermaid-enhancements` feature flag.
   */
  enhancementsEnabled: boolean;
};

/**
 * Pre-FEA-658 renderer: static SVG with a hover-revealed Edit button.
 * Kept so the feature flag can fall back to the prior behavior.
 */
function LegacyMermaidDisplay({
  svg,
  onEdit,
}: Readonly<{ svg: string; onEdit: () => void }>) {
  return (
    <div className="group relative">
      <div
        className="mermaid-diagram overflow-x-auto"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: Mermaid generates safe SVG output
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <button
        className="absolute top-2 right-2 rounded border bg-background/80 px-3 py-1 text-sm opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100"
        onClick={onEdit}
        type="button"
      >
        Edit
      </button>
    </div>
  );
}

function MermaidComponent({
  node,
  updateAttributes,
  deleteNode,
  selected,
  extension,
}: Readonly<NodeViewProps>) {
  const { enhancementsEnabled } = extension.options as MermaidExtensionOptions;
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(node.attrs.content as string);
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);
  const isDark = mounted && resolvedTheme === "dark";

  useEffect(() => {
    const renderDiagram = async () => {
      if (!node.attrs.content || isEditing) {
        return;
      }

      mermaid.initialize({
        startOnLoad: false,
        theme: isDark ? "dark" : "default",
        securityLevel: "loose",
      });

      try {
        const id = `mermaid-${Math.random().toString(36).substring(2, 11)}`;
        const { svg: renderedSvg } = await mermaid.render(
          id,
          node.attrs.content as string
        );
        setSvg(renderedSvg);
        setError("");
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to render diagram"
        );
        setSvg("");
      }
    };

    renderDiagram();
  }, [node.attrs.content, isEditing, isDark]);

  function handleEdit() {
    setIsEditing(true);
    setEditContent(node.attrs.content);
  }

  function handleSave() {
    updateAttributes({ content: editContent });
    setIsEditing(false);
  }

  function handleCancel() {
    setEditContent(node.attrs.content);
    setIsEditing(false);
  }

  return (
    <NodeViewWrapper className="mermaid-wrapper">
      <div
        className={`my-4 overflow-hidden rounded-lg border bg-card shadow-sm transition-shadow ${
          selected ? "ring-2 ring-primary/50" : "hover:shadow-md"
        }`}
      >
        {isEditing ? (
          <div className="space-y-3 p-4">
            <div className="flex items-center gap-2">
              <span className="rounded-md bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                mermaid
              </span>
              <span className="text-muted-foreground text-xs">
                Edit diagram source
              </span>
            </div>
            <textarea
              className="min-h-[200px] w-full rounded-md border bg-muted/50 p-3 font-mono text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary/50"
              onChange={(e) => setEditContent(e.target.value)}
              placeholder="Enter Mermaid diagram code..."
              value={editContent}
            />
            <div className="flex gap-2">
              <button
                className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground text-sm transition-colors hover:bg-primary/90"
                onClick={handleSave}
                type="button"
              >
                Save
              </button>
              <button
                className="rounded-md border px-3 py-1.5 text-sm transition-colors hover:bg-accent"
                onClick={handleCancel}
                type="button"
              >
                Cancel
              </button>
              <button
                className="ml-auto rounded-md border border-destructive/50 px-3 py-1.5 text-destructive text-sm transition-colors hover:bg-destructive/10"
                onClick={deleteNode}
                type="button"
              >
                Delete
              </button>
            </div>
          </div>
        ) : (
          <div>
            {error && (
              <div className="p-4 text-destructive text-sm">
                <div className="font-semibold">Mermaid Error:</div>
                <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-2 text-xs">
                  {error}
                </pre>
                <button
                  className="mt-2 rounded-md border px-3 py-1 text-sm transition-colors hover:bg-accent"
                  onClick={handleEdit}
                  type="button"
                >
                  Edit Diagram
                </button>
              </div>
            )}
            {!error &&
              svg &&
              (enhancementsEnabled ? (
                <MermaidViewer onEdit={handleEdit} svg={svg} />
              ) : (
                <LegacyMermaidDisplay onEdit={handleEdit} svg={svg} />
              ))}
            {!(error || svg) && (
              <div className="flex min-h-[100px] items-center justify-center text-muted-foreground">
                <button
                  className="rounded-md border px-3 py-1 text-sm transition-colors hover:bg-accent"
                  onClick={handleEdit}
                  type="button"
                >
                  Add Mermaid Diagram
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </NodeViewWrapper>
  );
}

declare module "@tiptap/core" {
  // biome-ignore lint/style/useConsistentTypeDefinitions: type expansion require interface
  interface Commands<ReturnType> {
    mermaid: {
      setMermaid: (attrs: { content: string }) => ReturnType;
    };
  }
}

export const MermaidExtension = Node.create<MermaidExtensionOptions>({
  name: "mermaid",

  group: "block",

  atom: true,

  addOptions() {
    return {
      // Default OFF so unconfigured consumers (e.g. tests, preview environments)
      // get the stable legacy renderer. The app opts in via
      // MermaidExtension.configure({ enhancementsEnabled: ... }) driven by the
      // feature flag.
      enhancementsEnabled: false,
    };
  },

  addAttributes() {
    return {
      content: {
        default: "",
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "div[data-type=mermaid]",
      },
      {
        tag: "pre",
        getAttrs: (node) => {
          const codeElement = node.querySelector("code.language-mermaid");
          if (codeElement) {
            return { content: codeElement.textContent || "" };
          }
          return false;
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "mermaid" })];
  },

  addCommands() {
    return {
      setMermaid:
        (attrs) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs,
          });
        },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(MermaidComponent);
  },

  renderMarkdown: (node: { attrs?: { content?: string } }) => {
    const content = node.attrs?.content || "";
    return `\`\`\`mermaid\n${content}\n\`\`\`\n\n`;
  },

  addProseMirrorPlugins() {
    return [MermaidTransformPlugin];
  },
});
