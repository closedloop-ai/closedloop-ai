import figma from "@figma/code-connect";
import { Switch } from "@repo/design-system/components/ui/switch";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/Closedloop-Design-System?node-id=2769-29914";

figma.connect(Switch, FIGMA_URL, {
  props: {
    checked: figma.boolean("Checked"),
    disabled: figma.boolean("Disabled"),
  },
  example: ({ checked, disabled }) => (
    <Switch checked={checked} disabled={disabled} />
  ),
});
