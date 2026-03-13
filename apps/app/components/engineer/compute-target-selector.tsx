"use client";

import { useIsMounted } from "@/hooks/use-is-mounted";
import { useElectronDetection } from "@/lib/engineer/electron-detection";

function TargetStatusDot() {
  return (
    <span
      aria-hidden
      className="mr-2 inline-block size-2 rounded-full bg-emerald-500"
    />
  );
}

export function ComputeTargetSelector() {
  const mounted = useIsMounted();
  const detection = useElectronDetection();

  if (!(mounted && detection.detected)) {
    return null;
  }

  return (
    <span className="flex items-center text-sm">
      <TargetStatusDot />
      {detection.machineName ?? "Local"}
    </span>
  );
}
