import figma from "@figma/code-connect";
import { Progress } from "@repo/design-system/components/ui/progress";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/ClosedLoop-Design-System?node-id=2768-27760";

figma.connect(Progress, FIGMA_URL, {
  example: () => <Progress value={33} />,
});
