import figma from "@figma/code-connect";
import { Input } from "@repo/design-system/components/ui/input";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/ClosedLoop-Design-System?node-id=2732-15509";

figma.connect(Input, FIGMA_URL, {
  props: {
    placeholder: figma.string("Placeholder"),
    disabled: figma.boolean("Disabled"),
  },
  example: ({ placeholder, disabled }) => (
    <Input disabled={disabled} placeholder={placeholder} />
  ),
});
