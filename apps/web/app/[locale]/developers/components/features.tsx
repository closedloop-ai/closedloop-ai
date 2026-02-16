import type { Dictionary } from "@repo/internationalization";
import {
  Activity,
  CheckCircle,
  Clock,
  FileText,
  LayoutGrid,
  Users,
} from "lucide-react";

type FeaturesProps = {
  dictionary: Dictionary;
};

const featureIcons = [
  FileText,
  Clock,
  Users,
  CheckCircle,
  Activity,
  LayoutGrid,
];

export const Features = ({ dictionary }: FeaturesProps) => {
  const d = dictionary.web.developers.features;

  return (
    <div className="w-full py-20 lg:py-40">
      <div className="container mx-auto">
        <div className="flex flex-col gap-10">
          <div className="flex flex-col items-center gap-4 text-center">
            <span className="font-semibold text-indigo-500 text-xs uppercase tracking-widest">
              {d.label}
            </span>
            <h2 className="max-w-xl font-bold text-3xl tracking-tighter md:text-5xl">
              {d.title}
            </h2>
            <p className="max-w-xl text-lg text-muted-foreground leading-relaxed">
              {d.description}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {d.items.map((item, index) => {
              const Icon = featureIcons[index] ?? FileText;
              return (
                <div
                  className="flex flex-col gap-4 rounded-lg border bg-card/70 p-7 transition-colors hover:border-border/80 hover:bg-card"
                  // biome-ignore lint/suspicious/noArrayIndexKey: Static content list
                  key={index}
                >
                  <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-indigo-500/10">
                    <Icon className="h-5 w-5 text-indigo-400" />
                  </div>
                  <div className="flex flex-col gap-2">
                    <h3 className="font-semibold text-lg">{item.title}</h3>
                    <p className="text-muted-foreground text-sm leading-relaxed">
                      {item.description}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
