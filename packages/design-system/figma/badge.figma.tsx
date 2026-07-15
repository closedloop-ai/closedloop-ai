import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import figma from "@figma/code-connect";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/Closedloop-Design-System?node-id=136-1178";

figma.connect(Badge, FIGMA_URL, {
  props: {
    children: figma.string("Label"),
    variant: figma.enum("Variant", {
      Default: "default",
      Secondary: "secondary",
      Destructive: "destructive",
      Outline: "outline",
    }),
  },
  example: ({ children, variant }) => (
    <Badge variant={variant}>{children}</Badge>
  ),
});
