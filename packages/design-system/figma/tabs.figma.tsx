import figma from "@figma/code-connect";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";

const FIGMA_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/Closedloop-Design-System?node-id=2764-25046";

figma.connect(Tabs, FIGMA_URL, {
  props: {
    triggers: figma.children("Triggers"),
  },
  example: ({ triggers }) => (
    <Tabs defaultValue="tab-1">
      <TabsList>{triggers}</TabsList>
      <TabsContent value="tab-1">Tab content</TabsContent>
    </Tabs>
  ),
});

const TRIGGER_URL =
  "https://www.figma.com/design/py1Sc5dZnNzqPOYXDqJuAU/Closedloop-Design-System?node-id=2761-24993";

figma.connect(TabsTrigger, TRIGGER_URL, {
  props: {
    children: figma.string("Label"),
  },
  example: ({ children }) => <TabsTrigger value="tab">{children}</TabsTrigger>,
});
