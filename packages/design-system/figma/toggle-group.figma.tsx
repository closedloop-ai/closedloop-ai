import figma from "@figma/code-connect";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/ClosedLoop-Design-System?node-id=2769-30628";

figma.connect(ToggleGroup, FIGMA_URL, {
  props: {
    items: figma.children("Items"),
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
  example: ({ items, variant, size }) => (
    <ToggleGroup size={size} type="single" variant={variant}>
      {items}
    </ToggleGroup>
  ),
});

const ITEM_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/ClosedLoop-Design-System?node-id=2769-30628";

figma.connect(ToggleGroupItem, ITEM_URL, {
  props: {
    children: figma.string("Label"),
  },
  example: ({ children }) => (
    <ToggleGroupItem value="item">{children}</ToggleGroupItem>
  ),
});
