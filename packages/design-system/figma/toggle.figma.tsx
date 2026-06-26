import figma from "@figma/code-connect";
import { Toggle } from "@repo/design-system/components/ui/toggle";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/Closedloop-Design-System?node-id=2768-28168";

figma.connect(Toggle, FIGMA_URL, {
  props: {
    children: figma.string("Label"),
    disabled: figma.boolean("Disabled"),
    variant: figma.enum("Variant", {
      Default: "default",
      Outline: "outline",
    }),
    size: figma.enum("Size", {
      Default: "default",
      Small: "sm",
      Large: "lg",
    }),
  },
  example: ({ children, disabled, variant, size }) => (
    <Toggle disabled={disabled} size={size} variant={variant}>
      {children}
    </Toggle>
  ),
});
