import {
  Card,
  CardContent,
  CardHeader,
} from "@repo/design-system/components/ui/card";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";

/**
 * Shared loading placeholder for compact agent telemetry metric cards.
 */
export function MetricSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-4 w-20" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-8 w-24" />
      </CardContent>
    </Card>
  );
}
