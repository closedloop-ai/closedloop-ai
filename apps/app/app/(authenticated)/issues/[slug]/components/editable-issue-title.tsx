"use client";

import { Input } from "@repo/design-system/components/ui/input";
import { useUpdateIssue } from "@/hooks/queries/use-issues";
import { useInlineEdit } from "@/hooks/use-inline-edit";

type EditableIssueTitleProps = {
  issueId: string;
  initialTitle: string;
  onTitleChange?: (newTitle: string) => void;
};

export function EditableIssueTitle({
  issueId,
  initialTitle,
  onTitleChange,
}: EditableIssueTitleProps) {
  const updateIssue = useUpdateIssue();

  const {
    inputValue,
    setInputValue,
    inputRef,
    isPending,
    handleSave,
    handleCancel,
  } = useInlineEdit<HTMLInputElement>({
    initialValue: initialTitle,
    onSave: (title) => updateIssue.mutateAsync({ id: issueId, title }),
    onChange: onTitleChange,
    emptyErrorMessage: "Feature title cannot be empty",
  });

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancel();
    }
  };

  return (
    <Input
      className="h-auto rounded-none border-none bg-transparent px-0 py-0 font-semibold text-2xl tracking-[-0.6px] shadow-none focus-visible:ring-0 md:text-2xl dark:bg-transparent"
      disabled={isPending}
      onBlur={handleSave}
      onChange={(e) => setInputValue(e.target.value)}
      onKeyDown={handleKeyDown}
      placeholder="Untitled feature"
      ref={inputRef}
      value={inputValue}
    />
  );
}
