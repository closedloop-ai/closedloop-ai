import figma from "@figma/code-connect";
import {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
} from "@repo/design-system/components/ui/navigation-menu";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/ClosedLoop-Design-System?node-id=13-764";

figma.connect(NavigationMenu, FIGMA_URL, {
  props: {
    items: figma.children("Items"),
  },
  example: ({ items }) => (
    <NavigationMenu>
      <NavigationMenuList>{items}</NavigationMenuList>
    </NavigationMenu>
  ),
});

const ITEM_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/ClosedLoop-Design-System?node-id=13-716";

figma.connect(NavigationMenuItem, ITEM_URL, {
  props: {
    children: figma.string("Label"),
  },
  example: ({ children }) => (
    <NavigationMenuItem>
      <NavigationMenuLink href="#">{children}</NavigationMenuLink>
    </NavigationMenuItem>
  ),
});
