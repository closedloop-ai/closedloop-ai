import figma from "@figma/code-connect";
import { Label } from "@repo/design-system/components/ui/label";
import {
  RadioGroup,
  RadioGroupItem,
} from "@repo/design-system/components/ui/radio-group";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/ClosedLoop-Design-System?node-id=2780-51105";

figma.connect(RadioGroup, FIGMA_URL, {
  props: {
    items: figma.children("Items"),
  },
  example: ({ items }) => (
    <RadioGroup defaultValue="option-1">{items}</RadioGroup>
  ),
});

const ITEM_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/ClosedLoop-Design-System?node-id=2780-51111";

figma.connect(RadioGroupItem, ITEM_URL, {
  props: {
    label: figma.string("Label"),
    disabled: figma.boolean("Disabled"),
  },
  example: ({ label, disabled }) => (
    <div className="flex items-center space-x-2">
      <RadioGroupItem disabled={disabled} id="option" value="option" />
      <Label htmlFor="option">{label}</Label>
    </div>
  ),
});
