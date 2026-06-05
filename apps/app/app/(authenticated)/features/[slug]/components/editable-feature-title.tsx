"use client";

import { Input } from "@repo/design-system/components/ui/input";
import { useUpdateFeature } from "@/hooks/queries/use-features";
import { useInlineEdit } from "@/hooks/use-inline-edit";

type EditableFeatureTitleProps = {
  featureId: string;
  initialTitle: string;
  onTitleChange?: (newTitle: string) => void;
};

export function EditableFeatureTitle({
  featureId,
  initialTitle,
  onTitleChange,
}: EditableFeatureTitleProps) {
  const updateFeature = useUpdateFeature();

  const {
    inputValue,
    setInputValue,
    inputRef,
    isPending,
    handleSave,
    handleCancel,
  } = useInlineEdit<HTMLInputElement>({
    initialValue: initialTitle,
    onSave: (title) => updateFeature.mutateAsync({ id: featureId, title }),
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
