import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { createPageMetadata, localize } from "@/lib/site";

type ResourcesPageProps = {
  params: Promise<{
    locale: string;
  }>;
};

export const generateMetadata = async () =>
  createPageMetadata(
    "Resources",
    "Comparison pages, templates, and workflow references for high-intent readers."
  );

const ResourcesPage = async ({ params }: ResourcesPageProps) => {
  const { locale } = await params;

  const items = [
    {
      href: localize(
        locale,
        "/docs/resources/closedloop-vs-chat-based-workflows"
      ),
      title: "ClosedLoop.ai vs chat-based workflows",
      description:
        "Explain why artifact-bound execution changes how teams ship.",
    },
    {
      href: localize(locale, "/docs/resources/prd-template"),
      title: "PRD template",
      description:
        "A lightweight template to move from idea to implementation plan faster.",
    },
    {
      href: localize(locale, "/docs/resources/implementation-plan-template"),
      title: "Implementation plan template",
      description:
        "Define scope, checkpoints, risks, and outputs before loops begin.",
    },
  ];

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-12 md:px-10">
      <div className="space-y-3">
        <p className="font-medium text-muted-foreground text-sm uppercase tracking-[0.2em]">
          Resources
        </p>
        <h1 className="font-semibold text-4xl tracking-tight">
          High-intent pages for evaluation and adoption.
        </h1>
        <p className="max-w-2xl text-muted-foreground">
          Resources are wired back into the docs graph so comparisons and
          templates stay versioned and easy to expand.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {items.map((item) => (
          <a href={item.href} key={item.title}>
            <Card className="h-full transition-colors hover:border-primary/50">
              <CardHeader>
                <CardTitle className="text-lg">{item.title}</CardTitle>
              </CardHeader>
              <CardContent className="text-muted-foreground text-sm">
                {item.description}
              </CardContent>
            </Card>
          </a>
        ))}
      </div>
    </div>
  );
};

export default ResourcesPage;
