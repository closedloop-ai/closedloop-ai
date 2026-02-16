import { Button } from "@repo/design-system/components/ui/button";
import type { Dictionary } from "@repo/internationalization";
import { Download, Github } from "lucide-react";

type HeroProps = {
  dictionary: Dictionary;
};

export const Hero = ({ dictionary }: HeroProps) => {
  const d = dictionary.web.developers.hero;

  return (
    <div className="relative w-full overflow-hidden">
      <div className="pointer-events-none absolute top-[-200px] left-1/2 h-[600px] w-[800px] -translate-x-1/2 rounded-full bg-indigo-500/10 blur-3xl" />
      <div className="container mx-auto">
        <div className="flex flex-col items-center justify-center gap-8 py-20 text-center lg:py-40">
          <div className="inline-flex items-center gap-2 rounded-full border border-indigo-500/20 bg-indigo-500/10 px-4 py-1.5">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />
            <span className="font-medium text-indigo-300 text-sm">
              {d.badge}
            </span>
          </div>
          <div className="flex flex-col gap-4">
            <h1 className="max-w-3xl font-bold text-5xl tracking-tighter md:text-7xl">
              {d.title}
              <br />
              <span className="bg-gradient-to-r from-indigo-500 to-violet-500 bg-clip-text text-transparent">
                {d.titleHighlight}
              </span>
            </h1>
            <p className="mx-auto max-w-2xl text-lg text-muted-foreground leading-relaxed">
              {d.description}
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button asChild className="gap-2" size="lg">
              <a href="#installation">
                <Download className="h-4 w-4" />
                {d.installButton}
              </a>
            </Button>
            <Button asChild className="gap-2" size="lg" variant="outline">
              <a
                href="https://github.com/closedloop-ai/claude-marketplace"
                rel="noopener noreferrer"
                target="_blank"
              >
                <Github className="h-4 w-4" />
                {d.githubButton}
              </a>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
