import figma from "@figma/code-connect";
import { Checkbox } from "@closedloop-ai/design-system/components/ui/checkbox";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/Closedloop-Design-System?node-id=1-117";

figma.connect(Checkbox, FIGMA_URL, {
  props: {
    checked: figma.boolean("Checked"),
    disabled: figma.boolean("Disabled"),
  },
  example: ({ checked, disabled }) => (
    <Checkbox checked={checked} disabled={disabled} />
  ),
});
