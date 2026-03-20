"use client";

import type { Artifact } from "@repo/api/src/types/artifact";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import type { Workstream } from "@repo/api/src/types/workstream";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { ArrowLeftIcon, FileTextIcon } from "lucide-react";
import Link from "next/link";
import { CustomFieldsSection } from "@/components/custom-fields/custom-fields-section";
import {
  WorkstreamStateBadge,
  WorkstreamTypeBadge,
} from "@/components/status-badge";
import { formatRelativeTime } from "@/lib/date-utils";
import { ARTIFACT_TYPE_LABELS } from "@/lib/project-constants";

type WorkstreamDetailProps = {
  workstream: Workstream;
  artifacts: Artifact[];
};

export function WorkstreamDetail({
  workstream,
  artifacts,
}: WorkstreamDetailProps) {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-4">
            <Link href="/workstreams">
              <Button size="sm" variant="ghost">
                <ArrowLeftIcon className="h-4 w-4" />
                Back
              </Button>
            </Link>
            <h1 className="font-bold text-2xl">{workstream.title}</h1>
          </div>
          <div className="flex items-center gap-2">
            <WorkstreamTypeBadge type={workstream.type} />
            <WorkstreamStateBadge state={workstream.state} />
            <span className="text-muted-foreground text-sm">
              Updated {formatRelativeTime(new Date(workstream.updatedAt))}
            </span>
          </div>
        </div>
      </div>

      {/* Description */}
      {workstream.description ? (
        <Card>
          <CardHeader>
            <CardTitle>Description</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">{workstream.description}</p>
          </CardContent>
        </Card>
      ) : null}

      {/* Custom Fields */}
      <Card>
        <CardContent className="pt-6">
          <CustomFieldsSection
            entityId={workstream.id}
            entityType={CustomFieldEntityType.Workstream}
          />
        </CardContent>
      </Card>

      {/* Artifacts */}
      <Card>
        <CardHeader>
          <CardTitle>Artifacts</CardTitle>
          <CardDescription>
            Documents and reports for this workstream
          </CardDescription>
        </CardHeader>
        <CardContent>
          {artifacts.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground">
              No artifacts yet
            </p>
          ) : (
            <div className="space-y-2">
              {artifacts.map((artifact) => (
                <div
                  className="flex items-center justify-between rounded-md border p-3"
                  key={artifact.id}
                >
                  <div className="flex items-center gap-3">
                    <FileTextIcon className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="font-medium">{artifact.title}</p>
                      <p className="text-muted-foreground text-sm">
                        {ARTIFACT_TYPE_LABELS[artifact.type] ?? artifact.type} ·
                        v{artifact.latestVersion}
                      </p>
                    </div>
                  </div>
                  <span className="text-muted-foreground text-sm">
                    {formatRelativeTime(new Date(artifact.updatedAt))}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
