import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

const HYDRATION_NOTIFICATION_IDS_KEY = 'health-tracker.hydration-notification-ids.v2';
const LEGACY_HYDRATION_NOTIFICATION_ID_KEY = 'health-tracker.hydration-notification-id.v1';
const HYDRATION_GOAL_LITRES = 3;
const REMINDER_END_HOUR = 21;
const REMINDER_START_HOUR = 9;
const REMINDER_HOUR = 21;

type ZonedDateParts = {
  day: number;
  month: number;
  year: number;
};

export type HydrationNotificationResult = 'permission-denied' | 'scheduled-complete' | 'scheduled-reminders' | 'unsupported';

export async function scheduleHydrationReminder(
  litres: number,
  timezone: string,
): Promise<HydrationNotificationResult> {
  if (Platform.OS === 'web') {
    return 'unsupported';
  }

  const currentPermissions = await Notifications.getPermissionsAsync();
  const permissions = currentPermissions.granted ? currentPermissions : await Notifications.requestPermissionsAsync();
  if (!permissions.granted) {
    return 'permission-denied';
  }

  await cancelHydrationNotifications();

  const remaining = Math.max(HYDRATION_GOAL_LITRES - litres, 0);
  const complete = remaining === 0;
  const identifiers = [await Notifications.scheduleNotificationAsync({
    content: {
      body: complete
        ? `Congratulations — you logged ${formatLitres(litres)} today and completed your 3 L hydration goal.`
        : `You have ${formatLitres(remaining)} left to reach your 3 L hydration goal today.`,
      data: { complete, kind: 'daily-hydration-check' },
      sound: 'default',
      title: complete ? 'Congratulations!' : 'Water reminder',
    },
    trigger: {
      date: getNextReminderDate(timezone),
      type: Notifications.SchedulableTriggerInputTypes.DATE,
    },
  })];

  if (!complete) {
    const hourlyDates = getHourlyReminderDates(timezone);
    const hourlyIdentifiers = await Promise.all(hourlyDates.map((date) => Notifications.scheduleNotificationAsync({
      content: {
        body: `You have ${formatLitres(remaining)} left to reach your 3 L hydration goal today.`,
        data: { kind: 'hourly-hydration-reminder' },
        sound: 'default',
        title: 'Time for some water',
      },
      trigger: {
        date,
        type: Notifications.SchedulableTriggerInputTypes.DATE,
      },
    })));
    identifiers.push(...hourlyIdentifiers);
  }

  await AsyncStorage.setItem(HYDRATION_NOTIFICATION_IDS_KEY, JSON.stringify(identifiers));
  return complete ? 'scheduled-complete' : 'scheduled-reminders';
}

async function cancelHydrationNotifications(): Promise<void> {
  const [legacyId, storedIdentifiers] = await Promise.all([
    AsyncStorage.getItem(LEGACY_HYDRATION_NOTIFICATION_ID_KEY),
    AsyncStorage.getItem(HYDRATION_NOTIFICATION_IDS_KEY),
  ]);
  const identifiers = [legacyId, ...readNotificationIdentifiers(storedIdentifiers)].filter((identifier): identifier is string => Boolean(identifier));
  await Promise.all(identifiers.map((identifier) => Notifications.cancelScheduledNotificationAsync(identifier).catch(() => undefined)));
  await Promise.all([
    AsyncStorage.removeItem(LEGACY_HYDRATION_NOTIFICATION_ID_KEY),
    AsyncStorage.removeItem(HYDRATION_NOTIFICATION_IDS_KEY),
  ]);
}

function readNotificationIdentifiers(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((identifier): identifier is string => typeof identifier === 'string') : [];
  } catch {
    return [];
  }
}

function getNextReminderDate(timezone: string): Date {
  const now = new Date();
  const today = getZonedDateParts(now, timezone);
  let reminder = zonedDateTimeToDate(today, REMINDER_HOUR, 0, timezone);
  if (reminder.getTime() <= now.getTime()) {
    reminder = zonedDateTimeToDate(addOneDay(today), REMINDER_HOUR, 0, timezone);
  }
  return reminder;
}

function getHourlyReminderDates(timezone: string): Date[] {
  const now = new Date();
  const today = getZonedDateParts(now, timezone);
  const dates: Date[] = [];
  for (let hour = REMINDER_START_HOUR; hour < REMINDER_END_HOUR; hour += 1) {
    const reminder = zonedDateTimeToDate(today, hour, 0, timezone);
    if (reminder.getTime() > now.getTime()) {
      dates.push(reminder);
    }
  }
  return dates;
}

function getZonedDateParts(date: Date, timezone: string): ZonedDateParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: timezone,
    year: 'numeric',
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { day: Number(byType.day), month: Number(byType.month), year: Number(byType.year) };
}

function zonedDateTimeToDate(date: ZonedDateParts, hour: number, minute: number, timezone: string): Date {
  const asUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute, 0);
  let timestamp = asUtc - getTimeZoneOffset(new Date(asUtc), timezone);
  timestamp = asUtc - getTimeZoneOffset(new Date(timestamp), timezone);
  return new Date(timestamp);
}

function getTimeZoneOffset(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone: timezone,
    year: 'numeric',
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const localTimestamp = Date.UTC(
    Number(byType.year),
    Number(byType.month) - 1,
    Number(byType.day),
    Number(byType.hour),
    Number(byType.minute),
    Number(byType.second),
  );
  return localTimestamp - date.getTime();
}

function addOneDay(date: ZonedDateParts): ZonedDateParts {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  return { day: next.getUTCDate(), month: next.getUTCMonth() + 1, year: next.getUTCFullYear() };
}

function formatLitres(litres: number): string {
  return `${litres.toFixed(litres % 1 === 0 ? 0 : 1)} L`;
}
