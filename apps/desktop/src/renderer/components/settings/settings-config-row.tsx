/**
 * The read-only label/value row shared by the Settings cards (Relay / Gateway,
 * Security).
 *
 * Extracted from `SettingsPanel.tsx` (ISS-5309) when the Labs tab moved to its
 * own module. ISS-5310 then moved the Gateway Health rollup out of Labs into
 * Relay / Gateway → Connection Status, so the Labs tab no longer uses this row —
 * it stays extracted because the file it came from is grandfathered shrink-only.
 */
export function ConfigRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="w-24 shrink-0 text-[var(--muted-foreground)]">
        {label}
      </span>
      <span className={`truncate ${mono ? "font-mono" : ""}`}>
        {value || "—"}
      </span>
    </div>
  );
}
