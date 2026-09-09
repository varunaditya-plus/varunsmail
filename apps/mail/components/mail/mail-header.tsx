import { Link, useLocation } from 'react-router';
import { Search, Settings, SlidersHorizontal } from 'lucide-react';

import { useCommandPalette } from '@/components/context/command-palette-context';
import { SidebarToggle } from '@/components/ui/sidebar-toggle';
import { NavUser } from '@/components/ui/nav-user';
import { Button } from '@/components/ui/button';
import { useSidebar } from '@/components/ui/sidebar';
import { isMac } from '@/lib/platform';
import { cn } from '@/lib/utils';
import { useQueryState } from 'nuqs';

export function MailHeader() {
  const { state } = useSidebar();
  const { activeFilters } = useCommandPalette();
  const [, setIsCommandPaletteOpen] = useQueryState('isCommandPaletteOpen');
  const { pathname, search } = useLocation();
  const settingsHref = `/settings/general?from=${encodeURIComponent(pathname + search)}`;

  return (
    <header className="bg-sidebar fixed inset-x-0 top-0 z-40 flex h-16 items-center gap-2 px-2 md:gap-4">
      <div
        className={cn(
          'flex shrink-0 items-center gap-2 transition-[width] duration-200',
          state === 'expanded' ? 'md:w-[calc(var(--sidebar-width)-1.5rem)]' : 'md:w-10',
        )}
      >
        <SidebarToggle className="h-10 w-10 shrink-0 rounded-full" />
        <span
          className={cn(
            'truncate text-lg font-medium tracking-[-0.02em]',
            state === 'collapsed' && 'md:hidden',
          )}
        >
          Varun&apos;s Mail
        </span>
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => void setIsCommandPaletteOpen('true')}
          className="bg-muted/70 hover:bg-muted focus-visible:ring-ring flex h-12 min-w-0 flex-1 items-center gap-3 rounded-3xl px-4 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 sm:max-w-2xl"
          aria-label="Search mail"
        >
          <Search className="text-muted-foreground h-5 w-5 shrink-0" />
          <span className="text-muted-foreground hidden min-w-0 flex-1 truncate sm:block">
            {activeFilters.length
              ? activeFilters.map((filter) => filter.display).join(', ')
              : 'Search mail'}
          </span>
          <kbd className="text-muted-foreground hidden shrink-0 items-center gap-1 text-xs lg:flex">
            <span>{isMac ? '⌘' : 'Ctrl'}</span>
            <span>K</span>
          </kbd>
          <SlidersHorizontal className="text-muted-foreground hidden h-4 w-4 shrink-0 sm:block" />
        </button>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="hidden h-10 w-10 rounded-full sm:inline-flex"
          >
            <Link to={settingsHref} aria-label="Settings">
              <Settings className="h-5 w-5" />
            </Link>
          </Button>
          <NavUser compact />
        </div>
      </div>
    </header>
  );
}
