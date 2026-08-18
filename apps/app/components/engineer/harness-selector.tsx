"use client";

import {
  type ComputeTargetHealthCheckSnapshot,
  deriveAvailableHarnesses,
  HarnessType,
} from "@repo/api/src/types/compute-target";
import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Badge } from "@repo/design-system/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { TriangleAlert } from "lucide-react";

const HARNESS_LABELS: Record<HarnessType, string> = {
  [HarnessType.Claude]: "Claude",
  [HarnessType.Codex]: "Codex",
};

type Props = {
  availableHarnesses: HarnessType[];
  selectedHarness: HarnessType;
  onHarnessChange: (harness: HarnessType) => void;
  disabled?: boolean;
};

export type { Props as HarnessSelectorProps };

export function HarnessSelector({
  availableHarnesses,
  selectedHarness,
  onHarnessChange,
  disabled,
}: Props) {
  if (availableHarnesses.length === 0) {
    return (
      <Alert variant="error">
        <TriangleAlert className="size-4" />
        <AlertDescription>No AI harness available</AlertDescription>
      </Alert>
    );
  }

  if (availableHarnesses.length === 1) {
    const harness = availableHarnesses[0];
    return <Badge variant="outline">{HARNESS_LABELS[harness]}</Badge>;
  }

  return (
    <Select
      disabled={disabled}
      onValueChange={(value) => onHarnessChange(value as HarnessType)}
      value={selectedHarness}
    >
      <SelectTrigger size="sm">
        <SelectValue placeholder="Select AI harness" />
      </SelectTrigger>
      <SelectContent>
        {availableHarnesses.map((harness) => (
          <SelectItem key={harness} value={harness}>
            {HARNESS_LABELS[harness]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Derives which harnesses are available from a health check snapshot result.
 *
 * Returns an empty array only when the snapshot itself is absent. Availability
 * follows `deriveAvailableHarnesses`: the CLI check row decides, and the MCP
 * server is consulted only as a FALLBACK when the snapshot carries no CLI row
 * for that harness at all (ISS-5687 — reading `mcpServers` alone is what
 * produced "No AI harness available" on a machine with two green CLIs; letting
 * it OVERRIDE a failing CLI row would be the same mistake pointed the other
 * way, offering a harness the snapshot already proved cannot launch).
 */
export function deriveAvailableHarnessesFromSnapshot(
  snapshot: ComputeTargetHealthCheckSnapshot | null | undefined
): HarnessType[] {
  if (!snapshot) {
    return [];
  }
  return deriveAvailableHarnesses(snapshot.result);
}

/**
 * Returns the default harness for MVP (`claude`), falling back to the first
 * available harness when `claude` is not in the available set.
 */
export function resolveDefaultHarness(
  availableHarnesses: HarnessType[]
): HarnessType {
  if (availableHarnesses.includes(HarnessType.Claude)) {
    return HarnessType.Claude;
  }
  return availableHarnesses[0] ?? HarnessType.Claude;
}
