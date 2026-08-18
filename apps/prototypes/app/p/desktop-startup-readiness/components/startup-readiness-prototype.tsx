"use client";

import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { useState } from "react";
import { type StartupFixture, StartupStage, startupFixtures } from "../mock";
import { StartupAppShell } from "./app-shell";
import { SessionsWorkspace } from "./sessions-workspace";

export function StartupReadinessPrototype() {
  const [stage, setStage] = useState<StartupStage>(
    StartupStage.ProcessingHistory
  );
  const fixture = fixtureForStage(stage);

  return (
    <main>
      <StartupAppShell
        actions={
          <ToggleGroup
            aria-label="Preview startup state"
            onValueChange={(value) => {
              if (value) {
                setStage(value as StartupStage);
              }
            }}
            size="sm"
            type="single"
            value={stage}
            variant="outline"
          >
            {startupFixtures.map((item) => (
              <ToggleGroupItem key={item.stage} value={item.stage}>
                {item.switcherLabel}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        }
        fixture={fixture}
      >
        <SessionsWorkspace fixture={fixture} />
      </StartupAppShell>
    </main>
  );
}

function fixtureForStage(stage: StartupStage): StartupFixture {
  return (
    startupFixtures.find((fixture) => fixture.stage === stage) ??
    startupFixtures[0]
  );
}
