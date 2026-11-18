import { Link, useNavigate } from "@tanstack/react-router";
import {
  LayoutDashboard,
  ListChecks,
  Table2,
  KeyRound,
  UserRound,
  BookOpen,
  FileText,
  LogOut,
  Database as DatabaseIcon,
  Mail,
  Radar,
  PanelLeft,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/jobs", label: "Batch Jobs", icon: ListChecks },
  { to: "/contacts", label: "Verified Contacts", icon: Table2 },
  { to: "/database", label: "Contact Database", icon: DatabaseIcon },
  { to: "/outreach", label: "Outreach", icon: Mail },
  { to: "/settings", label: "API Settings", icon: KeyRound },
  { to: "/profile", label: "Profile", icon: UserRound },
  { to: "/docs", label: "How It Works", icon: BookOpen },
  { to: "/report", label: "Progress Report", icon: FileText },
] as const;

const STORAGE_KEY = "recyc.sidebar.collapsed";

export function AppShell({
  title,
  description,
  children,
  actions,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    setCollapsed(localStorage.getItem(STORAGE_KEY) === "1");
  }, []);

  function toggleDesktop() {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  }

  async function signOut() {
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  const sidebar = (mobile: boolean) => (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-4">
        <Radar className="h-5 w-5 shrink-0 text-primary" />
        {(!collapsed || mobile) && (
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold leading-tight">RECYC</p>
            <p className="truncate text-xs text-muted-foreground">Contact OSINT</p>
          </div>
        )}
        {mobile && (
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto"
            onClick={() => setMobileOpen(false)}
            aria-label="Close menu"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
      <nav className="flex-1 space-y-1 p-2">
        {NAV.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            title={label}
            onClick={() => setMobileOpen(false)}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              collapsed && !mobile && "justify-center px-2",
            )}
            activeProps={{ className: "bg-accent text-foreground font-medium" }}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {(!collapsed || mobile) && <span className="truncate">{label}</span>}
          </Link>
        ))}
      </nav>
      <div className="border-t border-border p-2">
        <Button
          variant="ghost"
          size="sm"
          className={cn("w-full gap-2", collapsed && !mobile ? "justify-center px-0" : "justify-start")}
          onClick={signOut}
          title="Sign out"
        >
          <LogOut className="h-4 w-4" />
          {(!collapsed || mobile) && "Sign out"}
        </Button>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside
        className={cn(
          "hidden shrink-0 border-r border-border bg-card transition-[width] duration-200 md:block",
          collapsed ? "w-16" : "w-64",
        )}
      >
        {sidebar(false)}
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            className="absolute inset-0 bg-black/50"
            aria-label="Close menu overlay"
            onClick={() => setMobileOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 w-64 border-r border-border bg-card shadow-xl">
            {sidebar(true)}
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="hidden md:inline-flex"
              onClick={toggleDesktop}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              <PanelLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
            >
              <PanelLeft className="h-4 w-4" />
            </Button>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold tracking-tight sm:text-xl">{title}</h1>
              {description ? (
                <p className="truncate text-sm text-muted-foreground">{description}</p>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </header>
        <main className="min-w-0 flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
