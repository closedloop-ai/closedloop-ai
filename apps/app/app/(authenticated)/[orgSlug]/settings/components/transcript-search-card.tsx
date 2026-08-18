"use client";

import { OrgPolicyField } from "@repo/app/settings/lib/org-policy-toggle-state";
import { OrgPolicyToggleCard } from "./org-policy-toggle-card";

const TOGGLE_ID = "search-include-transcripts";

const CARD_TITLE = "Search session transcripts";

const CARD_DESCRIPTION =
  "Control whether unified search can look inside AI session transcript content.";

const TOGGLE_LABEL = "Include transcript content in search";

const TOGGLE_HELP_TEXT =
  "When on, full-text search matches the text of session transcripts, not just their titles. Transcript content can contain source code, secrets, and prompts, so this is off by default.";

type TranscriptSearchCardProperties = {
  isAdmin: boolean;
};

/**
 * Admin-only toggle for the transcript-content search privacy gate (FEA-3930).
 * When enabled, unified search indexes the text of AI session transcripts so
 * their content is full-text searchable; when off (the default), only session
 * metadata is searchable. Transcript content can carry source, secrets, and
 * prompts, so the gate is off by default and only an admin can turn it on. The
 * API enforces the same admin check before persisting.
 *
 * The card body (including the unavailable state a previous-generation API
 * produces, ISS-4624) lives in the shared `OrgPolicyToggleCard`.
 */
export function TranscriptSearchCard({
  isAdmin,
}: Readonly<TranscriptSearchCardProperties>) {
  return (
    <OrgPolicyToggleCard
      description={CARD_DESCRIPTION}
      field={OrgPolicyField.SearchIncludeTranscripts}
      isAdmin={isAdmin}
      title={CARD_TITLE}
      toggleHelpText={TOGGLE_HELP_TEXT}
      toggleId={TOGGLE_ID}
      toggleLabel={TOGGLE_LABEL}
    />
  );
}
