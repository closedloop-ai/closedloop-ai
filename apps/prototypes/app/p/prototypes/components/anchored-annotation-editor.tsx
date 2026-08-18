"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { cn } from "@repo/design-system/lib/utils";
import {
  CheckIcon,
  GripVerticalIcon,
  MicIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import {
  type ChangeEvent,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { AnnotationEdits, AnnotationTarget } from "../mock";

export function AnchoredAnnotationEditor({
  target,
  initialBody = "",
  onCancel,
  onSubmit,
}: {
  target: AnnotationTarget;
  initialBody?: string;
  onCancel: () => void;
  onSubmit: (body: string, proposedChanges?: AnnotationEdits) => void;
}) {
  const [body, setBody] = useState(initialBody);
  const [showEdits, setShowEdits] = useState(false);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const baseline = useRef<AnnotationEdits>(seedEdits(target));
  const [edits, setEdits] = useState<AnnotationEdits>(baseline.current);
  const updateEdit = (key: keyof AnnotationEdits, value: string) => {
    setEdits((current) => ({ ...current, [key]: value }));
  };
  const updateBody = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setBody(event.target.value);
    resizeComment(event.target);
  };
  const submit = () => {
    onSubmit(body.trim(), diffEdits(baseline.current, edits));
  };

  useLayoutEffect(() => {
    if (commentRef.current) {
      resizeComment(commentRef.current);
    }
  }, []);

  return (
    <>
      <div
        className={cn(
          "grid grid-cols-[2rem_minmax(0,1fr)_2rem] items-end gap-2 px-3 py-2",
          showEdits && "border-b"
        )}
      >
        <Button
          aria-expanded={showEdits}
          aria-label={showEdits ? "Hide HTML editing" : "Show HTML editing"}
          className="self-start"
          onClick={() => setShowEdits((current) => !current)}
          size="icon-sm"
          variant="ghost"
        >
          <SlidersHorizontalIcon />
        </Button>
        <Textarea
          aria-label="Annotation comment"
          className="max-h-36 min-h-8 resize-none overflow-y-hidden border-0 px-0 py-1.5 leading-6 shadow-none focus-visible:ring-0"
          onChange={updateBody}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && body.trim()) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="Add a comment…"
          ref={commentRef}
          rows={1}
          value={body}
        />
        <Button
          aria-label={
            body.trim() ? "Create anchored comment" : "Add voice comment"
          }
          disabled={!body.trim()}
          onClick={submit}
          size="icon-sm"
          variant={body.trim() ? "default" : "ghost"}
        >
          {body.trim() ? <CheckIcon /> : <MicIcon />}
        </Button>
      </div>
      {showEdits ? (
        <>
          <div className="flex h-9 items-center justify-between bg-muted px-3">
            <span className="font-medium text-sm">
              {target.tagName ?? target.selector.split("[")[0]}
            </span>
            <GripVerticalIcon className="size-4 text-muted-foreground" />
          </div>
          <div className="space-y-2.5 px-3 py-3">
            <AnnotationEditRow label="Text">
              <Input
                aria-label="Proposed text"
                className="h-8"
                onChange={(event) => updateEdit("text", event.target.value)}
                value={edits.text}
              />
            </AnnotationEditRow>
            <AnnotationEditRow label="Text color">
              <StyleValueInput
                label="Proposed text color"
                onChange={(value) => updateEdit("textColor", value)}
                value={edits.textColor ?? ""}
              />
            </AnnotationEditRow>
            <AnnotationEditRow label="Background">
              <StyleValueInput
                label="Proposed background"
                onChange={(value) => updateEdit("background", value)}
                value={edits.background ?? ""}
              />
            </AnnotationEditRow>
            <AnnotationEditRow label="Opacity">
              <Input
                aria-label="Proposed opacity"
                className="h-8 text-right"
                onChange={(event) => updateEdit("opacity", event.target.value)}
                value={edits.opacity}
              />
            </AnnotationEditRow>
            <AnnotationEditRow label="Font">
              <Input
                aria-label="Proposed font"
                className="h-8"
                onChange={(event) => updateEdit("font", event.target.value)}
                value={edits.font}
              />
            </AnnotationEditRow>
            <div className="space-y-1">
              <label
                className="font-medium text-muted-foreground text-xs"
                htmlFor="annotation-html"
              >
                HTML
              </label>
              <Textarea
                className="max-h-24 min-h-16 resize-none font-mono text-xs"
                id="annotation-html"
                onChange={(event) => updateEdit("html", event.target.value)}
                value={edits.html}
              />
            </div>
          </div>
          <div className="flex items-center justify-between border-t px-3 py-2">
            <Button onClick={onCancel} size="sm" variant="outline">
              Cancel
            </Button>
            <Button
              aria-label="Create anchored comment with HTML changes"
              disabled={!body.trim()}
              onClick={submit}
              size="icon-sm"
            >
              <CheckIcon />
            </Button>
          </div>
        </>
      ) : null}
    </>
  );
}

function resizeComment(element: HTMLTextAreaElement) {
  element.style.height = "2rem";
  element.style.height = `${Math.min(element.scrollHeight, 144)}px`;
  element.style.overflowY = element.scrollHeight > 144 ? "auto" : "hidden";
}

function seedEdits(target: AnnotationTarget): AnnotationEdits {
  return {
    text: target.text ?? "",
    textColor: target.textColor ?? "",
    background: target.background ?? "",
    opacity: target.opacity ?? "1",
    font: target.font ?? "",
    html: target.html ?? "",
  };
}

const EDIT_KEYS: readonly (keyof AnnotationEdits)[] = [
  "text",
  "textColor",
  "background",
  "opacity",
  "font",
  "html",
];

function diffEdits(
  baseline: AnnotationEdits,
  next: AnnotationEdits
): AnnotationEdits | undefined {
  const changed: AnnotationEdits = {};
  for (const key of EDIT_KEYS) {
    if ((next[key] ?? "") !== (baseline[key] ?? "")) {
      changed[key] = next[key];
    }
  }
  return Object.keys(changed).length > 0 ? changed : undefined;
}

function AnnotationEditRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[6rem_1fr] items-center gap-2">
      <span className="text-muted-foreground text-sm">{label}</span>
      {children}
    </div>
  );
}

function StyleValueInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative">
      <span
        aria-hidden="true"
        className="absolute top-1/2 left-2 size-4 -translate-y-1/2 rounded border"
        style={{ background: value }}
      />
      <Input
        aria-label={label}
        className="h-8 pl-8"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      />
    </div>
  );
}
