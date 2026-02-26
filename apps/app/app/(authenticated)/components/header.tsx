import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@repo/design-system/components/ui/breadcrumb";
import { SidebarTrigger } from "@repo/design-system/components/ui/sidebar";
import { Fragment, type ReactNode } from "react";

type HeaderProps = {
  pages: string[];
  page: string;
  children?: ReactNode;
};

export const Header = ({ pages, page, children }: HeaderProps) => (
  <header className="flex shrink-0 items-center justify-between gap-2 py-2">
    <div className="flex items-center gap-2 px-4">
      <SidebarTrigger className="-ml-1" />
      <Breadcrumb>
        <BreadcrumbList>
          {pages.map((breadcrumbPage, index) => (
            <Fragment key={breadcrumbPage}>
              {index > 0 && <BreadcrumbSeparator className="hidden md:block" />}
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbLink href="#">{breadcrumbPage}</BreadcrumbLink>
              </BreadcrumbItem>
            </Fragment>
          ))}
          <BreadcrumbSeparator className="hidden md:block" />
          <BreadcrumbItem>
            <BreadcrumbPage>{page}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    </div>
    {children}
  </header>
);
