import { AlertCircle, AlertTriangle, CheckCircle2, Info } from "lucide-react";
import type { ReviewFinding } from "@/lib/engineer/codex-review-parser";

export function SeverityIcon({
  severity,
}: Readonly<{ severity: ReviewFinding["severity"] }>) {
  switch (severity) {
    case "critical":
      return <AlertCircle className="size-4 text-red-500" />;
    case "warning":
      return <AlertTriangle className="size-4 text-amber-500" />;
    case "info":
      return <Info className="size-4 text-blue-500" />;
    case "success":
      return <CheckCircle2 className="size-4 text-emerald-500" />;
    default:
      return <Info className="size-4 text-blue-500" />;
  }
}
