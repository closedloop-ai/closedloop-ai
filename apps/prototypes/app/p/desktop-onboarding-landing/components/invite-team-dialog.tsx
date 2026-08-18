"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { Input } from "@repo/design-system/components/ui/input";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useRef, useState } from "react";

type EmailRow = { id: number; value: string };

/**
 * Presentational stand-in for the production InviteTeamDialog
 * (packages/app/organizations/components/invite-team-dialog.tsx): same copy
 * and shape, but no invitations are actually sent.
 */
export const InviteTeamDialog = ({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) => {
  const nextId = useRef(1);
  const [rows, setRows] = useState<EmailRow[]>([{ id: 0, value: "" }]);

  const setRowValue = (id: number, value: string) =>
    setRows((prev) =>
      prev.map((row) => (row.id === id ? { ...row, value } : row))
    );
  const addRow = () => {
    setRows((prev) => [...prev, { id: nextId.current, value: "" }]);
    nextId.current += 1;
  };
  const removeRow = (id: number) =>
    setRows((prev) => prev.filter((row) => row.id !== id));
  const close = () => {
    setRows([{ id: 0, value: "" }]);
    onClose();
  };

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          close();
        }
      }}
      open={open}
    >
      <DialogContent className="max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Invite your team</DialogTitle>
          <DialogDescription>
            Invite teammates by email. They'll join your organization when they
            accept.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <div className="flex items-center gap-2" key={row.id}>
              <Input
                aria-label="Teammate email"
                onChange={(event) => setRowValue(row.id, event.target.value)}
                placeholder="teammate@company.com"
                type="email"
                value={row.value}
              />
              {rows.length > 1 ? (
                <Button
                  aria-label="Remove email row"
                  onClick={() => removeRow(row.id)}
                  size="icon-sm"
                  variant="ghost"
                >
                  <Trash2Icon />
                </Button>
              ) : null}
            </div>
          ))}
          <Button className="self-start" onClick={addRow} variant="ghost">
            <PlusIcon />
            Add another
          </Button>
        </div>
        <Button onClick={close}>Send invitations</Button>
      </DialogContent>
    </Dialog>
  );
};
