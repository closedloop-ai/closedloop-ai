"use client";
import { Chip } from "@repo/design-system/components/ui/chip";
import { CommentComposer } from "@repo/design-system/components/ui/comment-composer";
import { cn } from "@repo/design-system/lib/utils";
import { MessageSquareIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Annotation, AnnotationEdits, PrototypeRow } from "../mock";
import { getOpenCommentCount } from "../state";
import { PrototypeCommentThread } from "./prototype-comment-thread";
import { AvatarLabel } from "./prototype-people";

export function PrototypeCommentsRail({
  activeAnnotation,
  annotations,
  prototype,
  version,
  open,
  onActivate,
  onDelete,
  onEdit,
  onReply,
  onResolve,
}: {
  activeAnnotation: number | null;
  annotations: Annotation[];
  prototype: PrototypeRow;
  version: number;
  open: boolean;
  onActivate: (id: number) => void;
  onDelete: (id: number) => void;
  onEdit: (id: number, body: string, proposedChanges?: AnnotationEdits) => void;
  onReply: (id: number, body: string) => void;
  onResolve: (id: number) => void;
}) {
  const [generalComments, setGeneralComments] = useState<
    Array<{ id: number; body: string; version: number }>
  >([]);
  const railContentRef = useRef<HTMLDivElement>(null);
  const visibleGeneralComments = generalComments.filter(
    (comment) => comment.version === version
  );
  const openCount =
    getOpenCommentCount(annotations) + visibleGeneralComments.length;
  const totalCount = annotations.length + visibleGeneralComments.length;

  useEffect(() => {
    if (activeAnnotation === null) {
      return;
    }
    railContentRef.current
      ?.querySelector(`[data-comment-id="${activeAnnotation}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeAnnotation]);

  return (
    <aside
      className={cn(
        "absolute inset-y-0 right-0 z-40 flex w-[20rem] shrink-0 flex-col border-l bg-background shadow-lg xl:static xl:z-auto xl:w-[22rem] xl:shadow-none",
        !open && "hidden"
      )}
      id="prototype-comments-rail"
    >
      <div className="flex h-12 items-center gap-2 border-b px-4">
        <MessageSquareIcon className="size-4 text-muted-foreground" />
        <h2 className="font-medium text-sm">Prototype comments</h2>
        <Chip className="ml-1" variant="muted">
          {openCount}/{totalCount}
        </Chip>
      </div>
      <div
        className="min-h-0 flex-1 space-y-3 overflow-auto p-3"
        ref={railContentRef}
      >
        {annotations.map((annotation) => (
          <PrototypeCommentThread
            annotation={annotation}
            key={annotation.id}
            onActivate={() => onActivate(annotation.id)}
            onDelete={() => onDelete(annotation.id)}
            onEdit={(body) => onEdit(annotation.id, body)}
            onReply={(body) => onReply(annotation.id, body)}
            onResolve={() => onResolve(annotation.id)}
            selected={activeAnnotation === annotation.id}
          />
        ))}
        {visibleGeneralComments.map((comment) => (
          <div className="rounded-lg border p-3" key={comment.id}>
            <div className="flex items-center gap-2">
              <AvatarLabel person={prototype.owner} />
              <span className="font-medium text-sm">
                {prototype.owner.name}
              </span>
              <span className="ml-auto text-muted-foreground text-xs">
                just now
              </span>
            </div>
            <p className="mt-2 text-sm">{comment.body}</p>
            <p className="mt-2 text-muted-foreground text-xs">
              General comment on v{version}
            </p>
          </div>
        ))}
      </div>
      <div className="border-t p-3">
        <CommentComposer
          key={`general-comment-v${version}`}
          minHeightClassName="min-h-16"
          onSubmit={(body) =>
            setGeneralComments((current) => [
              ...current,
              { id: current.length + 1, body, version },
            ])
          }
          placeholder="Add a comment and @mention someone…"
        />
      </div>
    </aside>
  );
}
