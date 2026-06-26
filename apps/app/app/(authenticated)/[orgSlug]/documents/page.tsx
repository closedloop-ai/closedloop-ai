"use client";

import { ArtifactFlag } from "@repo/app/shared/lib/feature-flags";
import { FileIcon } from "lucide-react";
import { ComingSoonPage } from "@/components/coming-soon-page";
import { FeatureFlagGate } from "@/components/feature-flag-gate";

export default function DocumentsPage() {
  return (
    <FeatureFlagGate flag={ArtifactFlag.Documents}>
      <ComingSoonPage icon={FileIcon} label="Documents" />
    </FeatureFlagGate>
  );
}
