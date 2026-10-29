import type { InlineEditErrorKind } from "@repo/app/shared/hooks/use-inline-edit";
import { InlineEditFeedback } from "@repo/design-system/components/ui/inline-edit-feedback";

/** Adjacent feedback for an inline editor's validation or persistence refusal. */
export function InlineEditErrorMessage({
  className,
  error,
  id,
}: Readonly<{
  className?: string;
  error: { kind: InlineEditErrorKind; message: string } | null;
  id: string;
}>) {
  if (!error) {
    return null;
  }
  return (
    <InlineEditFeedback className={className} id={id} message={error.message} />
  );
}
