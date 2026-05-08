type SaveIndicatorProps = {
  isSaving: boolean;
};

export function SaveIndicator({ isSaving }: SaveIndicatorProps) {
  return (
    <span className="shrink-0 text-muted-foreground text-sm">
      {isSaving ? "Saving..." : "All changes saved"}
    </span>
  );
}
