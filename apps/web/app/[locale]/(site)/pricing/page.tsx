import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { createPageMetadata } from "@/lib/site";

export const generateMetadata = async () =>
  createPageMetadata(
    "Pricing",
    "Simple pricing that explains the open source surface and hosted control plane."
  );

const PricingPage = () => (
  <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-12 md:px-10">
    <div className="space-y-3">
      <p className="font-medium text-muted-foreground text-sm uppercase tracking-[0.2em]">
        Pricing
      </p>
      <h1 className="font-semibold text-4xl tracking-tight">
        Open source for builders, hosted control plane for teams.
      </h1>
      <p className="max-w-2xl text-muted-foreground">
        Phase 1 keeps pricing intentionally simple so the site can focus on
        clarity and category definition.
      </p>
    </div>

    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Open source</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-muted-foreground text-sm">
          <p className="font-semibold text-2xl text-foreground">Free</p>
          <p>
            Use the open source components, docs, and templates to evaluate the
            stack.
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Hosted</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-muted-foreground text-sm">
          <p className="font-semibold text-2xl text-foreground">
            $20 / user / month
          </p>
          <p>
            Pay for the control plane, runtime, governance, and coordinated
            delivery flow.
          </p>
        </CardContent>
      </Card>
    </div>
  </div>
);

export default PricingPage;
