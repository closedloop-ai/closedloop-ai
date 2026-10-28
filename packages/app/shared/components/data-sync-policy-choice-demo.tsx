"use client";

import type { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { Button } from "@repo/design-system/components/ui/button";
import { Section } from "@repo/design-system/components/ui/layout/section";
import { useState } from "react";
import { offeredDataSyncLevelsWithoutRedaction } from "../lib/data-sync-level-options";
import { DataSyncPolicyChoice } from "./data-sync-policy-choice";

/** Mock persistence only; the prototype renders the production choice surface. */
export function DataSyncPolicyChoiceDemo() {
  const [currentLevel, setCurrentLevel] = useState<DataSyncLevel | null>(null);
  const [selectedLevel, setSelectedLevel] = useState<DataSyncLevel | null>(
    null
  );
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 p-4">
      <div className="flex justify-end">
        <Button
          onClick={() => {
            setCurrentLevel(null);
            setSelectedLevel(null);
          }}
          size="sm"
          variant="ghost"
        >
          Reset
        </Button>
      </div>
      <Section
        description="How much of this machine's data goes to the Closedloop cloud."
        title="This device's sync level"
      >
        <DataSyncPolicyChoice
          currentLevel={currentLevel}
          isWriting={false}
          levels={offeredDataSyncLevelsWithoutRedaction(currentLevel)}
          onSave={setCurrentLevel}
          onSelect={setSelectedLevel}
          selectedLevel={selectedLevel}
        />
      </Section>
    </div>
  );
}
