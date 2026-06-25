import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { BarChart3Icon } from "lucide-react";

export function EmptyTile({
  message = "No data in range",
}: {
  message?: string;
}) {
  return (
    <EmptyState
      className="h-full min-h-24 rounded-md border border-dashed bg-muted/20"
      description={message}
      icon={BarChart3Icon}
      title="No data"
    />
  );
}
