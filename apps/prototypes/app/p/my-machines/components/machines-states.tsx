"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
} from "@repo/design-system/components/ui/card";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { AlertCircleIcon, MonitorIcon } from "lucide-react";

// The non-happy states, kept together so loading / error / empty stay consistent
// in density and copy. Each is a first-class screen, not a happy-path afterthought.

// Loading: skeleton machine cards that echo the real card shape (name + status,
// platform, a summary bar) so the layout doesn't jump when data lands.
const LOADING_CARD_KEYS = ["m1", "m2"] as const;

export const MachinesLoading = () => (
  <div
    aria-busy="true"
    aria-label="Loading your machines"
    className="space-y-4"
    role="status"
  >
    {LOADING_CARD_KEYS.map((key) => (
      <Card key={key}>
        <CardHeader className="gap-1">
          <div className="flex items-center justify-between gap-3">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-16" />
          </div>
          <Skeleton className="h-4 w-32" />
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-2 w-full" />
          <Skeleton className="h-4 w-56" />
        </CardContent>
      </Card>
    ))}
  </div>
);

export const MachinesError = ({ onRetry }: { onRetry: () => void }) => (
  <Alert variant="destructive">
    <AlertCircleIcon />
    <AlertTitle>Couldn't read your machines</AlertTitle>
    <AlertDescription>
      The gateway didn't respond while reading install state from your machines.
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

// No CTA button: registering a machine happens in the desktop app, which isn't
// part of this presentational sandbox, so a "Register a machine" button here
// would go nowhere. The description names where the flow lives instead of faking
// an action.
export const MachinesEmpty = () => (
  <EmptyState
    description="Register a machine from the desktop app to install this pack onto it. Machines you've registered show up here."
    icon={MonitorIcon}
    title="No machines registered"
  />
);
