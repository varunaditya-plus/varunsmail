import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SettingsCard } from '@/components/settings/settings-card';
import { getBrowserTimezone } from '@/lib/timezones';
import { useTRPC } from '@/providers/query-provider';
import { useSettings } from '@/hooks/use-settings';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Bell, Clock, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

type NotificationPreferences = {
  newMailNotifications: 'none' | 'important' | 'all';
  priorityNotificationSenders: string[];
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  notificationTimezone: string;
};

const DEFAULTS: NotificationPreferences = {
  newMailNotifications: 'important',
  priorityNotificationSenders: [],
  quietHoursEnabled: false,
  quietHoursStart: '22:00',
  quietHoursEnd: '07:00',
  notificationTimezone: getBrowserTimezone(),
};

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_PATTERN = /^@?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
const PERMISSION_CHANGE_EVENT = 'varunsmail-notification-permission-change';

function isValidTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export default function NotificationsPage() {
  const [isSaving, setIsSaving] = useState(false);
  const [senderInput, setSenderInput] = useState('');
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('default');
  const { data, refetch } = useSettings();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { mutateAsync: saveUserSettings } = useMutation(trpc.settings.save.mutationOptions());
  const timezones = useMemo(() => Intl.supportedValuesOf('timeZone'), []);

  const form = useForm<NotificationPreferences>({ defaultValues: DEFAULTS });
  const prioritySenders = form.watch('priorityNotificationSenders');
  const quietHoursEnabled = form.watch('quietHoursEnabled');

  useEffect(() => {
    function updatePermission() {
      setPermission(
        typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
      );
    }

    updatePermission();
    window.addEventListener('focus', updatePermission);
    return () => window.removeEventListener('focus', updatePermission);
  }, []);

  useEffect(() => {
    if (!data?.settings) return;
    const settings = data.settings;
    form.reset({
      newMailNotifications: settings.newMailNotifications ?? DEFAULTS.newMailNotifications,
      priorityNotificationSenders:
        settings.priorityNotificationSenders ?? DEFAULTS.priorityNotificationSenders,
      quietHoursEnabled: settings.quietHoursEnabled ?? DEFAULTS.quietHoursEnabled,
      quietHoursStart: settings.quietHoursStart ?? DEFAULTS.quietHoursStart,
      quietHoursEnd: settings.quietHoursEnd ?? DEFAULTS.quietHoursEnd,
      notificationTimezone: settings.notificationTimezone || DEFAULTS.notificationTimezone,
    });
  }, [data?.settings, form]);

  function addPrioritySender() {
    const sender = senderInput.trim().toLowerCase().replace(/^@(?=[^@]+$)/, '');
    if (!EMAIL_PATTERN.test(sender) && !DOMAIN_PATTERN.test(sender)) {
      form.setError('priorityNotificationSenders', {
        message: 'Enter an email address or domain, such as person@example.com or example.com.',
      });
      return;
    }
    if (!prioritySenders.includes(sender)) {
      form.setValue('priorityNotificationSenders', [...prioritySenders, sender], {
        shouldDirty: true,
      });
    }
    form.clearErrors('priorityNotificationSenders');
    setSenderInput('');
  }

  async function requestPermission() {
    if (typeof Notification === 'undefined') {
      toast.error('This browser does not support mail notifications.');
      return;
    }
    const nextPermission = await Notification.requestPermission();
    setPermission(nextPermission);
    window.dispatchEvent(new Event(PERMISSION_CHANGE_EVENT));
    if (nextPermission === 'granted') toast.success('Browser notifications are enabled.');
    else toast.error('Browser notification permission was not granted.');
  }

  async function onSubmit(values: NotificationPreferences) {
    if (!data?.settings) return;

    let hasError = false;
    if (!TIME_PATTERN.test(values.quietHoursStart)) {
      form.setError('quietHoursStart', { message: 'Use a valid 24-hour time.' });
      hasError = true;
    }
    if (!TIME_PATTERN.test(values.quietHoursEnd)) {
      form.setError('quietHoursEnd', { message: 'Use a valid 24-hour time.' });
      hasError = true;
    }
    if (!isValidTimezone(values.notificationTimezone)) {
      form.setError('notificationTimezone', { message: 'Choose a valid timezone.' });
      hasError = true;
    }
    if (hasError) return;

    setIsSaving(true);
    const saved = data.settings;
    const nextSettings = { ...data.settings, ...values };
    try {
      queryClient.setQueryData(trpc.settings.get.queryKey(), { settings: nextSettings });
      await saveUserSettings(nextSettings);
      await refetch();
      toast.success('Notification settings saved.');
    } catch (error) {
      console.error(error);
      queryClient.setQueryData(trpc.settings.get.queryKey(), { settings: saved });
      toast.error('Failed to save notification settings.');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="grid gap-6">
      <SettingsCard
        title="Notifications"
        description="Choose which new messages can notify you and when alerts should stay quiet."
        footer={
          <div className="flex justify-end">
            <Button type="submit" form="notifications-form" disabled={isSaving || !data?.settings}>
              {isSaving ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        }
      >
        <Form {...form}>
          <form
            id="notifications-form"
            onSubmit={form.handleSubmit(onSubmit)}
            className="max-w-xl space-y-6"
          >
            <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
              <div className="space-y-0.5">
                <FormLabel className="text-base">Browser permission</FormLabel>
                <FormDescription>
                  {permission === 'granted'
                    ? 'This browser can show new mail notifications.'
                    : permission === 'denied'
                      ? 'Notifications are blocked in your browser settings.'
                      : permission === 'unsupported'
                        ? 'This browser does not support notifications.'
                        : 'Allow this browser to show new mail notifications.'}
                </FormDescription>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={requestPermission}
                disabled={
                  permission === 'granted' ||
                  permission === 'denied' ||
                  permission === 'unsupported'
                }
              >
                <Bell />
                {permission === 'granted' ? 'Allowed' : 'Allow'}
              </Button>
            </div>

            <FormField
              control={form.control}
              name="newMailNotifications"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>New mail notifications</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger className="w-full max-w-xs">
                        <Bell className="mr-2 h-4 w-4" />
                        <SelectValue placeholder="Select notification level" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      <SelectItem value="important">Important and priority senders</SelectItem>
                      <SelectItem value="all">All new mail</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Important mail includes Gmail importance and the senders or domains below.
                  </FormDescription>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="priorityNotificationSenders"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Priority senders and domains</FormLabel>
                  <div className="flex gap-2">
                    <FormControl>
                      <Input
                        value={senderInput}
                        onChange={(event) => setSenderInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter') return;
                          event.preventDefault();
                          addPrioritySender();
                        }}
                        placeholder="person@example.com or example.com"
                      />
                    </FormControl>
                    <Button type="button" variant="outline" onClick={addPrioritySender}>
                      Add
                    </Button>
                  </div>
                  {field.value.length > 0 && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {field.value.map((sender) => (
                        <div
                          key={sender}
                          className="bg-secondary text-secondary-foreground flex items-center gap-1 rounded-full px-3 py-1 text-sm"
                        >
                          <span>{sender}</span>
                          <button
                            type="button"
                            className="rounded-full p-0.5 hover:bg-black/10 dark:hover:bg-white/10"
                            onClick={() => {
                              field.onChange(field.value.filter((value) => value !== sender));
                              form.clearErrors('priorityNotificationSenders');
                            }}
                            aria-label={`Remove ${sender}`}
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <FormDescription>
                    These addresses and domains count as important when that notification level is selected.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="quietHoursEnabled"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between rounded-lg border p-4">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base">Quiet hours</FormLabel>
                    <FormDescription>Pause browser notifications during a daily time window.</FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />

            {quietHoursEnabled && (
              <div className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="quietHoursStart"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Starts</FormLabel>
                      <FormControl>
                        <Input type="time" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="quietHoursEnd"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Ends</FormLabel>
                      <FormControl>
                        <Input type="time" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="notificationTimezone"
                  render={({ field }) => (
                    <FormItem className="sm:col-span-2">
                      <FormLabel>Timezone</FormLabel>
                      <FormControl>
                        <div className="relative">
                          <Clock className="text-muted-foreground pointer-events-none absolute top-3 left-3 h-4 w-4" />
                          <Input className="pl-9" list="notification-timezones" {...field} />
                          <datalist id="notification-timezones">
                            {timezones.map((timezone) => (
                              <option value={timezone} key={timezone} />
                            ))}
                          </datalist>
                        </div>
                      </FormControl>
                      <FormDescription>Quiet hours use this timezone.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            )}
          </form>
        </Form>
      </SettingsCard>
    </div>
  );
}
