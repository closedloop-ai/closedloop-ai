"use client";

import { type ComponentProps, useState } from "react";
import type {
  CommentsPaneComposerRenderProps,
  CommentsPaneRenderComposer,
} from "../../shared/components/comments/comments-pane-composer";
import { MentionComposer } from "../../shared/components/mention-composer";
import { useOrganizationUsers } from "../hooks/use-users";

type OrgMentionComposerProps = Omit<
  ComponentProps<typeof MentionComposer>,
  "members"
>;

/**
 * `MentionComposer` whose @-picker offers the organization's members. The
 * members query lives here, in the users slice, so the shared composer stays
 * free of feature-slice imports.
 */
export function OrgMentionComposer(props: OrgMentionComposerProps) {
  const { data: members } = useOrganizationUsers();
  return <MentionComposer {...props} members={members} />;
}

/**
 * The comments pane's composer slot with today's organization @-picker
 * (PLN-2162 decision 4). The pane owns the draft, so the composer is
 * controlled; the mentions it starts with (a kept draft's picks, or an edit's
 * existing mentions) arrive as ids and are resolved against the members read.
 */
export const renderOrgMentionPaneComposer: CommentsPaneRenderComposer = (
  props
) => <OrgMentionPaneComposer {...props} />;

function OrgMentionPaneComposer({
  ariaLabel,
  disabled,
  helperText,
  initialMentions,
  isPending,
  leadingActions,
  minHeightClassName,
  onCancel,
  onSubmit,
  onValueChange,
  placeholder,
  submitLabel,
  value,
}: CommentsPaneComposerRenderProps) {
  const { data: members } = useOrganizationUsers();
  // The picks a kept draft reports as they are made come back here too; only
  // the ones the composer mounted with seed it.
  const [seed] = useState(initialMentions);
  const mentioned = members?.filter((member) => seed?.includes(member.id));
  return (
    <MentionComposer
      ariaLabel={ariaLabel}
      disabled={disabled}
      helperText={helperText}
      initialMentions={mentioned}
      isPending={isPending}
      // The picked set is seeded once, so a composer with mentions to seed that
      // opened before the members read landed re-seeds when it does. A composer
      // with none to seed keeps its field, and the focus in it.
      key={seed?.length && members ? "members" : "pending"}
      leadingActions={leadingActions}
      members={members}
      minHeightClassName={minHeightClassName}
      onCancel={onCancel}
      onSubmit={onSubmit}
      onValueChange={onValueChange}
      placeholder={placeholder}
      submitLabel={submitLabel}
      value={value}
    />
  );
}
