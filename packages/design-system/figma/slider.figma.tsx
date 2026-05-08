import figma from "@figma/code-connect";
import { Slider } from "@repo/design-system/components/ui/slider";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/ClosedLoop-Design-System?node-id=2785-10703";

figma.connect(Slider, FIGMA_URL, {
  props: {
    disabled: figma.boolean("Disabled"),
  },
  example: ({ disabled }) => (
    <Slider defaultValue={[50]} disabled={disabled} max={100} step={1} />
  ),
});
