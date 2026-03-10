"use client";

import { RichTextEditor } from "@repo/rich-text";
import { useCallback, useEffect, useRef, useState } from "react";
import { useUpdateIssue } from "@/hooks/queries/use-issues";

type EditableIssueDescriptionProps = {
  issueId: string;
  initialDescription: string;
};

export function EditableIssueDescription({
  issueId,
  initialDescription,
}: Readonly<EditableIssueDescriptionProps>) {
  const updateIssue = useUpdateIssue();

  const [markdown, setMarkdown] = useState(initialDescription);
  const [savedMarkdown, setSavedMarkdown] = useState(initialDescription);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");

  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const initialDescriptionRef = useRef(initialDescription);
  const hasEditedRef = useRef(false);

  // Sync with prop changes (e.g., from server updates)
  // but only if the user has not edited the description
  useEffect(() => {
    if (
      initialDescription === initialDescriptionRef.current ||
      hasEditedRef.current
    ) {
      return;
    }

    initialDescriptionRef.current = initialDescription;
    setSavedMarkdown(initialDescription);
    setMarkdown(initialDescription);
  }, [initialDescription]);

  const handleSave = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (trimmed === savedMarkdown) {
        return;
      }

      setSaveStatus("saving");
      updateIssue
        .mutateAsync({
          id: issueId,
          description: trimmed || undefined,
        })
        .then(() => {
          setSavedMarkdown(trimmed);
          setSaveStatus("saved");
          if (savedTimerRef.current) {
            clearTimeout(savedTimerRef.current);
          }
          savedTimerRef.current = setTimeout(() => {
            setSaveStatus("idle");
          }, SAVED_DISPLAY_MS);
        })
        .catch(() => {
          setSaveStatus("idle");
        });
    },
    [issueId, savedMarkdown, updateIssue]
  );

  const handleChange = useCallback(
    (value: string) => {
      setMarkdown(value);
      hasEditedRef.current = true;

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(() => {
        handleSave(value);
      }, DEBOUNCE_MS);
    },
    [handleSave]
  );

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      if (savedTimerRef.current) {
        clearTimeout(savedTimerRef.current);
      }
    };
  }, []);

  return (
    <div className="relative">
      <RichTextEditor
        className="px-1"
        onChange={handleChange}
        placeholder="Add a description for this feature..."
        scrollMode="outer"
        toolbarMode="focus"
        value={markdown}
      />
      {saveStatus !== "idle" && (
        <p className="mt-2 text-muted-foreground text-xs">
          {saveStatus === "saving" ? "Saving..." : "Saved"}
        </p>
      )}
    </div>
  );
}

type SaveStatus = "idle" | "saving" | "saved";

const DEBOUNCE_MS = 500;
const SAVED_DISPLAY_MS = 2000;
