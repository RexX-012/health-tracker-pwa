import AsyncStorage from '@react-native-async-storage/async-storage';
import { requestWithFailover } from './backendClient';

const DAILY_DATA_STORAGE_KEY = 'health-tracker.daily-data.v1';
const DEFAULT_TIME_ZONE = 'Australia/Sydney';

export type DailyData = Record<string, unknown>;

export type StoredFoodEntry = {
  analysis: Record<string, unknown>;
  description: string | null;
  id: string;
  itchLevel: number | null;
  photoAttached: boolean;
  savedAt: string;
  spiceLevel: number;
};

export type PendingDailyRecord = {
  data: DailyData;
  date: string;
  syncId: string;
  timezone: string;
};

export type LocalDailyRecord = PendingDailyRecord & {
  pending: boolean;
};

export type DailyDataState = {
  records: Record<string, LocalDailyRecord>;
  timezone: string;
  timezoneSyncId: string | null;
};

export type DailyDataSyncResult = {
  pending: number;
  synced: number;
};

type SettingsResponse = { timezone: string };
type DailyRecordResponse = { record: unknown };

/**
 * Device-side source of truth for unsent health data. Every write is persisted
 * before networking begins, so a closed app or an offline connection cannot
 * discard a check-in. The backend receives idempotent snapshots when available.
 */
export class DailyDataStore {
  async load(): Promise<DailyDataState> {
    try {
      const stored = await AsyncStorage.getItem(DAILY_DATA_STORAGE_KEY);
      if (!stored) {
        return createInitialState();
      }
      return normaliseState(JSON.parse(stored) as unknown);
    } catch {
      return createInitialState();
    }
  }

  async savePatch(patch: DailyData): Promise<LocalDailyRecord> {
    const state = await this.load();
    const date = getDateInTimeZone(state.timezone);
    const existing = state.records[date];
    const record: LocalDailyRecord = {
      data: mergeData(existing?.data ?? {}, patch),
      date,
      pending: true,
      syncId: createSyncId(`record-${date}`),
      timezone: state.timezone,
    };
    state.records[date] = record;
    await this.persist(state);
    return record;
  }

  async setTimezone(timezone: string): Promise<DailyDataState> {
    if (!isValidTimeZone(timezone)) {
      throw new Error('Choose a valid timezone.');
    }
    const state = await this.load();
    state.timezone = timezone;
    state.timezoneSyncId = createSyncId('timezone');
    await this.persist(state);
    return state;
  }

  async appendFoodEntry(entry: StoredFoodEntry): Promise<LocalDailyRecord> {
    const state = await this.load();
    const date = getDateInTimeZone(state.timezone);
    const existingEntries = getFoodEntries(state.records[date]?.data.foodEntries);
    return this.savePatch({ foodEntries: [...existingEntries, entry] });
  }

  async setFoodEntryItchLevel(entryId: string, itchLevel: number): Promise<LocalDailyRecord> {
    const state = await this.load();
    for (const record of Object.values(state.records)) {
      const entries = getFoodEntries(record.data.foodEntries);
      const entryIndex = entries.findIndex((entry) => entry.id === entryId);
      if (entryIndex === -1) {
        continue;
      }

      const updatedEntries = entries.map((entry, index) => index === entryIndex ? { ...entry, itchLevel } : entry);
      const updatedRecord: LocalDailyRecord = {
        ...record,
        data: { ...record.data, foodEntries: updatedEntries },
        pending: true,
        syncId: createSyncId(`record-${record.date}`),
      };
      state.records[record.date] = updatedRecord;
      await this.persist(state);
      return updatedRecord;
    }
    throw new Error('Food entry not found.');
  }

  async sync(accessToken: string): Promise<DailyDataSyncResult> {
    const state = await this.load();
    let synced = 0;

    if (state.timezoneSyncId) {
      await requestWithFailover<SettingsResponse>('/settings', {
        body: { timezone: state.timezone },
        headers: { 'X-Health-Tracker-Access-Token': accessToken },
        idempotencyKey: state.timezoneSyncId,
        method: 'PUT',
      });
      const latest = await this.load();
      if (latest.timezoneSyncId === state.timezoneSyncId) {
        latest.timezoneSyncId = null;
        await this.persist(latest);
      }
    }

    for (const record of Object.values(state.records)
      .filter((record) => record.pending)
      .sort((left, right) => left.date.localeCompare(right.date))) {
      await requestWithFailover<DailyRecordResponse>('/daily-record', {
        body: { data: record.data, date: record.date, timezone: record.timezone },
        headers: { 'X-Health-Tracker-Access-Token': accessToken },
        idempotencyKey: record.syncId,
        method: 'PUT',
      });
      const latest = await this.load();
      if (latest.records[record.date]?.syncId === record.syncId) {
        latest.records[record.date] = { ...latest.records[record.date], pending: false };
        await this.persist(latest);
      }
      synced += 1;
    }

    return { pending: Object.values((await this.load()).records).filter((record) => record.pending).length, synced };
  }

  getTodayDate(state: DailyDataState): string {
    return getDateInTimeZone(state.timezone);
  }

  private async persist(state: DailyDataState): Promise<void> {
    await AsyncStorage.setItem(DAILY_DATA_STORAGE_KEY, JSON.stringify(state));
  }
}

export const dailyDataStore = new DailyDataStore();

export function getDateInTimeZone(timezone: string, date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: timezone,
    year: 'numeric',
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

export function getDeviceTimeZone(): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isValidTimeZone(timezone) ? timezone : DEFAULT_TIME_ZONE;
}

function createInitialState(): DailyDataState {
  return {
    records: {},
    timezone: getDeviceTimeZone(),
    timezoneSyncId: createSyncId('timezone'),
  };
}

function normaliseState(value: unknown): DailyDataState {
  if (!isRecord(value)) {
    return createInitialState();
  }
  const timezone = isValidTimeZone(value.timezone) ? value.timezone : getDeviceTimeZone();
  const rawRecords = isRecord(value.records) ? value.records : value.pendingRecords;
  const records = isRecord(rawRecords)
    ? Object.entries(rawRecords).reduce<Record<string, LocalDailyRecord>>((records, [date, record]) => {
      if (isPendingRecord(record) && record.date === date) {
        records[date] = {
          ...record,
          pending: (record as Record<string, unknown>).pending !== false,
        };
      }
      return records;
    }, {})
    : {};
  return {
    records,
    timezone,
    timezoneSyncId: typeof value.timezoneSyncId === 'string' ? value.timezoneSyncId : createSyncId('timezone'),
  };
}

function isPendingRecord(value: unknown): value is PendingDailyRecord {
  return isRecord(value)
    && isDateString(value.date)
    && isValidTimeZone(value.timezone)
    && typeof value.syncId === 'string'
    && isRecord(value.data);
}

function mergeData(existing: DailyData, patch: DailyData): DailyData {
  const merged: DailyData = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = isRecord(merged[key]) && isRecord(value)
      ? mergeData(merged[key], value)
      : value;
  }
  return merged;
}

function getFoodEntries(value: unknown): StoredFoodEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isStoredFoodEntry);
}

function isStoredFoodEntry(value: unknown): value is StoredFoodEntry {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.savedAt === 'string'
    && (typeof value.description === 'string' || value.description === null)
    && typeof value.photoAttached === 'boolean'
    && typeof value.spiceLevel === 'number'
    && (typeof value.itchLevel === 'number' || value.itchLevel === null)
    && isRecord(value.analysis);
}

function createSyncId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function isDateString(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
