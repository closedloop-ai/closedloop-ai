import figma from "@figma/code-connect";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/Closedloop-Design-System?node-id=168-2123";

figma.connect(Skeleton, FIGMA_URL, {
  example: () => <Skeleton className="h-4 w-[250px]" />,
});
