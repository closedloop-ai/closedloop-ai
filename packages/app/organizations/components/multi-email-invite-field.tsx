"use client";

import { FOCUS_WITHIN_RING_CLASS } from "@repo/app/shared/lib/focus-within-ring";
import { Button } from "@repo/design-system/components/ui/button";
import { Chip } from "@repo/design-system/components/ui/chip";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { XIcon } from "lucide-react";
import {
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  useId,
  useState,
} from "react";
import { collectEmails } from "../lib/email";

/**
 * Reusable multi-email invite composer (ISS-8348). Owned by the organizations
 * slice, with no onboarding dependency, so Settings can consume it without
 * importing the onboarding modal.
 *
 * `pending` and `submissionError` are optional: a host that does not report the
 * send's progress gets exactly the previous rendering.
 */
export function MultiEmailInviteField({
  onSubmit,
  pending = false,
  submissionError,
}: {
  onSubmit: (emails: readonly string[]) => void;
  /** A submit is in flight. Blocks re-submission of the same batch. */
  pending?: boolean;
  /**
   * Why the last submit failed. Rendered in its OWN live region: a send that
   * the server rejected is not an input-validation error, so it must not mark
   * valid addresses invalid or speak through the parser's message.
   */
  submissionError?: string;
}) {
  // Ids must be per-instance. They were module-global constants, so two
  // composers on one page (an onboarding modal over a Settings panel, or two
  // Settings sections) produced duplicate ids and pointed both labels at
  // whichever input mounted first.
  const fieldId = useId();
  const helpId = `${fieldId}-help`;
  const errorId = `${fieldId}-error`;
  const submissionErrorId = `${fieldId}-submission-error`;
  const [emails, setEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [showDraftErrors, setShowDraftErrors] = useState(false);
  const invalidEmails = showDraftErrors
    ? collectEmails(draft.split(EMAIL_SEPARATOR)).invalid
    : [];

  const addCandidates = (candidates: string[]) => {
    const { invalid, valid } = collectEmails(candidates);
    setEmails((current) => [...new Set([...current, ...valid])]);
    return { invalid, valid };
  };

  const commitDraft = (value = draft) => {
    const result = addCandidates(value.split(EMAIL_SEPARATOR));
    if (result.invalid.length > 0) {
      setDraft(result.invalid.join(", "));
      setShowDraftErrors(true);
    } else if (result.valid.length > 0) {
      setDraft("");
      setShowDraftErrors(false);
    } else {
      setShowDraftErrors(false);
    }
    return result;
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    setShowDraftErrors(false);
    if (!EMAIL_SEPARATOR_PRESENT.test(next)) {
      setDraft(next);
      return;
    }

    const pieces = next.split(EMAIL_SEPARATOR);
    const trailingDraft = EMAIL_SEPARATOR_TRAILING.test(next)
      ? ""
      : (pieces.pop() ?? "");
    const { invalid } = addCandidates(pieces);
    setDraft([...invalid, trailingDraft].filter(Boolean).join(", "));
    setShowDraftErrors(invalid.length > 0);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === "," || event.key === ";") {
      event.preventDefault();
      commitDraft();
      return;
    }

    if (event.key === "Backspace" && draft.length === 0) {
      setEmails((current) => current.slice(0, -1));
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData("text");
    if (!EMAIL_SEPARATOR_PRESENT.test(pasted)) {
      return;
    }

    event.preventDefault();
    const { invalid } = addCandidates(
      `${draft} ${pasted}`.split(EMAIL_SEPARATOR)
    );
    setDraft(invalid.join(", "));
    setShowDraftErrors(invalid.length > 0);
  };

  const handleSubmit = () => {
    if (pending) {
      return;
    }
    const { invalid, valid } = commitDraft();
    if (
      invalidEmails.length === 0 &&
      invalid.length === 0 &&
      (emails.length > 0 || valid.length > 0)
    ) {
      onSubmit([...new Set([...emails, ...valid])]);
    }
  };

  const recipientCount = emails.length;
  const hasRecipient = recipientCount > 0 || draft.trim().length > 0;

  return (
    <div className="space-y-3">
      <Label htmlFor={fieldId}>Work emails</Label>
      <div
        className={`flex max-h-44 min-h-32 flex-wrap content-start gap-1.5 overflow-y-auto rounded-lg border border-input-border bg-input p-4 shadow-xs transition-[color,box-shadow] ${FOCUS_WITHIN_RING_CLASS}`}
      >
        {emails.map((email) => (
          <Chip className="max-w-full gap-1 pr-1 pl-2.5" key={email}>
            <span className="truncate">{email}</span>
            <button
              aria-label={`Remove ${email}`}
              className="rounded-full p-0.5 text-muted-foreground outline-none hover:bg-background/80 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              disabled={pending}
              onClick={() =>
                setEmails((current) =>
                  current.filter((candidate) => candidate !== email)
                )
              }
              type="button"
            >
              <XIcon className="size-3" />
            </button>
          </Chip>
        ))}
        <Input
          aria-describedby={`${helpId} ${errorId} ${submissionErrorId}`}
          aria-invalid={invalidEmails.length > 0}
          autoComplete="email"
          className="h-8 min-w-0 flex-1 border-0 bg-transparent px-1 py-0 shadow-none focus-visible:border-0 focus-visible:ring-0 sm:min-w-80 dark:bg-transparent"
          disabled={pending}
          id={fieldId}
          inputMode="email"
          onBlur={(event) => commitDraft(event.currentTarget.value)}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={
            emails.length === 0
              ? "Paste a list of emails, separated by commas or new lines"
              : "Add another"
          }
          type="text"
          value={draft}
        />
      </div>
      <p className="sr-only" id={helpId}>
        Paste a list of emails separated by commas, spaces, or new lines.
      </p>
      <p
        aria-live="polite"
        className="min-h-4 text-destructive text-xs"
        id={errorId}
      >
        {invalidEmails.length > 0 ? `Check ${invalidEmails.join(", ")}` : null}
      </p>
      <p
        aria-live="polite"
        className="text-destructive text-xs empty:hidden"
        id={submissionErrorId}
      >
        {submissionError ?? null}
      </p>
      <Button
        className="w-full"
        disabled={pending || !hasRecipient || invalidEmails.length > 0}
        onClick={handleSubmit}
        size="lg"
        type="button"
      >
        {getSubmitLabel(recipientCount, pending)}
      </Button>
    </div>
  );
}

function getSubmitLabel(recipientCount: number, pending: boolean): string {
  if (pending) {
    return "Sending…";
  }
  return recipientCount > 1 ? `Send ${recipientCount} invites` : "Send invite";
}

const EMAIL_SEPARATOR = /[\s,;]+/;
const EMAIL_SEPARATOR_PRESENT = /[\s,;]/;
const EMAIL_SEPARATOR_TRAILING = /[\s,;]$/;
