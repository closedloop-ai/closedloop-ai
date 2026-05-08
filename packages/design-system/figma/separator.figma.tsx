import figma from "@figma/code-connect";
import { Separator } from "@repo/design-system/components/ui/separator";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/ClosedLoop-Design-System?node-id=2753-10017";

figma.connect(Separator, FIGMA_URL, {
  props: {
    orientation: figma.enum("Orientation", {
      Horizontal: "horizontal",
      Vertical: "vertical",
    }),
  },
  example: ({ orientation }) => <Separator orientation={orientation} />,
});
