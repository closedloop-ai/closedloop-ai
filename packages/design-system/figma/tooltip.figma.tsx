import figma from "@figma/code-connect";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@closedloop-ai/design-system/components/ui/tooltip";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/Closedloop-Design-System?node-id=6873-680";

figma.connect(TooltipContent, FIGMA_URL, {
  props: {
    label: figma.string("Label"),
    trigger: figma.children("Trigger"),
  },
  example: ({ label, trigger }) => (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  ),
});
