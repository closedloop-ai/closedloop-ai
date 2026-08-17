"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@repo/design-system/components/ui/dialog";
import { Input } from "@repo/design-system/components/ui/input";
import { CheckIcon, PlusIcon, Trash2Icon, UserPlusIcon } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

type EmailRow = {
  id: string;
  email: string;
};

type InviteTeamDialogProps = {
  /**
   * The clickable affordance that opens the dialog, rendered inside a
   * DialogTrigger asChild (uncontrolled use, e.g. the sidebar). Omit it and pass
   * `open`/`onOpenChange` to drive the dialog from a parent (the spotlight).
   */
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  // Fired once when a batch of invitations is sent, so the caller can tick the
  // "Invite team members" setup step off.
  onInvited?: () => void;
};

// Presentational replica of the shared @repo/app InviteTeamDialog — the same
// "Invite your team" affordance surfaced on desktop. Production mints real Clerk
// org invitations via the BFF; here sending is simulated and shows a success
// state.
export const InviteTeamDialog = ({
  trigger,
  open,
  onOpenChange,
  onInvited,
}: InviteTeamDialogProps) => {
  // Monotonic row ids so removing a middle row can never collide with a later
  // "Add another" (a length-based id would reissue an existing id).
  const rowCounter = useRef(0);
  const makeRow = (): EmailRow => {
    const id = `row-${rowCounter.current}`;
    rowCounter.current += 1;
    return { id, email: "" };
  };

  const [internalOpen, setInternalOpen] = useState(false);
  const [rows, setRows] = useState<EmailRow[]>(() => [makeRow()]);
  const [sentCount, setSentCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const isControlled = open !== undefined;
  const actualOpen = isControlled ? open : internalOpen;

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setRows([makeRow()]);
      setSentCount(0);
      setError(null);
    }
    if (!isControlled) {
      setInternalOpen(next);
    }
    onOpenChange?.(next);
  };

  const addRow = () => setRows((prev) => [...prev, makeRow()]);

  const updateRow = (id: string, email: string) => {
    setError(null);
    setRows((prev) =>
      prev.map((row) => (row.id === id ? { ...row, email } : row))
    );
  };

  const removeRow = (id: string) => {
    setError(null);
    setRows((prev) =>
      prev.length <= 1 ? prev : prev.filter((row) => row.id !== id)
    );
  };

  const filledEmails = rows
    .map((row) => row.email.trim())
    .filter((email) => email.length > 0);
  const invalidEmails = filledEmails.filter(
    (email) => !EMAIL_PATTERN.test(email)
  );
  const validEmails = filledEmails.filter((email) => EMAIL_PATTERN.test(email));

  const handleSend = () => {
    // Block the whole batch on any invalid address — never send the good ones
    // and silently drop the typo'd row.
    if (invalidEmails.length > 0) {
      setError(
        `Check ${invalidEmails.length === 1 ? "this address" : "these addresses"}: ${invalidEmails.join(", ")}`
      );
      return;
    }
    if (validEmails.length === 0) {
      return;
    }
    setSentCount(validEmails.length);
    onInvited?.();
  };

  return (
    <Dialog onOpenChange={handleOpenChange} open={actualOpen}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite your team</DialogTitle>
          <DialogDescription>
            {sentCount > 0
              ? "Invites sent to teammates."
              : "Invite teammates by email. They'll join your organization when they accept."}
          </DialogDescription>
        </DialogHeader>

        {sentCount > 0 ? (
          <p className="flex items-center gap-2 text-sm">
            <CheckIcon className="size-4 text-success" />
            Sent {sentCount} invitation{sentCount === 1 ? "" : "s"}.
          </p>
        ) : (
          <div className="space-y-2">
            {rows.map((row) => (
              <div className="flex items-center gap-2" key={row.id}>
                <Input
                  aria-label="Email address"
                  className="flex-1"
                  onChange={(event) => updateRow(row.id, event.target.value)}
                  placeholder="teammate@company.com"
                  type="email"
                  value={row.email}
                />
                {rows.length > 1 && (
                  <Button
                    aria-label="Remove email row"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => removeRow(row.id)}
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                )}
              </div>
            ))}
            <Button
              className="text-muted-foreground"
              onClick={addRow}
              size="sm"
              type="button"
              variant="ghost"
            >
              <PlusIcon className="size-4" />
              Add another
            </Button>
            {error ? (
              <p className="text-destructive text-sm" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        )}

        {sentCount === 0 && (
          <DialogFooter>
            <Button
              disabled={filledEmails.length === 0}
              onClick={handleSend}
              type="button"
            >
              <UserPlusIcon className="size-4" />
              {validEmails.length > 0 && invalidEmails.length === 0
                ? `Send ${validEmails.length} invitation${validEmails.length === 1 ? "" : "s"}`
                : "Send invitations"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
