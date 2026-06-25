"use client";

import { ArtifactFlag } from "@repo/app/shared/lib/feature-flags";
import { SquareCheckIcon } from "lucide-react";
import { ComingSoonPage } from "@/components/coming-soon-page";
import { FeatureFlagGate } from "@/components/feature-flag-gate";

export default function IssuesPage() {
  return (
    <FeatureFlagGate flag={ArtifactFlag.Issues}>
      <ComingSoonPage icon={SquareCheckIcon} label="Issues" />
    </FeatureFlagGate>
  );
}
