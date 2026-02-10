"use client";

import { MetadataSection } from "./metadata-panel";

/**
 * Date formatter for consistent date display across artifact metadata.
 */
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
});

type ArtifactVersionInfoProps = {
  /**
   * Artifact version number
   */
  version: number;
  /**
   * Artifact creation date (ISO string or Date)
   */
  createdAt: string | Date;
  /**
   * Artifact last update date (ISO string or Date)
   */
  updatedAt: string | Date;
};

/**
 * Displays artifact version and timestamp metadata.
 * Provides consistent formatting for version, created, and updated dates.
 */
export function ArtifactVersionInfo({
  version,
  createdAt,
  updatedAt,
}: Readonly<ArtifactVersionInfoProps>) {
  return (
    <MetadataSection separator>
      <div className="space-y-1 text-muted-foreground text-sm">
        <p>Version: v{version}</p>
        <p>Created: {dateFormatter.format(new Date(createdAt))}</p>
        <p>Updated: {dateFormatter.format(new Date(updatedAt))}</p>
      </div>
    </MetadataSection>
  );
}
