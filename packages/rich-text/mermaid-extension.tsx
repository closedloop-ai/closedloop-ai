"use client";

import { Textarea } from "@repo/design-system/components/ui/textarea";
import { MermaidNode } from "@repo/document-schema/mermaid";
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import mermaid from "mermaid";
import { useTheme } from "next-themes";
import { type RefObject, useEffect, useRef, useState } from "react";
import {
  applyMermaidSvgTheme,
  getMermaidConfig,
  type MermaidInitializeConfig,
  MermaidThemeMode,
} from "./mermaid-theme";
import { MermaidViewer } from "./mermaid-viewer";

/**
 * `mermaid.initialize` mutates Mermaid's module-global config object. Two
 * diagrams rendering concurrently can race if each render blindly writes that
 * config before its async `render()` call executes.
 *
 * `getMermaidConfig()` intentionally returns a fresh object so callers cannot
 * mutate shared config. Cache a stable semantic key instead of object identity
 * so repeated diagrams dedupe initialization while config drift still
 * reinitializes Mermaid.
 */
let lastInitializedConfigKey: string | null = null;

function ensureMermaidInitialized(mode: MermaidThemeMode) {
  const config = getMermaidConfig(mode);
  const configKey = getMermaidConfigKey(mode, config);
  if (lastInitializedConfigKey === configKey) {
    return;
  }
  mermaid.initialize(config);
  lastInitializedConfigKey = configKey;
}

type MermaidNodeViewProps = {
  deleteNode: () => void;
  node: { attrs: { content?: string } };
  selected: boolean;
  updateAttributes: (attrs: { content: string }) => void;
};

export function MermaidComponent({
  node,
  updateAttributes,
  deleteNode,
  selected,
}: Readonly<MermaidNodeViewProps>) {
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(node.attrs.content ?? "");
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [documentDark, setDocumentDark] = useState(false);
  const renderSeqRef = useRef(0);
  const latestRenderStateRef = useRef<MermaidRenderState>({
    content: normalizeMermaidContent(node.attrs.content),
    isEditing,
    mode: MermaidThemeMode.Light,
  });

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!mounted) {
      return;
    }

    const updateDocumentDark = () => {
      setDocumentDark(document.documentElement.classList.contains("dark"));
    };
    updateDocumentDark();

    const observer = new MutationObserver(updateDocumentDark);
    observer.observe(document.documentElement, {
      attributeFilter: ["class"],
      attributes: true,
    });

    return () => observer.disconnect();
  }, [mounted]);
  // `resolvedTheme` is the normal production signal. The document class
  // fallback keeps Mermaid in sync during forced-theme/hydration windows where
  // next-themes has already updated the DOM but has not published the value.
  const isDark = mounted && (resolvedTheme === "dark" || documentDark);
  const themeMode = isDark ? MermaidThemeMode.Dark : MermaidThemeMode.Light;

  useEffect(() => {
    const requestSeq = renderSeqRef.current + 1;
    renderSeqRef.current = requestSeq;
    const requestState = {
      content: normalizeMermaidContent(node.attrs.content),
      isEditing,
      mode: themeMode,
    };
    latestRenderStateRef.current = requestState;

    if (!requestState.content || requestState.isEditing) {
      if (
        isCurrentRenderRequest(
          requestSeq,
          requestState,
          renderSeqRef,
          latestRenderStateRef
        )
      ) {
        setSvg("");
        setError("");
      }
      return;
    }

    const renderDiagram = async () => {
      ensureMermaidInitialized(requestState.mode);

      try {
        const id = `mermaid-${Math.random().toString(36).slice(2, 11)}`;
        const { svg: renderedSvg } = await mermaid.render(
          id,
          requestState.content
        );
        if (
          !isCurrentRenderRequest(
            requestSeq,
            requestState,
            renderSeqRef,
            latestRenderStateRef
          )
        ) {
          return;
        }
        setSvg(applyMermaidSvgTheme(renderedSvg, requestState.mode));
        setError("");
      } catch (err) {
        if (
          !isCurrentRenderRequest(
            requestSeq,
            requestState,
            renderSeqRef,
            latestRenderStateRef
          )
        ) {
          return;
        }
        setError(
          err instanceof Error ? err.message : "Failed to render diagram"
        );
        setSvg("");
      }
    };

    renderDiagram();
  }, [node.attrs.content, isEditing, themeMode]);

  function handleEdit() {
    setIsEditing(true);
    setEditContent(node.attrs.content ?? "");
  }

  function handleSave() {
    updateAttributes({ content: editContent });
    setIsEditing(false);
  }

  function handleCancel() {
    setEditContent(node.attrs.content ?? "");
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
            <Textarea
              aria-label="Mermaid diagram source"
              className="max-h-[50vh] min-h-[200px] p-3 font-mono text-sm leading-relaxed"
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
            {!error && svg && <MermaidViewer onEdit={handleEdit} svg={svg} />}
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

export const MermaidExtension = MermaidNode.extend({
  addNodeView() {
    return ReactNodeViewRenderer(MermaidComponent);
  },
});

function getMermaidConfigKey(
  mode: MermaidThemeMode,
  config: MermaidInitializeConfig
) {
  return JSON.stringify({
    mode,
    securityLevel: config.securityLevel,
    startOnLoad: config.startOnLoad,
    theme: config.theme,
    themeCSS: config.themeCSS,
    themeVariables: config.themeVariables,
  });
}

function normalizeMermaidContent(content: unknown) {
  return typeof content === "string" ? content.trim() : "";
}

function isCurrentRenderRequest(
  requestSeq: number,
  requestState: MermaidRenderState,
  renderSeqRef: RefObject<number>,
  latestRenderStateRef: RefObject<MermaidRenderState>
) {
  const latest = latestRenderStateRef.current;
  return (
    requestSeq === renderSeqRef.current &&
    requestState.content === latest.content &&
    requestState.isEditing === latest.isEditing &&
    requestState.mode === latest.mode
  );
}

type MermaidRenderState = {
  content: string;
  isEditing: boolean;
  mode: MermaidThemeMode;
};
