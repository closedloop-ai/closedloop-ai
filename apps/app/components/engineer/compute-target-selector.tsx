"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { useIsMounted } from "@/hooks/use-is-mounted";
import { useElectronDetection } from "@/lib/engineer/electron-detection";

export function ComputeTargetSelector() {
  const mounted = useIsMounted();
  const detection = useElectronDetection();

  if (!(mounted && detection.detected)) {
    return null;
  }

  return (
    <Badge variant="outline">
      <span
        aria-hidden
        className="inline-block size-2 rounded-full bg-emerald-500"
      />
      {detection.machineName ?? "Local"}
    </Badge>
  );
}
