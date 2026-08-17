"use client";

import { OrgInviteRole } from "@repo/api/src/types/onboarding";
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
import { toast } from "@repo/design-system/components/ui/sonner";
import { Loader2, Plus, Trash2, UserPlus } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { useInviteMembers } from "../hooks/use-organizations";
import { collectEmails } from "../lib/email";

type EmailRow = {
  id: string;
  email: string;
};

type InviteTeamDialogProps = {
  /**
   * The clickable affordance that opens the dialog. Rendered inside a
   * `DialogTrigger asChild`, so it must be a single focusable element (e.g. a
   * button or sidebar menu button). Surfaces supply their own so the trigger
   * matches its host chrome (web onboarding vs. desktop sidebar).
   *
   * Optional, because a fully controlled host opens the dialog from an
   * affordance that is not the dialog's own. Both spotlights need that, for
   * different reasons: ISS-5490's web one opens from a button that unmounts
   * with the spotlight in the same interaction, so the dialog has to outlive
   * its opener rather than contain it; ISS-5489's desktop one pops from the
   * topbar or the sidebar depending on breakpoint, where a second, hidden
   * trigger just to satisfy this prop would put a stray focusable element in
   * the shell.
   */
  readonly trigger?: ReactNode;
  /**
   * Optional controlled open state. Omitted, the dialog owns its own — which is
   * what the web onboarding step and the plain desktop sidebar item both want.
   * ISS-5112 supplies it so a guest who signs up FROM the invite item gets the
   * dialog they were reaching for, rather than having to find it again.
   */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
};

/**
 * Shared "Invite your team" affordance (PRD-532 §5.4 / M9). Collects emails and
 * mints real Clerk org invitations through the BFF route
 * `POST /organizations/invitations` via {@link useInviteMembers}. On accept,
 * Clerk's `organizationMembership.created` webhook syncs a durable MEMBER into
 * the caller's existing org. Consumed by both the web onboarding step and the
 * desktop sidebar.
 */
export function InviteTeamDialog({
  trigger,
  open: controlledOpen,
  onOpenChange,
}: InviteTeamDialogProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      // Both, always: the internal state keeps the uncontrolled callers working
      // untouched, and the callback lets a controlled host stay in step with a
      // close the dialog decided on itself (Escape, overlay, a sent invite).
      setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange]
  );
  const [rows, setRows] = useState<EmailRow[]>([
    { id: createRowId(), email: "" },
  ]);
  const inviteMembers = useInviteMembers();

  const addRow = useCallback(() => {
    setRows((prev) => [...prev, { id: createRowId(), email: "" }]);
  }, []);

  const updateRow = useCallback((id: string, email: string) => {
    setRows((prev) =>
      prev.map((row) => (row.id === id ? { ...row, email } : row))
    );
  }, []);

  const removeRow = useCallback((id: string) => {
    setRows((prev) => {
      if (prev.length <= 1) {
        return [{ id: createRowId(), email: "" }];
      }
      return prev.filter((row) => row.id !== id);
    });
  }, []);

  const { valid: validEmails, invalid: invalidEmails } = useMemo(
    () => collectEmails(rows.map((row) => row.email)),
    [rows]
  );

  const resetRows = useCallback(() => {
    setRows([{ id: createRowId(), email: "" }]);
  }, []);

  const handleSend = useCallback(async () => {
    if (invalidEmails.length > 0) {
      toast.error(
        `Invalid email${invalidEmails.length === 1 ? "" : "s"}: ${invalidEmails.join(", ")}`
      );
      return;
    }
    if (validEmails.length === 0) {
      toast.error("Add at least one email to send invitations");
      return;
    }

    try {
      const result = await inviteMembers.mutateAsync({
        emailAddresses: validEmails,
        role: OrgInviteRole.Member,
      });

      // The route returns 200 even when Clerk rejects individual emails
      // (per-email `status: "failed"`). Inspect the batch outcome rather than
      // assuming success: only reset + close when every invite landed.
      const failedEmails = result.results
        .filter((r) => r.status === "failed")
        .map((r) => r.email);

      if (failedEmails.length > 0 || result.invited === 0) {
        toast.error(
          failedEmails.length > 0
            ? `Failed to invite: ${failedEmails.join(", ")}`
            : "No invitations were sent"
        );
        return;
      }

      toast.success(
        `Sent ${result.invited} invitation${result.invited === 1 ? "" : "s"}`
      );
      resetRows();
      setOpen(false);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to send invitations";
      toast.error(message);
    }
    // `setOpen` is now a callback rather than a raw setState, so it is a real
    // dependency: a host that swaps its `onOpenChange` must not leave this
    // closure calling the previous one.
  }, [inviteMembers, invalidEmails, validEmails, resetRows, setOpen]);

  const isSending = inviteMembers.isPending;

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite your team</DialogTitle>
          <DialogDescription>
            Invite teammates by email. They&apos;ll join your organization when
            they accept.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {rows.map((row) => (
            <div className="flex items-center gap-2" key={row.id}>
              <Input
                aria-label="Email address"
                className="flex-1"
                disabled={isSending}
                onChange={(e) => updateRow(row.id, e.target.value)}
                placeholder="teammate@company.com"
                type="email"
                value={row.email}
              />
              {rows.length > 1 && (
                <Button
                  aria-label="Remove email row"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  disabled={isSending}
                  onClick={() => removeRow(row.id)}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}
          <Button
            className="text-muted-foreground"
            disabled={isSending}
            onClick={addRow}
            size="sm"
            type="button"
            variant="ghost"
          >
            <Plus className="h-4 w-4" />
            Add another
          </Button>
        </div>

        <DialogFooter>
          <Button
            disabled={isSending || validEmails.length === 0}
            onClick={handleSend}
            type="button"
          >
            {isSending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <UserPlus className="h-4 w-4" />
            )}
            {validEmails.length > 0
              ? `Send ${validEmails.length} invitation${validEmails.length === 1 ? "" : "s"}`
              : "Send invitations"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function createRowId(): string {
  return `invite-row-${Math.random().toString(36).slice(2, 10)}`;
}
