/**
 * Shared fallback copy container for transient agent telemetry read failures.
 */
export function DegradedState({
  message,
}: Readonly<{
  message: string;
}>) {
  return (
    <div className="rounded-md border border-dashed p-4 text-muted-foreground text-sm">
      {message}
    </div>
  );
}
