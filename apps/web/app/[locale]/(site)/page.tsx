import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import {
  createPageMetadata,
  localize,
  marketingHighlights,
  siteDescription,
} from "@/lib/site";

type HomePageProps = {
  params: Promise<{
    locale: string;
  }>;
};

export const generateMetadata = async () =>
  createPageMetadata("Docs-First Marketing Site", siteDescription);

const HomePage = async ({ params }: HomePageProps) => {
  const { locale } = await params;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-16 px-6 py-12 md:px-10">
      <section className="grid gap-10 lg:grid-cols-[1.4fr_0.9fr] lg:items-end">
        <div className="space-y-6">
          <p className="font-medium text-muted-foreground text-sm uppercase tracking-[0.2em]">
            ClosedLoop.ai knowledge system
          </p>
          <div className="space-y-4">
            <h1 className="max-w-4xl font-semibold text-5xl tracking-tight md:text-6xl">
              Software development is multiplayer. AI productivity should be
              too.
            </h1>
            <p className="max-w-2xl text-lg text-muted-foreground">
              We&apos;re building the infrastructure layer that makes AI work{" "}
              <em>collective</em> intelligence &mdash; not just for the
              individual.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link href={localize(locale, "/docs")}>
                Take a Peek
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </div>
        </div>
        <Card className="border-border/60 bg-card/60 backdrop-blur">
          <CardHeader>
            <CardTitle>Phase 1 shipping scope</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-muted-foreground text-sm">
            {[
              "Docs root plus onboarding refresh",
              "Glossary and mechanism pages",
              "Workflow pages for PRD → plan → execution → PR",
              "Blog, resources, community, and pricing entry points",
            ].map((item) => (
              <div className="flex items-start gap-2" key={item}>
                <CheckCircle2 className="mt-0.5 size-4 text-primary" />
                <span>{item}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-5 md:grid-cols-2">
        {marketingHighlights.map(({ description, icon: Icon, title }) => (
          <Card key={title}>
            <CardHeader className="space-y-3">
              <div className="flex size-11 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Icon className="size-5" />
              </div>
              <CardTitle>{title}</CardTitle>
            </CardHeader>
            <CardContent className="text-muted-foreground text-sm">
              {description}
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="grid gap-4 rounded-3xl border border-border/60 bg-muted/30 p-8 md:grid-cols-3">
        {[
          {
            href: localize(locale, "/docs/workflows/prd-to-plan-to-execution"),
            title: "Workflow pages",
            description:
              "Map inputs, steps, outputs, and artifacts for the key delivery paths.",
          },
          {
            href: localize(
              locale,
              "/docs/resources/closedloop-vs-chat-based-workflows"
            ),
            title: "Comparison pages",
            description:
              "Explain where the control plane matters and when point tools fall short.",
          },
          {
            href: localize(locale, "/blog"),
            title: "Anchor essays",
            description:
              "Support category definition with narrative content and distribution hooks.",
          },
        ].map((item) => (
          <Link
            className="rounded-2xl border border-border/60 bg-background p-5 transition-colors hover:border-primary/50"
            href={item.href}
            key={item.title}
          >
            <p className="font-medium">{item.title}</p>
            <p className="mt-2 text-muted-foreground text-sm">
              {item.description}
            </p>
          </Link>
        ))}
      </section>
    </div>
  );
};

export default HomePage;
