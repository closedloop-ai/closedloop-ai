import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { createPageMetadata } from "@/lib/site";

export const generateMetadata = async () =>
  createPageMetadata(
    "Community",
    "Meetups, contributors, and the builder community around ClosedLoop.ai."
  );

const CommunityPage = () => (
  <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-12 md:px-10">
    <div className="space-y-3">
      <p className="font-medium text-muted-foreground text-sm uppercase tracking-[0.2em]">
        Community
      </p>
      <h1 className="font-semibold text-4xl tracking-tight">
        Build the category in public.
      </h1>
      <p className="max-w-2xl text-muted-foreground">
        Community starts small in phase 1: meetup presence, GitHub visibility,
        and a clear path for contributors who want to shape the product and the
        docs graph.
      </p>
    </div>

    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Austin meetup</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          A simple landing point for in-person community activity while the
          broader contributor program is still forming.
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Open source credibility</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          The docs site, templates, and implementation references all reinforce
          that ClosedLoop.ai is being built as a transparent system rather than
          a black box.
        </CardContent>
      </Card>
    </div>
  </div>
);

export default CommunityPage;
