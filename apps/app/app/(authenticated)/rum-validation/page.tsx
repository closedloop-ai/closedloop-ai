import { notFound } from "next/navigation";
import { env } from "@/env";
import { RumValidationTrigger } from "./rum-validation-trigger";

export default function RumValidationPage() {
  if (env.RUM_VALIDATION_ROUTE_ENABLED !== "true") {
    notFound();
  }

  return (
    <main className="flex h-full flex-col items-center justify-center gap-4 p-6">
      <h1 className="font-semibold text-lg">RUM validation</h1>
      <p data-testid="rum-validation-route-template">/rum-validation</p>
      <label htmlFor="rum-validation-sensitive-input">Validation input</label>
      <input
        className="border px-2 py-1"
        defaultValue="user-entered-sensitive-text"
        id="rum-validation-sensitive-input"
        name="sensitive-user-input"
      />
      <RumValidationTrigger />
    </main>
  );
}
