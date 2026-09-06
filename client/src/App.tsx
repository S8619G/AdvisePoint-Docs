import { Switch, Route, Router, Link, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Upload from "@/pages/upload";
import Library from "@/pages/library";
import Query from "@/pages/query";
import SchemaPage from "@/pages/schema";
import { Database, FileUp, Library as LibraryIcon, Search, Settings } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { APP_VERSION } from "./version";
import { UpdateBanner } from "@/components/UpdateBanner";
import { BackendDownOverlay } from "@/components/BackendDownOverlay";
import { libraryTabStore } from "@/lib/libraryTabStore";
import { useTabState } from "@/lib/tabStore";

function TopNav() {
  const [loc] = useLocation();
  const { data: stats } = useQuery<{ documents: number; chunks: number }>({
    queryKey: ["/api/stats"],
    refetchInterval: 5000,
  });
  // v0.9.31 hotfix 2: the Library tab remembers the last route the user
  // was viewing inside Library, so clicking it after visiting Query
  // returns to the same doc instead of resetting to the list. Falls back
  // to "/library" on first visit.
  const lastLibraryPath = useTabState(libraryTabStore, (s) => s.lastLibraryPath);
  const tabs = [
    { href: lastLibraryPath ?? "/library", label: "Library", icon: LibraryIcon, testid: "tab-library" },
    { href: "/upload", label: "Upload", icon: FileUp, testid: "tab-upload" },
    { href: "/query", label: "Query", icon: Search, testid: "tab-query" },
  ];
  const schemaActive = loc === "/schema" || loc.startsWith("/schema/");
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur">
      <div className="mx-auto flex max-w-[1400px] items-center gap-6 px-6 py-3">
        <Link href="/" className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-primary text-primary-foreground">
            <Database className="h-4 w-4" />
          </span>
          <span className="font-semibold tracking-tight">AdvisePoint Docs</span>
          <span className="ml-1 rounded-md border border-amber-400/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-amber-600 dark:text-amber-400">
            v{APP_VERSION} BETA
          </span>
        </Link>
        <nav className="flex items-center gap-1">
          {tabs.map((t) => {
            const active =
              t.href === "/"
                ? loc === "/" || loc.startsWith("/library")
                : loc === t.href || loc.startsWith(t.href + "/");
            const Icon = t.icon;
            return (
              <Link
                key={t.href}
                href={t.href}
                data-testid={t.testid}
                className={
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors " +
                  (active
                    ? "bg-secondary text-secondary-foreground"
                    : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
                }
              >
                <Icon className="h-3.5 w-3.5" />
                {t.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-3 font-mono text-[11px] text-muted-foreground">
          <span data-testid="text-stat-docs">
            <span className="text-foreground">{stats?.documents ?? 0}</span> docs
          </span>
          <span className="opacity-50">·</span>
          <span data-testid="text-stat-chunks">
            <span className="text-foreground">{stats?.chunks ?? 0}</span> excerpts
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                href="/schema"
                data-testid="tab-schema"
                aria-label="Settings, about & schema"
                className={
                  "ml-2 grid h-8 w-8 place-items-center rounded-md transition-colors " +
                  (schemaActive
                    ? "bg-secondary text-secondary-foreground"
                    : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
                }
              >
                <Settings className="h-4 w-4" />
              </Link>
            </TooltipTrigger>
            <TooltipContent side="bottom">Settings, about &amp; schema</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </header>
  );
}

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={Library} />
      <Route path="/upload" component={Upload} />
      <Route path="/library" component={Library} />
      <Route path="/library/:id" component={Library} />
      <Route path="/query" component={Query} />
      <Route path="/schema" component={SchemaPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router hook={useHashLocation}>
          <div className="min-h-screen bg-background text-foreground">
            <TopNav />
            <UpdateBanner />
            <main className="mx-auto max-w-[1400px] px-6 py-8">
              <AppRouter />
            </main>
          </div>
        </Router>
        {/* v0.9.26 - Full-screen overlay that appears whenever the local
            backend stops responding. Always mounted so it can react to any
            fetch failure from anywhere in the app. */}
        <BackendDownOverlay />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
