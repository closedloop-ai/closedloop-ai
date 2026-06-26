import figma from "@figma/code-connect";
import { Textarea } from "@repo/design-system/components/ui/textarea";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/Closedloop-Design-System?node-id=2807-10440";

figma.connect(Textarea, FIGMA_URL, {
  props: {
    placeholder: figma.string("Placeholder"),
    disabled: figma.boolean("Disabled"),
  },
  example: ({ placeholder, disabled }) => (
    <Textarea disabled={disabled} placeholder={placeholder} />
  ),
});
