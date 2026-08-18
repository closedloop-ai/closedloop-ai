"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { AlertCircleIcon, MonitorIcon } from "lucide-react";

// The non-happy states of the matrix, kept together so the density and copy of
// loading / error / empty stay consistent. Real production data is bigger and
// messier than the mock, so each of these is a first-class screen, not a
// happy-path afterthought.

// Loading: skeleton rows that echo the real matrix shape (lead target column +
// three harness columns) rather than a lone spinner, so the layout doesn't jump
// when data lands.
const LOADING_ROW_KEYS = ["r1", "r2", "r3", "r4"] as const;
const LOADING_CELL_KEYS = ["lead", "c1", "c2", "c3"] as const;

export const MatrixLoading = () => (
  <div
    aria-busy="true"
    aria-label="Loading install matrix"
    className="border-t"
    role="status"
  >
    {LOADING_ROW_KEYS.map((rowKey) => (
      <div
        className="grid h-11 items-center border-b px-4"
        key={rowKey}
        style={{
          gridTemplateColumns:
            "minmax(220px,1.2fr) repeat(3, minmax(200px,1fr))",
        }}
      >
        {LOADING_CELL_KEYS.map((cellKey) => (
          <div className="pr-3" key={cellKey}>
            <Skeleton
              className={cellKey === "lead" ? "h-4 w-40" : "h-4 w-24"}
            />
          </div>
        ))}
      </div>
    ))}
  </div>
);

export const MatrixError = ({ onRetry }: { onRetry: () => void }) => (
  <Alert variant="destructive">
    <AlertCircleIcon />
    <AlertTitle>Couldn't load install state</AlertTitle>
    <AlertDescription>
      The gateway didn't respond while reading install state from your targets.
      <Button
        className="mt-2 w-fit"
        onClick={onRetry}
        size="sm"
        variant="outline"
      >
        Retry
      </Button>
    </AlertDescription>
  </Alert>
);

export const MatrixEmpty = () => (
  <EmptyState
    description="Register a machine or node to install this component onto it. Registered targets show up here as rows."
    icon={MonitorIcon}
    size="compact"
    title="No registered targets"
  />
);
