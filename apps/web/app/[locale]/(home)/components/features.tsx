import type { HomePage } from "@repo/cms";
import type { Dictionary } from "@repo/internationalization";
// biome-ignore lint/performance/noNamespaceImport: Required for dynamic icon loading from CMS
import * as Icons from "lucide-react";

type FeaturesProps = {
  cmsData?: HomePage["features"] | null;
  dictionary: Dictionary;
};

export const Features = ({ cmsData, dictionary }: FeaturesProps) => {
  // Use CMS data if available, otherwise fall back to dictionary
  const title = cmsData?.title ?? dictionary.web.home.features.title;
  const description =
    cmsData?.description ?? dictionary.web.home.features.description;
  const items = cmsData?.items?.items ?? dictionary.web.home.features.items;

  // Helper to get icon component
  const getIcon = (iconName?: string | null) => {
    if (!iconName) {
      return Icons.User;
    }
    // biome-ignore lint/performance/noDynamicNamespaceImportAccess: Icon name comes from CMS data
    const IconComponent = Icons[iconName as keyof typeof Icons];
    return IconComponent && typeof IconComponent !== "string"
      ? (IconComponent as React.ComponentType<{ className?: string }>)
      : Icons.User;
  };

  return (
    <div className="w-full py-20 lg:py-40">
      <div className="container mx-auto">
        <div className="flex flex-col gap-10">
          <div className="flex flex-col items-start gap-4">
            <div className="flex flex-col gap-2">
              <h2 className="max-w-xl text-left font-regular text-3xl tracking-tighter md:text-5xl">
                {title}
              </h2>
              <p className="max-w-xl text-left text-lg text-muted-foreground leading-relaxed tracking-tight lg:max-w-lg">
                {description}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {/* @ts-expect-error - Types will be inferred once BaseHub schema is created */}
            {items.map((item, index) => {
              const Icon = getIcon(item.icon);
              const isWide = index === 0 || index === 3;

              return (
                <div
                  className={`flex aspect-square ${isWide ? "h-full lg:col-span-2 lg:aspect-auto" : ""} flex-col justify-between rounded-md bg-muted p-6`}
                  // biome-ignore lint/suspicious/noArrayIndexKey: Pre-existing pattern, items are static
                  key={index}
                >
                  <Icon className="h-8 w-8 stroke-1" />
                  <div className="flex flex-col">
                    <h3 className="text-xl tracking-tight">{item.title}</h3>
                    <p className="max-w-xs text-base text-muted-foreground">
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
