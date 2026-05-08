"use client";

import { toast } from "@repo/design-system/components/ui/sonner";
import { useEffect, useRef, useState } from "react";

type UseInlineEditOptions = {
  initialValue: string;
  onSave: (trimmedValue: string) => Promise<unknown>;
  onChange?: (newValue: string) => void;
  allowEmpty?: boolean;
  emptyErrorMessage?: string;
};

export function useInlineEdit<
  T extends HTMLInputElement | HTMLTextAreaElement,
>({
  initialValue,
  onSave,
  onChange,
  allowEmpty = false,
  emptyErrorMessage,
}: UseInlineEditOptions) {
  const [value, setValue] = useState(initialValue);
  const [inputValue, setInputValue] = useState(initialValue);
  const [isPending, setIsPending] = useState(false);
  const inputRef = useRef<T>(null);

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

    setIsPending(true);

    onSave(trimmedValue)
      .then(() => {
        setValue(trimmedValue);
        onChange?.(trimmedValue);
      })
      .catch(() => {
        // Global mutation onError handler toasts; nothing else to do here
      })
      .finally(() => {
        setIsPending(false);
      });
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
    isPending,
    handleSave,
    handleCancel,
  };
}
