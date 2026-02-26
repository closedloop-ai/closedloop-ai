"use client";

import { CheckCircle, XCircle } from "lucide-react";
import { useMemo } from "react";
import { decodeText } from "@/lib/engineer/run-viewer-utils";

type EvalSignal = {
  name?: string;
  value?: number | boolean;
  threshold?: number;
  passed?: boolean;
  [key: string]: unknown;
};

type EvalData = {
  simple_mode?: boolean;
  signals?: EvalSignal[];
  [key: string]: unknown;
};

type EvaluationViewerProps = {
  data: Uint8Array;
};

export function EvaluationViewer({ data }: Readonly<EvaluationViewerProps>) {
  const evalData = useMemo((): EvalData | null => {
    try {
      return JSON.parse(decodeText(data)) as EvalData;
    } catch {
      return null;
    }
  }, [data]);

  if (!evalData) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Invalid plan-evaluation.json
      </div>
    );
  }

  const signals = Array.isArray(evalData.signals) ? evalData.signals : [];
  const extraFields = Object.entries(evalData).filter(
    ([key]) => key !== "simple_mode" && key !== "signals"
  );

  return (
    <div className="h-full space-y-6 overflow-auto p-6">
      <div className="flex items-center gap-3">
        <h2 className="font-semibold text-lg">Plan Evaluation</h2>
        {evalData.simple_mode !== undefined && (
          <span
            className={`rounded-full px-2.5 py-0.5 font-medium text-xs ${
              evalData.simple_mode
                ? "bg-emerald-500/15 text-emerald-500"
                : "bg-amber-500/15 text-amber-500"
            }`}
          >
            {evalData.simple_mode ? "Simple Mode" : "Full Mode"}
          </span>
        )}
      </div>

      {signals.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {signals.map((signal, i) => {
            const passed =
              signal.passed ??
              (typeof signal.value === "number" &&
                typeof signal.threshold === "number" &&
                signal.value >= signal.threshold);
            return (
              <div
                className="space-y-2 rounded-lg border p-4"
                key={signal.name || `signal-${String(i)}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-sm">
                    {signal.name || `Signal ${i + 1}`}
                  </span>
                  {passed ? (
                    <CheckCircle className="size-4 text-emerald-500" />
                  ) : (
                    <XCircle className="size-4 text-red-500" />
                  )}
                </div>
                <div className="flex items-baseline gap-2 text-muted-foreground text-xs">
                  {signal.value !== undefined && (
                    <span>
                      Value:{" "}
                      <span className="font-mono">{String(signal.value)}</span>
                    </span>
                  )}
                  {signal.threshold !== undefined && (
                    <span>
                      Threshold:{" "}
                      <span className="font-mono">{signal.threshold}</span>
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {extraFields.length > 0 && (
        <div className="space-y-2 rounded-lg border p-4">
          <h3 className="mb-2 font-medium text-muted-foreground text-sm">
            Raw Data
          </h3>
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs">
            {JSON.stringify(Object.fromEntries(extraFields), null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
