"use client";

import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";

export type HiddenFileInputHandle = {
  open: () => void;
  reset: () => void;
};

type HiddenFileInputProps = {
  accept: string;
  onFileRead: (content: string) => void;
  onError?: (message: string) => void;
  "aria-label"?: string;
};

export const HiddenFileInput = forwardRef<
  HiddenFileInputHandle,
  HiddenFileInputProps
>(function HiddenFileInput({ accept, onFileRead, onError, ...props }, ref) {
  const inputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    open: () => inputRef.current?.click(),
    reset: () => {
      if (inputRef.current) {
        inputRef.current.value = "";
      }
    },
  }));

  const handleChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }

      try {
        const content = await file.text();
        onFileRead(content);
      } catch {
        onError?.("Failed to read file. Please try again.");
      } finally {
        if (inputRef.current) {
          inputRef.current.value = "";
        }
      }
    },
    [onFileRead, onError]
  );

  return (
    <input
      accept={accept}
      aria-label={props["aria-label"]}
      className="hidden"
      onChange={handleChange}
      ref={inputRef}
      type="file"
    />
  );
});
