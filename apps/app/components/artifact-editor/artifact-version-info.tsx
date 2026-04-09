"use client";

import { useState } from "react";
import { CollapsibleSection } from "./collapsible-section";

/**
 * Date formatter for consistent date display across artifact metadata.
 */
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
});

type ArtifactVersionInfoProps = {
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
 * Displays artifact activity metadata with created and updated dates.
 */
export function ArtifactVersionInfo({
  createdAt,
  updatedAt,
}: Readonly<ArtifactVersionInfoProps>) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <CollapsibleSection onOpenChange={setIsOpen} open={isOpen} title="Activity">
      <div className="space-y-1 text-muted-foreground text-sm">
        <p>Created: {dateFormatter.format(new Date(createdAt))}</p>
        <p>Updated: {dateFormatter.format(new Date(updatedAt))}</p>
      </div>
    </CollapsibleSection>
  );
}
