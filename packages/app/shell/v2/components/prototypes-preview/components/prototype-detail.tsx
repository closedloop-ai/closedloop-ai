"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { TabsContent } from "@repo/design-system/components/ui/tabs";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { ExternalLinkIcon, EyeIcon, MessageSquareIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  type Annotation,
  type AnnotationEdits,
  type AnnotationTarget,
  initialAnnotations,
  type PrototypeRow,
  type PrototypeVersion,
  PrototypeVersionStatus,
  prototypeVersions,
} from "../mock";
import { toggleResolvedAnnotation } from "../state";
import { PrototypeBrowserFrame as BrowserFrame } from "./prototype-browser-frame";
import { PrototypeCommentsRail as CommentsRail } from "./prototype-comments-rail";
import { PrototypeDetailsPanel as PrototypeDetails } from "./prototype-details-panel";

/**
 * Also hosted by the web-master Prototype artifact page, which renders only the
 * artifact panel (`artifactOnly`) inside its own tab chrome and supplies the
 * comments rail itself (`showCommentsRail={false}`).
 */
export function PrototypeDetail({
  prototype,
  commentsOpen,
  onCommentsOpenChange,
  onPrototypeChange,
  onPreviewRequested,
  artifactOnly = false,
  showCommentsRail = true,
}: {
  prototype: PrototypeRow;
  commentsOpen: boolean;
  onCommentsOpenChange: (open: boolean) => void;
  onPrototypeChange: (prototype: PrototypeRow) => void;
  onPreviewRequested: () => void;
  artifactOnly?: boolean;
  showCommentsRail?: boolean;
}) {
  const [annotating, setAnnotating] = useState(false);
  const [annotations, setAnnotations] =
    useState<Annotation[]>(initialAnnotations);
  const [selectedTarget, setSelectedTarget] = useState<AnnotationTarget | null>(
    null
  );
  const [activeAnnotation, setActiveAnnotation] = useState<number | null>(null);
  const [selectedVersion, setSelectedVersion] = useState(prototype.version);
  const [annotationNavigationRequest, setAnnotationNavigationRequest] =
    useState(0);
  useEffect(() => {
    if (!selectedTarget) {
      return;
    }
    const cancelOutsideComposer = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("[data-annotation-editor]")
      ) {
        return;
      }
      setSelectedTarget(null);
    };
    globalThis.window.addEventListener("pointerdown", cancelOutsideComposer);
    return () =>
      globalThis.window.removeEventListener(
        "pointerdown",
        cancelOutsideComposer
      );
  }, [selectedTarget]);

  const availableVersions: readonly PrototypeVersion[] =
    prototype.id === "branches-v2"
      ? prototypeVersions
      : [
          {
            number: prototype.version,
            label: `v${prototype.version}`,
            createdAt: prototype.updated,
            createdBy: prototype.updatedBy,
            status: PrototypeVersionStatus.Current,
            changeSummary: "Current published prototype.",
          },
        ];
  const visibleAnnotations = useMemo(
    () =>
      annotations.filter(
        (annotation) => annotation.version === selectedVersion
      ),
    [annotations, selectedVersion]
  );

  const activateAnnotation = (id: number) => {
    onPreviewRequested();
    setActiveAnnotation(id);
    setAnnotationNavigationRequest((request) => request + 1);
    setSelectedTarget(null);
    onCommentsOpenChange(true);
  };

  const addAnnotation = (body: string, proposedChanges?: AnnotationEdits) => {
    if (!selectedTarget) {
      return;
    }
    const nextId = Math.max(0, ...annotations.map((item) => item.id)) + 1;
    const nextDisplayNumber =
      Math.max(0, ...visibleAnnotations.map((item) => item.displayNumber)) + 1;
    setAnnotations((current) => [
      ...current,
      {
        id: nextId,
        displayNumber: nextDisplayNumber,
        version: selectedVersion,
        author: prototype.owner,
        body,
        anchorId: selectedTarget.anchorId,
        target: selectedTarget.target,
        selector: selectedTarget.selector,
        route: selectedTarget.route,
        createdAt: "just now",
        proposedChanges,
      },
    ]);
    setActiveAnnotation(null);
    setSelectedTarget(null);
    onCommentsOpenChange(true);
  };
  const resolveAnnotation = (id: number) => {
    setAnnotations((current) => toggleResolvedAnnotation(current, id));
  };
  const editAnnotation = (
    id: number,
    body: string,
    proposedChanges?: AnnotationEdits
  ) => {
    setAnnotations((current) =>
      current.map((annotation) =>
        annotation.id === id
          ? {
              ...annotation,
              body,
              proposedChanges: proposedChanges ?? annotation.proposedChanges,
            }
          : annotation
      )
    );
  };
  const deleteAnnotation = (id: number) => {
    setAnnotations((current) =>
      current.filter((annotation) => annotation.id !== id)
    );
    setActiveAnnotation((current) => (current === id ? null : current));
  };
  const replyToAnnotation = (id: number, body: string) => {
    setAnnotations((current) =>
      current.map((annotation) =>
        annotation.id === id
          ? {
              ...annotation,
              replies: [
                ...(annotation.replies ?? []),
                {
                  id: Date.now(),
                  author: prototype.owner,
                  body,
                  createdAt: "just now",
                },
              ],
            }
          : annotation
      )
    );
  };

  const browserControls = (
    <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
      <Select
        onValueChange={(value) => {
          const nextVersion = Number(value);
          setSelectedVersion(nextVersion);
          setActiveAnnotation(null);
          setSelectedTarget(null);
          setAnnotating(false);
        }}
        value={String(selectedVersion)}
      >
        <SelectTrigger
          aria-label="Prototype version"
          className="w-[9.5rem]"
          size="sm"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {availableVersions.map((item) => (
            <SelectItem key={item.number} value={String(item.number)}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <ToggleGroup
        aria-label="Prototype interaction mode"
        onValueChange={(value) => {
          if (!value) {
            return;
          }
          const nextAnnotating = value === "comment";
          setAnnotating(nextAnnotating);
          if (!nextAnnotating) {
            setSelectedTarget(null);
          }
        }}
        size="sm"
        type="single"
        value={annotating ? "comment" : "preview"}
        variant="outline"
      >
        <ToggleGroupItem value="preview">
          <EyeIcon />
          Preview
        </ToggleGroupItem>
        <ToggleGroupItem value="comment">
          <MessageSquareIcon />
          Comment
        </ToggleGroupItem>
      </ToggleGroup>
      <Button asChild size="icon-sm" variant="ghost">
        <a
          aria-label="Open hosted preview"
          href={prototype.previewUrl}
          rel="noreferrer"
          target="_blank"
        >
          <ExternalLinkIcon />
        </a>
      </Button>
    </div>
  );
  const openVersionPreview = (versionNumber: number) => {
    setSelectedVersion(versionNumber);
    setActiveAnnotation(null);
    setSelectedTarget(null);
    setAnnotating(false);
    onPreviewRequested();
  };

  const artifactPanel = (
    <div className="relative flex size-full min-h-0">
      <section className="relative min-w-0 flex-1">
        <BrowserFrame
          activeAnnotation={activeAnnotation}
          annotating={annotating}
          annotationNavigationRequest={annotationNavigationRequest}
          annotations={visibleAnnotations}
          controls={browserControls}
          onActivate={activateAnnotation}
          onAddAnnotation={addAnnotation}
          onCloseActiveAnnotation={() => setActiveAnnotation(null)}
          onEditAnnotation={editAnnotation}
          onSelectTarget={setSelectedTarget}
          prototype={prototype}
          selectedTarget={selectedTarget}
          version={selectedVersion}
        />
      </section>
      {showCommentsRail ? (
        <CommentsRail
          activeAnnotation={activeAnnotation}
          annotations={visibleAnnotations}
          onActivate={activateAnnotation}
          onDelete={deleteAnnotation}
          onEdit={editAnnotation}
          onReply={replyToAnnotation}
          onResolve={resolveAnnotation}
          open={commentsOpen}
          prototype={prototype}
          version={selectedVersion}
        />
      ) : null}
    </div>
  );

  if (artifactOnly) {
    return artifactPanel;
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <TabsContent
        className="relative min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
        forceMount
        value="preview"
      >
        {artifactPanel}
      </TabsContent>

      <TabsContent
        className="min-h-0 flex-1 overflow-auto data-[state=inactive]:hidden"
        forceMount
        value="details"
      >
        <PrototypeDetails
          annotations={annotations}
          onOpenVersion={openVersionPreview}
          onPrototypeChange={onPrototypeChange}
          prototype={prototype}
          versions={availableVersions}
        />
      </TabsContent>
    </div>
  );
}
