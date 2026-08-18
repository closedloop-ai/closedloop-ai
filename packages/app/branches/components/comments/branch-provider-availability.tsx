import { BranchCommentsState } from "@repo/api/src/types/branch";
import type { BranchProviderCommentsAvailability } from "./branch-comments-model";

/** Renders every applicable bounded-availability fact without precedence loss. */
export function BranchProviderAvailability({
  availability,
}: Readonly<{ availability: BranchProviderCommentsAvailability }>) {
  const messages = providerAvailabilityMessages(availability);
  if (messages.length === 0) {
    return null;
  }
  return (
    <ul
      className="list-disc space-y-1 border-b bg-muted/30 py-2 pr-4 pl-8 text-muted-foreground text-xs"
      role="status"
    >
      {messages.map((message) => (
        <li key={message}>{message}</li>
      ))}
    </ul>
  );
}

/** Converts independent provider-coverage facts into truthful disclosure copy. */
export function providerAvailabilityMessages(
  availability: BranchProviderCommentsAvailability
): string[] {
  const messages: string[] = [];
  if (
    availability.state === BranchCommentsState.StaleMixed ||
    availability.stale
  ) {
    messages.push("GitHub comments may be stale.");
  }
  if (availability.mixedProjection) {
    messages.push(
      "GitHub comments combine evidence collected at different times."
    );
  }
  if (availability.providerTruncated) {
    messages.push("GitHub capped the available provider result.");
  }
  if (availability.responseTruncated) {
    messages.push("ClosedLoop capped the displayed provider response.");
  }
  if (
    availability.state === BranchCommentsState.OverLimitTruncated &&
    !(availability.providerTruncated || availability.responseTruncated)
  ) {
    messages.push("Provider comment coverage is truncated.");
  }
  if (availability.omittedComments > 0) {
    messages.push(
      `${availability.omittedComments} GitHub ${pluralize(availability.omittedComments, "comment is", "comments are")} omitted from this bounded result.`
    );
  }
  if (availability.bodyTruncatedCount > 0) {
    messages.push(
      `${availability.bodyTruncatedCount} GitHub comment ${pluralize(availability.bodyTruncatedCount, "body is", "bodies are")} shortened.`
    );
  }
  return messages;
}

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}
