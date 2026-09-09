import { HotkeyProviderWrapper } from '@/components/providers/hotkey-provider-wrapper';
import { AppSidebar } from '@/components/ui/app-sidebar';
import { MailHeader } from '@/components/mail/mail-header';
import { Outlet } from 'react-router';

export default function MailLayout() {
  return (
    <HotkeyProviderWrapper>
      <div className="bg-sidebar relative flex h-dvh min-h-0 w-full overflow-hidden">
        <MailHeader />
        <AppSidebar />
        <main className="min-w-0 flex-1 overflow-hidden pt-16">
          <div className="h-full min-h-0 pr-2 pb-2 max-md:pr-0 max-md:pb-0">
            <Outlet />
          </div>
        </main>
      </div>
    </HotkeyProviderWrapper>
  );
}
