"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { useState } from "react";
import type { ContactFormSubmission } from "../lib/contact-form-schema";
import { ContactForm, type ContactFormCopy } from "./contact-form";

/**
 * The mock host for {@link ContactForm}, owned here rather than in the sandbox
 * route because `scripts/lint/production-bound-prototype-route.ts` requires a
 * production-bound route to render nothing but its `main` landmark and an
 * allowlisted portable surface. Every word it renders — the switcher legend and
 * each scenario's label — is a required prop, so this module originates no
 * user-visible string any more than `ContactForm` does (root `AGENTS.md` →
 * Human Provenance for Product Behavior).
 */
export type ContactFormScenario = {
  readonly id: string;
  readonly label: string;
  readonly send: (submission: ContactFormSubmission) => Promise<void> | void;
};

export type ContactFormDemoProps = {
  readonly copy: ContactFormCopy;
  readonly scenarioLegend: string;
  readonly scenarios: readonly ContactFormScenario[];
};

export const ContactFormDemo = ({
  copy,
  scenarioLegend,
  scenarios,
}: ContactFormDemoProps) => {
  const [activeId, setActiveId] = useState(scenarios[0]?.id ?? "");
  const active = scenarios.find((scenario) => scenario.id === activeId);

  return (
    <div className="mx-auto flex w-full max-w-[1300px] flex-col gap-8 px-6 py-16 md:px-10">
      <fieldset className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/30 p-3">
        <legend className="sr-only">{scenarioLegend}</legend>
        {scenarios.map((scenario) => (
          <Button
            aria-pressed={scenario.id === activeId}
            key={scenario.id}
            onClick={() => setActiveId(scenario.id)}
            size="sm"
            type="button"
            variant={scenario.id === activeId ? "default" : "outline"}
          >
            {scenario.label}
          </Button>
        ))}
      </fieldset>
      <div className="max-w-2xl">
        {/* Remounted per scenario so a run that already reached its terminal
            panel does not hide the other outcome behind a stale state. */}
        {active === undefined ? null : (
          <ContactForm copy={copy} key={active.id} onSubmit={active.send} />
        )}
      </div>
    </div>
  );
};
