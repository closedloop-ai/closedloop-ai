import figma from "@figma/code-connect";
import { Label } from "@repo/design-system/components/ui/label";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/ClosedLoop-Design-System?node-id=6837-15447";

figma.connect(Label, FIGMA_URL, {
  props: {
    children: figma.string("Label"),
  },
  example: ({ children }) => <Label>{children}</Label>,
});
