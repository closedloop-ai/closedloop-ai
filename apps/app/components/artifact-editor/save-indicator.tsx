import { formatRelativeTime } from "@/lib/date-utils";

type SaveIndicatorProps = {
  isSaving: boolean;
  lastSaved: Date;
};

export function SaveIndicator({ isSaving, lastSaved }: SaveIndicatorProps) {
  return (
    <span className="shrink-0 text-muted-foreground text-sm">
      {isSaving ? "Saving..." : `Last saved: ${formatRelativeTime(lastSaved)}`}
    </span>
  );
}
