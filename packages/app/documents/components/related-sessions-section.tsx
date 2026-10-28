"use client";

import { PROVENANCE_RELATIONSHIP_KIND_LABELS } from "@repo/api/src/types/provenance-relationship";
import type { RelatedSessionSummary } from "@repo/api/src/types/related-session";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { formatDateTime } from "@repo/app/shared/lib/date-utils";
import { RELATED_SESSIONS_FIELD_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { getUserDisplayName } from "@repo/app/shared/lib/user-utils";
import { UNTITLED_SESSION_LABEL } from "@repo/collaboration/shared/notification-labels";
import { CollapsibleSection } from "@repo/design-system/components/ui/collapsible-section";
import { useState } from "react";
import { useRelatedSessions } from "../hooks/use-related-sessions";
import {
  RELATED_SESSIONS_EMPTY_MESSAGE,
  RELATED_SESSIONS_ERROR_MESSAGE,
  RELATED_SESSIONS_LOADING_MESSAGE,
  RELATED_SESSIONS_SECTION_TITLE,
} from "../lib/related-sessions-labels";
import {
  RelatedSessionsCell,
  type RelatedSessionsCellItem,
} from "./related-sessions-cell";

/**
 * ISS-7235 — the read-only Related Sessions field, inherited by every
 * non-Session artifact type.
 *
 * Mounted in `DocumentEditorDetails`, immediately above Comments, so PRD / Plan
 * / Feature-Issue / Doc all inherit it without a per-type edit; Branch detail
 * gets it from the WEB ROUTE, which injects it as `relatedSessionsSlot` rather
 * than letting the cross-surface `BranchDetailPage` mount this web-only key
 * itself. Closed by default behind
 * {@link RELATED_SESSIONS_FIELD_FEATURE_FLAG_KEY}; when the gate is off the
 * section renders nothing AND issues no request.
 *
 * The section owns the mapping from the wire row to the cell's structural
 * contract — the relationship label comes from the canonical
 * `PROVENANCE_RELATIONSHIP_KIND_LABELS`, never restated in the render.
 */
export function RelatedSessionsSection({
  artifactId,
  now,
}: Readonly<{ artifactId: string; now?: Date | number }>) {
  const enabled = useFeatureFlagEnabledOptional(
    RELATED_SESSIONS_FIELD_FEATURE_FLAG_KEY
  );
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError } = useRelatedSessions(
    artifactId,
    enabled && open
  );

  if (!enabled) {
    return null;
  }

  return (
    <CollapsibleSection
      onOpenChange={setOpen}
      open={open}
      title={RELATED_SESSIONS_SECTION_TITLE}
    >
      <RelatedSessionsBody
        isError={isError}
        isLoading={isLoading}
        items={data?.items}
        now={now}
        total={data?.total}
      />
    </CollapsibleSection>
  );
}

/**
 * Loading, failed, and genuinely-empty are three different facts and each gets
 * its own sentence. Rendering the cell's "No related sessions" while the read
 * is still in flight, or after it failed, would state a provenance claim the
 * app has not established.
 */
function RelatedSessionsBody({
  isError,
  isLoading,
  items,
  now,
  total,
}: Readonly<{
  isError: boolean;
  isLoading: boolean;
  items?: readonly RelatedSessionSummary[];
  now?: Date | number;
  total?: number;
}>) {
  if (isError) {
    return (
      <p className="text-destructive text-sm" role="alert">
        {RELATED_SESSIONS_ERROR_MESSAGE}
      </p>
    );
  }
  if (isLoading || items === undefined) {
    return (
      <p aria-live="polite" className="text-muted-foreground text-sm">
        {RELATED_SESSIONS_LOADING_MESSAGE}
      </p>
    );
  }
  if (items.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {RELATED_SESSIONS_EMPTY_MESSAGE}
      </p>
    );
  }
  return (
    <RelatedSessionsCell
      items={items.map(toRelatedSessionsCellItem)}
      now={now}
      total={total}
    />
  );
}

/**
 * A session with neither a name nor a slug is still a real contribution, so it
 * gets an honest placeholder rather than being dropped from the field.
 */
export function toRelatedSessionsCellItem(
  session: RelatedSessionSummary
): RelatedSessionsCellItem {
  return {
    id: session.sessionArtifactId,
    label: session.name ?? session.slug ?? UNTITLED_SESSION_LABEL,
    ownerName: session.owner ? getUserDisplayName(session.owner) : null,
    ownerAvatarUrl: session.owner?.avatarUrl ?? null,
    status: session.status,
    occurredAt: session.contributedAt,
    relationshipLabel: PROVENANCE_RELATIONSHIP_KIND_LABELS[session.kind],
    occurredAtLabel: formatDateTime(session.contributedAt),
  };
}
