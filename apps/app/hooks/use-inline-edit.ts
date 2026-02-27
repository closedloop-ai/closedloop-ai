"use client";

import { toast } from "@repo/design-system/components/ui/sonner";
import { useEffect, useRef, useState } from "react";
import { useUpdateProject } from "@/hooks/queries/use-projects";

type UseInlineEditOptions = {
  projectId: string;
  initialValue: string;
  buildPayload: (trimmedValue: string) => Record<string, unknown>;
  onChange?: (newValue: string) => void;
  allowEmpty?: boolean;
  emptyErrorMessage?: string;
  saveErrorMessage: string;
};

export function useInlineEdit<
  T extends HTMLInputElement | HTMLTextAreaElement,
>({
  projectId,
  initialValue,
  buildPayload,
  onChange,
  allowEmpty = false,
  emptyErrorMessage,
  saveErrorMessage,
}: UseInlineEditOptions) {
  const [value, setValue] = useState(initialValue);
  const [inputValue, setInputValue] = useState(initialValue);
  const inputRef = useRef<T>(null);
  const updateProject = useUpdateProject();

  // Sync with prop changes (e.g., from server updates)
  useEffect(() => {
    setValue(initialValue);
    setInputValue(initialValue);
  }, [initialValue]);

  const handleSave = () => {
    const trimmedValue = inputValue.trim();

    // Validation: prevent empty values when not allowed
    if (!(trimmedValue || allowEmpty)) {
      if (emptyErrorMessage) {
        toast.error(emptyErrorMessage);
      }
      setInputValue(value); // Reset to last valid value
      return;
    }

    // No change, just blur
    if (trimmedValue === value) {
      return;
    }

    // Capture original value BEFORE optimistic update
    const previousValue = value;

    // Optimistic update
    setValue(trimmedValue);

    // Call mutation
    updateProject.mutate(
      {
        id: projectId,
        ...buildPayload(trimmedValue),
      },
      {
        onSuccess: () => {
          onChange?.(trimmedValue);
        },
        onError: () => {
          // Revert on error using captured previous value
          setValue(previousValue);
          setInputValue(previousValue);
          toast.error(saveErrorMessage);
        },
      }
    );
  };

  const handleCancel = () => {
    setInputValue(value);
    inputRef.current?.blur();
  };

  return {
    value,
    inputValue,
    setInputValue,
    inputRef,
    isPending: updateProject.isPending,
    handleSave,
    handleCancel,
  };
}
