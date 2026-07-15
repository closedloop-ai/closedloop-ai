import { Input } from "@closedloop-ai/design-system/components/ui/input";
import figma from "@figma/code-connect";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/Closedloop-Design-System?node-id=2732-15509";

figma.connect(Input, FIGMA_URL, {
  props: {
    placeholder: figma.string("Placeholder"),
    disabled: figma.boolean("Disabled"),
  },
  example: ({ placeholder, disabled }) => (
    <Input disabled={disabled} placeholder={placeholder} />
  ),
});
