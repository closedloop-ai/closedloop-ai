"use client";

import { GridInteractionArtifactListSurface } from "@repo/app/shared/components/generic-artifact-surface/preview/components/grid-interaction-artifact-list-surface";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  pointerHoverContractArtifactHref,
  pointerHoverContractSurfaceFixture,
} from "./mock";

export default function PointerHoverContractPrototypePage() {
  const router = useRouter();
  const [addIssueOpen, setAddIssueOpen] = useState(false);

  return (
    <main>
      <GridInteractionArtifactListSurface
        {...pointerHoverContractSurfaceFixture}
        addArtifactOpen={addIssueOpen}
        onAddArtifactOpenChange={setAddIssueOpen}
        onOpenArtifact={(artifact) =>
          router.push(pointerHoverContractArtifactHref(artifact))
        }
      />
    </main>
  );
}
