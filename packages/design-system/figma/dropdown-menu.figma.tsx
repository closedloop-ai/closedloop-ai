import figma from "@figma/code-connect";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/Closedloop-Design-System?node-id=4-6588";

figma.connect(DropdownMenuContent, FIGMA_URL, {
  props: {
    items: figma.children("Items"),
  },
  example: ({ items }) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">Open</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>{items}</DropdownMenuContent>
    </DropdownMenu>
  ),
});

const ITEM_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/Closedloop-Design-System?node-id=13-337";

figma.connect(DropdownMenuItem, ITEM_URL, {
  props: {
    children: figma.string("Label"),
    disabled: figma.boolean("Disabled"),
  },
  example: ({ children, disabled }) => (
    <DropdownMenuItem disabled={disabled}>{children}</DropdownMenuItem>
  ),
});
