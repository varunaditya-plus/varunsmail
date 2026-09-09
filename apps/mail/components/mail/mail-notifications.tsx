import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/providers/query-provider';
import { useSettings } from '@/hooks/use-settings';
import { useEffect, useRef, useState } from 'react';

type NotificationThread = {
  id: string;
  connectionId?: string;
  senderEmail?: string;
  senderName?: string;
  subject?: string;
  labels?: string[];
  hasUnread?: boolean;
};

type NotificationSettings = {
  newMailNotifications?: 'none' | 'important' | 'all';
  priorityNotificationSenders?: string[];
  quietHoursEnabled?: boolean;
  quietHoursStart?: string;
  quietHoursEnd?: string;
  notificationTimezone?: string;
};

const SEEN_THREADS_KEY = 'varunsmail-notified-threads';
const PERMISSION_CHANGE_EVENT = 'varunsmail-notification-permission-change';
const POLL_INTERVAL = 60 * 1000;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function readSeenThreads() {
  try {
    const stored = JSON.parse(localStorage.getItem(SEEN_THREADS_KEY) || '[]');
    return new Set<string>(
      Array.isArray(stored) ? stored.filter((key) => typeof key === 'string') : [],
    );
  } catch (error) {
    console.error('Failed to read notified mail threads', error);
    return new Set<string>();
  }
}

function saveSeenThreads(threads: Set<string>) {
  try {
    localStorage.setItem(SEEN_THREADS_KEY, JSON.stringify([...threads].slice(-1000)));
  } catch (error) {
    console.error('Failed to save notified mail threads', error);
  }
}

function notificationKey(thread: NotificationThread) {
  return `${thread.connectionId}:${thread.id}`;
}

function matchesPrioritySender(senderEmail: string | undefined, prioritySenders: string[]) {
  if (!senderEmail) return false;
  const email = senderEmail.toLowerCase();
  const domain = email.split('@')[1];
  return prioritySenders.some((value) => {
    const priority = value.trim().toLowerCase().replace(/^@/, '');
    return priority.includes('@') ? email === priority : domain === priority;
  });
}

function isQuietHours(settings: NotificationSettings) {
  if (!settings.quietHoursEnabled) return false;
  const { quietHoursStart, quietHoursEnd, notificationTimezone } = settings;
  if (!quietHoursStart || !quietHoursEnd || !notificationTimezone) return false;
  if (!TIME_PATTERN.test(quietHoursStart) || !TIME_PATTERN.test(quietHoursEnd)) return false;

  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: notificationTimezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts();
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    const current = hour * 60 + minute;
    const [startHour, startMinute] = quietHoursStart.split(':').map(Number);
    const [endHour, endMinute] = quietHoursEnd.split(':').map(Number);
    const start = (startHour ?? 0) * 60 + (startMinute ?? 0);
    const end = (endHour ?? 0) * 60 + (endMinute ?? 0);

    if (start === end) return false;
    return start < end ? current >= start && current < end : current >= start || current < end;
  } catch (error) {
    console.error('Failed to evaluate notification quiet hours', error);
    return false;
  }
}

function shouldNotify(thread: NotificationThread, settings: NotificationSettings) {
  if (!thread.hasUnread || settings.newMailNotifications === 'none') return false;
  if (settings.newMailNotifications === 'all') return true;
  const isImportant = thread.labels?.some((label) => label.toUpperCase() === 'IMPORTANT');
  return (
    !!isImportant ||
    matchesPrioritySender(thread.senderEmail, settings.priorityNotificationSenders ?? [])
  );
}

export function MailNotifications() {
  const [storageReady, setStorageReady] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('default');
  const seenThreadsRef = useRef(new Set<string>());
  const seededRef = useRef(false);
  const { data } = useSettings();
  const trpc = useTRPC();
  const settings = data?.settings;
  const threadsQuery = useQuery(
    trpc.mail.listUnifiedThreads.queryOptions(
      { q: '', labelIds: [], connectionIds: [], maxResults: 50, cursor: '' },
      {
        enabled:
          permission === 'granted' &&
          !!settings &&
          settings.newMailNotifications !== 'none',
        staleTime: 0,
        refetchInterval: POLL_INTERVAL,
        refetchIntervalInBackground: true,
      },
    ),
  );

  useEffect(() => {
    seenThreadsRef.current = readSeenThreads();
    setStorageReady(true);
  }, []);

  useEffect(() => {
    function updatePermission() {
      setPermission(
        typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
      );
    }

    updatePermission();
    window.addEventListener('focus', updatePermission);
    window.addEventListener(PERMISSION_CHANGE_EVENT, updatePermission);
    return () => {
      window.removeEventListener('focus', updatePermission);
      window.removeEventListener(PERMISSION_CHANGE_EVENT, updatePermission);
    };
  }, []);

  useEffect(() => {
    if (!storageReady || !settings || !threadsQuery.data) return;
    const threads = threadsQuery.data.threads as NotificationThread[];

    if (!seededRef.current) {
      for (const thread of threads) {
        if (thread.connectionId) seenThreadsRef.current.add(notificationKey(thread));
      }
      saveSeenThreads(seenThreadsRef.current);
      seededRef.current = true;
      return;
    }

    let changed = false;
    const quiet = isQuietHours(settings);
    for (const thread of threads) {
      const connectionId = thread.connectionId;
      if (!connectionId) continue;
      const key = notificationKey(thread);
      if (seenThreadsRef.current.has(key)) continue;

      seenThreadsRef.current.add(key);
      changed = true;
      if (quiet || typeof Notification === 'undefined' || Notification.permission !== 'granted') {
        continue;
      }
      if (!shouldNotify(thread, settings)) continue;

      try {
        const notification = new Notification(thread.senderName || thread.senderEmail || 'New mail', {
          body: thread.subject || 'New message',
          tag: key,
        });
        notification.onclick = () => {
          window.focus();
          notification.close();
          const params = new URLSearchParams({
            threadId: thread.id,
            connectionId,
          });
          window.location.assign(`/mail/unified?${params}`);
        };
      } catch (error) {
        console.error('Failed to show new mail notification', error);
      }
    }
    if (changed) saveSeenThreads(seenThreadsRef.current);
  }, [settings, storageReady, threadsQuery.data, threadsQuery.dataUpdatedAt]);

  return null;
}
