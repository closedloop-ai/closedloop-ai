/**
 * @file finding-detail-sheet.tsx
 * @description FEA-3848 (PRD-556 M2) — the finding-detail drawer.
 *
 * Opens from a triage row and shows the full finding: its severity, the cited
 * `path:line`, the complete evidence (the reviewer's `description`, which quotes
 * the offending doc line and the contradicting code and proposes the concrete
 * fix), and the stable dedup signature. Presentational only — the owning view
 * controls open/close and passes the selected finding view.
 */
import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@closedloop-ai/design-system/components/ui/sheet";
import { FingerprintIcon, MapPinIcon } from "lucide-react";
import {
  AUDIT_SEVERITY_LABEL,
  type AuditFindingView,
} from "./audit-finding-model";
import { severityBadgeVariant } from "./severity-badge";

export type FindingDetailSheetProps = {
  /** The finding to show, or null when the drawer is closed. */
  view: AuditFindingView | null;
  onClose: () => void;
};

/** A drawer with the full evidence + proposed fix + signature for one finding. */
export function FindingDetailSheet({ view, onClose }: FindingDetailSheetProps) {
  const open = view !== null;
  return (
    <Sheet
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open={open}
    >
      <SheetContent className="w-full gap-0 sm:max-w-lg" side="right">
        {view ? (
          <>
            <SheetHeader className="gap-2 border-[var(--border)] border-b">
              <div className="flex items-center gap-2">
                <Badge variant={severityBadgeVariant(view.severity)}>
                  {AUDIT_SEVERITY_LABEL[view.severity]}
                </Badge>
                {view.location ? (
                  <span className="flex items-center gap-1 font-mono text-[var(--muted-foreground)] text-xs">
                    <MapPinIcon aria-hidden className="size-3" />
                    {view.location}
                  </span>
                ) : null}
              </div>
              <SheetTitle className="text-base leading-snug">
                {view.displayTitle}
              </SheetTitle>
              <SheetDescription className="sr-only">
                Full evidence and proposed fix for this audit finding.
              </SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-4 overflow-y-auto p-4">
              <section aria-label="Evidence and proposed fix">
                <h3 className="mb-1 font-medium text-[var(--foreground)] text-sm">
                  Evidence &amp; proposed fix
                </h3>
                <p className="whitespace-pre-wrap text-[var(--muted-foreground)] text-sm leading-relaxed">
                  {view.finding.description || "No evidence was provided."}
                </p>
              </section>
              {view.finding.signature ? (
                <section aria-label="Signature">
                  <h3 className="mb-1 flex items-center gap-1 font-medium text-[var(--foreground)] text-sm">
                    <FingerprintIcon aria-hidden className="size-3.5" />
                    Signature
                  </h3>
                  <code className="rounded bg-[var(--muted)] px-1.5 py-0.5 font-mono text-[var(--muted-foreground)] text-xs">
                    {view.finding.signature}
                  </code>
                </section>
              ) : null}
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
