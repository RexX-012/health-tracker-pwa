import {
  APP_SETTINGS_SHEET_NAME,
  BackendEnvironment,
  DAILY_RECORDS_SHEET_NAME,
  DEFAULT_TIME_ZONE,
  FOOD_ENTRIES_SHEET_NAME,
  hasGoogleSheetsConfiguration,
} from './environment';

const GOOGLE_SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const MAX_RECORD_DATA_LENGTH = 20_000;

type ServiceAccountCredentials = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

type StoredDailyRecord = {
  data: Record<string, unknown>;
  date: string;
  finalizedAt: string | null;
  lastUpdatedAt: string;
  rowNumber: number;
  status: 'active' | 'finalized';
  timezone: string;
};

type FoodEntry = {
  analysis: {
    calorieRange: { high: number; low: number };
    confidence: string;
    estimatedCalories: number;
    macronutrients?: {
      carbohydratesGrams: number;
      fatGrams: number;
      fibreGrams: number;
      proteinGrams: number;
    };
    mealStyle?: string;
    recommendations?: {
      balancedPairing: string;
      cuisineAlternative: string;
      flavorPairing: string;
      lighterOption: string;
      spicePairing: string;
    };
    mealIdeas?: Array<{
      foods: string[];
      reason: string;
      title: string;
    }>;
    summary: string;
  };
  description: string | null;
  id: string;
  itchLevel: number | null;
  photoAttached: boolean;
  savedAt: string;
  spiceLevel: number;
};

export type DailyRecord = Omit<StoredDailyRecord, 'rowNumber'>;

export type DailyRecordInput = {
  data: Record<string, unknown>;
  date: string;
  timezone: string;
};

export type AppSettings = {
  timezone: string;
  updatedAt: string | null;
};

export class GoogleSheetsDailyRecordsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleSheetsDailyRecordsError';
  }
}

/**
 * Stores an updatable daily snapshot rather than one append per UI interaction.
 * The shared spreadsheet is therefore both the durable record and the source
 * read by the Cloudflare scheduled finaliser.
 */
export class GoogleSheetsDailyRecordsStore {
  async getSettings(environment: BackendEnvironment): Promise<AppSettings> {
    const rows = await this.getSettingsRows(environment);
    const timezone = rows.find((row) => row.key === 'timezone');
    return {
      timezone: timezone?.value && isValidTimeZone(timezone.value) ? timezone.value : DEFAULT_TIME_ZONE,
      updatedAt: timezone?.updatedAt ?? null,
    };
  }

  async setTimezone(environment: BackendEnvironment, timezone: string): Promise<AppSettings> {
    if (!isValidTimeZone(timezone)) {
      throw new GoogleSheetsDailyRecordsError('The requested timezone is not valid.');
    }
    const now = new Date().toISOString();
    const rows = await this.getSettingsRows(environment);
    const existing = rows.find((row) => row.key === 'timezone');
    if (existing) {
      await this.updateRange(environment, APP_SETTINGS_SHEET_NAME, `B${existing.rowNumber}:C${existing.rowNumber}`, [[timezone, now]]);
    } else {
      await this.appendRows(environment, APP_SETTINGS_SHEET_NAME, [["timezone", timezone, now]]);
    }
    return { timezone, updatedAt: now };
  }

  async getDailyRecord(
    environment: BackendEnvironment,
    date: string,
  ): Promise<DailyRecord | null> {
    return toPublicDailyRecord((await this.getDailyRecords(environment)).find((record) => record.date === date) ?? null);
  }

  async saveDailyRecord(environment: BackendEnvironment, input: DailyRecordInput): Promise<DailyRecord> {
    if (!isDateString(input.date) || !isValidTimeZone(input.timezone)) {
      throw new GoogleSheetsDailyRecordsError('The daily record date or timezone is invalid.');
    }

    const data = ensureSerializableRecord(input.data);
    const records = await this.getDailyRecords(environment);
    const existing = records.find((record) => record.date === input.date);
    const lastUpdatedAt = new Date().toISOString();
    const mergedData = mergeRecords(existing?.data ?? {}, data);
    const serializedData = JSON.stringify(mergedData);

    if (existing) {
      // A late offline sync reopens a prior daily snapshot so the scheduler can
      // finalise the corrected version again without dropping that change.
      await this.updateRange(
        environment,
        DAILY_RECORDS_SHEET_NAME,
        `B${existing.rowNumber}:F${existing.rowNumber}`,
        [[input.timezone, 'active', lastUpdatedAt, '', serializedData]],
      );
      const record: DailyRecord = {
        data: mergedData,
        date: input.date,
        finalizedAt: null,
        lastUpdatedAt,
        status: 'active',
        timezone: input.timezone,
      };
      await this.upsertFoodEntries(environment, input.date, input.timezone, mergedData);
      return record;
    }

    await this.appendRows(environment, DAILY_RECORDS_SHEET_NAME, [[
      input.date,
      input.timezone,
      'active',
      lastUpdatedAt,
      '',
      serializedData,
    ]]);
    const record: DailyRecord = {
      data: mergedData,
      date: input.date,
      finalizedAt: null,
      lastUpdatedAt,
      status: 'active',
      timezone: input.timezone,
    };
    await this.upsertFoodEntries(environment, input.date, input.timezone, mergedData);
    return record;
  }

  async finalizeDueRecords(environment: BackendEnvironment, scheduledTime = Date.now()): Promise<number> {
    const records = await this.getDailyRecords(environment);
    let finalized = 0;
    for (const record of records) {
      if (record.status !== 'active' || record.date >= getDateInTimeZone(record.timezone, scheduledTime)) {
        continue;
      }
      const finalizedAt = new Date(scheduledTime).toISOString();
      await this.updateRange(
        environment,
        DAILY_RECORDS_SHEET_NAME,
        `C${record.rowNumber}:E${record.rowNumber}`,
        [['finalized', record.lastUpdatedAt, finalizedAt]],
      );
      finalized += 1;
    }
    return finalized;
  }

  private async getDailyRecords(environment: BackendEnvironment): Promise<StoredDailyRecord[]> {
    const values = await this.getSheetValues(
      environment,
      DAILY_RECORDS_SHEET_NAME,
      'A:F',
      ['Date', 'Timezone', 'Status', 'Last updated (UTC)', 'Finalized at (UTC)', 'Data (JSON)'],
    );
    return values.reduce<StoredDailyRecord[]>((records, row, index) => {
      const [date, timezone, status, lastUpdatedAt, finalizedAt, data] = row;
      if (!isDateString(date) || typeof timezone !== 'string' || !isValidTimeZone(timezone)) {
        return records;
      }
      records.push({
        data: parseStoredData(data),
        date,
        finalizedAt: typeof finalizedAt === 'string' && finalizedAt ? finalizedAt : null,
        lastUpdatedAt: typeof lastUpdatedAt === 'string' ? lastUpdatedAt : '',
        rowNumber: index + 1,
        status: status === 'finalized' ? 'finalized' : 'active',
        timezone,
      });
      return records;
    }, []);
  }

  private async getSettingsRows(environment: BackendEnvironment): Promise<Array<{ key: string; rowNumber: number; updatedAt: string | null; value: string }>> {
    const values = await this.getSheetValues(
      environment,
      APP_SETTINGS_SHEET_NAME,
      'A:C',
      ['Setting', 'Value', 'Last updated (UTC)'],
    );
    return values.reduce<Array<{ key: string; rowNumber: number; updatedAt: string | null; value: string }>>((rows, row, index) => {
      if (typeof row[0] === 'string' && typeof row[1] === 'string' && row[0] !== 'Setting') {
        rows.push({
          key: row[0],
          rowNumber: index + 1,
          updatedAt: typeof row[2] === 'string' ? row[2] : null,
          value: row[1],
        });
      }
      return rows;
    }, []);
  }

  private async upsertFoodEntries(
    environment: BackendEnvironment,
    date: string,
    timezone: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const entries = getFoodEntries(data.foodEntries);
    if (entries.length === 0) {
      return;
    }
    const existingRows = await this.getFoodEntryRows(environment);
    const rowsByEntryId = new Map(existingRows.map((row) => [row.id, row.rowNumber]));
    for (const entry of entries) {
      const values = toFoodEntryRow(entry, date, timezone);
      const rowNumber = rowsByEntryId.get(entry.id);
      if (rowNumber) {
        await this.updateRange(environment, FOOD_ENTRIES_SHEET_NAME, `B${rowNumber}:W${rowNumber}`, [values.slice(1)]);
      } else {
        await this.appendRows(environment, FOOD_ENTRIES_SHEET_NAME, [values]);
      }
    }
  }

  private async getFoodEntryRows(environment: BackendEnvironment): Promise<Array<{ id: string; rowNumber: number }>> {
    const headers = [
      'Entry ID',
      'Date',
      'Timezone',
      'Saved at (UTC)',
      'Description',
      'Photo attached',
      'Calories (kcal)',
      'Calorie range (kcal)',
      'Confidence',
      'Spice level',
      'Itch level',
      'Meal style',
      'Protein (g)',
      'Carbs (g)',
      'Fat (g)',
      'Fibre (g)',
      'Flavour suggestion',
      'Spice suggestion',
      'Cuisine alternative',
      'Balanced pairing',
      'Lighter option',
      'Complete meal ideas',
      'AI summary',
    ];
    const values = await this.getSheetValues(
      environment,
      FOOD_ENTRIES_SHEET_NAME,
      'A:W',
      headers,
    );
    if (values.length > 0) {
      await this.updateRange(environment, FOOD_ENTRIES_SHEET_NAME, 'A1:W1', [headers]);
    }
    return values.reduce<Array<{ id: string; rowNumber: number }>>((rows, row, index) => {
      if (typeof row[0] === 'string' && row[0] !== 'Entry ID') {
        rows.push({ id: row[0], rowNumber: index + 1 });
      }
      return rows;
    }, []);
  }

  private async getSheetValues(
    environment: BackendEnvironment,
    sheetName: string,
    columns: string,
    headers: string[],
  ): Promise<unknown[][]> {
    const accessToken = await getGoogleAccessToken(environment);
    const range = `'${sheetName}'!${columns}`;
    const response = await fetch(
      `${GOOGLE_SHEETS_API_BASE}/${encodeURIComponent(requireSheetId(environment))}/values/${encodeURIComponent(range)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (response.ok) {
      return ((await response.json()) as { values?: unknown[][] }).values ?? [];
    }

    const error = await readGoogleError(response);
    if (!isMissingSheetError(error)) {
      throw new GoogleSheetsDailyRecordsError(error);
    }
    await this.createSheet(environment, sheetName, accessToken);
    await this.appendRows(environment, sheetName, [headers]);
    return [];
  }

  private async createSheet(environment: BackendEnvironment, sheetName: string, accessToken: string): Promise<void> {
    const response = await fetch(`${GOOGLE_SHEETS_API_BASE}/${encodeURIComponent(requireSheetId(environment))}:batchUpdate`, {
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: sheetName } } }] }),
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      method: 'POST',
    });
    if (!response.ok) {
      const error = await readGoogleError(response);
      if (!error.toLowerCase().includes('already exists')) {
        throw new GoogleSheetsDailyRecordsError(error);
      }
    }
  }

  private async appendRows(environment: BackendEnvironment, sheetName: string, values: string[][]): Promise<void> {
    const accessToken = await getGoogleAccessToken(environment);
    const range = `'${sheetName}'!A:Z`;
    const response = await fetch(
      `${GOOGLE_SHEETS_API_BASE}/${encodeURIComponent(requireSheetId(environment))}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      {
        body: JSON.stringify({ values }),
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );
    if (!response.ok) {
      throw new GoogleSheetsDailyRecordsError(await readGoogleError(response));
    }
  }

  private async updateRange(environment: BackendEnvironment, sheetName: string, cells: string, values: string[][]): Promise<void> {
    const accessToken = await getGoogleAccessToken(environment);
    const range = `'${sheetName}'!${cells}`;
    const response = await fetch(
      `${GOOGLE_SHEETS_API_BASE}/${encodeURIComponent(requireSheetId(environment))}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
      {
        body: JSON.stringify({ values }),
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        method: 'PUT',
      },
    );
    if (!response.ok) {
      throw new GoogleSheetsDailyRecordsError(await readGoogleError(response));
    }
  }
}

export const googleSheetsDailyRecordsStore = new GoogleSheetsDailyRecordsStore();

export function getDateInTimeZone(timezone: string, timestamp = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: timezone,
    year: 'numeric',
  }).formatToParts(new Date(timestamp));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

export function isValidTimeZone(timezone: unknown): timezone is string {
  if (typeof timezone !== 'string' || timezone.length > 100) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function ensureSerializableRecord(value: Record<string, unknown>): Record<string, unknown> {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new GoogleSheetsDailyRecordsError('The daily record contains unsupported data.');
  }
  if (!serialized || serialized.length > MAX_RECORD_DATA_LENGTH) {
    throw new GoogleSheetsDailyRecordsError('The daily record is too large.');
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

function mergeRecords(existing: Record<string, unknown>, update: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(update)) {
    result[key] = isRecord(result[key]) && isRecord(value)
      ? mergeRecords(result[key], value)
      : value;
  }
  return result;
}

function getFoodEntries(value: unknown): FoodEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isFoodEntry);
}

function isFoodEntry(value: unknown): value is FoodEntry {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || value.id.length === 0
    || value.id.length > 256
    || typeof value.savedAt !== 'string'
    || (typeof value.description !== 'string' && value.description !== null)
    || typeof value.photoAttached !== 'boolean'
    || !isWholeNumberInRange(value.spiceLevel, 0, 10)
    || (value.itchLevel !== null && !isWholeNumberInRange(value.itchLevel, 0, 10))
    || !isRecord(value.analysis)) {
    return false;
  }
  const analysis = value.analysis;
  return isFiniteNumber(analysis.estimatedCalories)
    && isRecord(analysis.calorieRange)
    && isFiniteNumber(analysis.calorieRange.low)
    && isFiniteNumber(analysis.calorieRange.high)
    && typeof analysis.confidence === 'string'
    && typeof analysis.summary === 'string';
}

function toFoodEntryRow(entry: FoodEntry, date: string, timezone: string): string[] {
  return [
    entry.id,
    date,
    timezone,
    entry.savedAt,
    entry.description ?? '',
    entry.photoAttached ? 'Yes' : 'No',
    String(entry.analysis.estimatedCalories),
    `${entry.analysis.calorieRange.low}–${entry.analysis.calorieRange.high}`,
    entry.analysis.confidence,
    String(entry.spiceLevel),
    entry.itchLevel === null ? '' : String(entry.itchLevel),
    entry.analysis.mealStyle ?? '',
    entry.analysis.macronutrients ? String(entry.analysis.macronutrients.proteinGrams) : '',
    entry.analysis.macronutrients ? String(entry.analysis.macronutrients.carbohydratesGrams) : '',
    entry.analysis.macronutrients ? String(entry.analysis.macronutrients.fatGrams) : '',
    entry.analysis.macronutrients ? String(entry.analysis.macronutrients.fibreGrams) : '',
    entry.analysis.recommendations?.flavorPairing ?? '',
    entry.analysis.recommendations?.spicePairing ?? '',
    entry.analysis.recommendations?.cuisineAlternative ?? '',
    entry.analysis.recommendations?.balancedPairing ?? '',
    entry.analysis.recommendations?.lighterOption ?? '',
    entry.analysis.mealIdeas?.map((idea) => `${idea.title}: ${idea.foods.join(', ')} — ${idea.reason}`).join(' | ') ?? '',
    entry.analysis.summary,
  ];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isWholeNumberInRange(value: unknown, lower: number, upper: number): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= lower && value <= upper;
}

function parseStoredData(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toPublicDailyRecord(record: StoredDailyRecord | null): DailyRecord | null {
  if (!record) {
    return null;
  }
  const { rowNumber: _rowNumber, ...publicRecord } = record;
  return publicRecord;
}

function isDateString(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function getGoogleAccessToken(environment: BackendEnvironment): Promise<string> {
  if (!hasGoogleSheetsConfiguration(environment)) {
    throw new GoogleSheetsDailyRecordsError('Google Sheets daily-record storage is not configured.');
  }
  const credentials = parseServiceAccountCredentials(environment.GOOGLE_SERVICE_ACCOUNT_JSON!);
  const issuedAt = Math.floor(Date.now() / 1_000);
  const assertion = await createGoogleAssertion(credentials, issuedAt);
  const response = await fetch(credentials.token_uri ?? 'https://oauth2.googleapis.com/token', {
    body: new URLSearchParams({
      assertion,
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    method: 'POST',
  });
  if (!response.ok) {
    throw new GoogleSheetsDailyRecordsError(await readGoogleError(response));
  }
  const payload = (await response.json()) as { access_token?: unknown };
  if (typeof payload.access_token !== 'string') {
    throw new GoogleSheetsDailyRecordsError('Google did not return an access token.');
  }
  return payload.access_token;
}

async function createGoogleAssertion(credentials: ServiceAccountCredentials, issuedAt: number): Promise<string> {
  const encoder = new TextEncoder();
  const header = toBase64Url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claimSet = toBase64Url(encoder.encode(JSON.stringify({
    aud: credentials.token_uri ?? 'https://oauth2.googleapis.com/token',
    exp: issuedAt + 3_600,
    iat: issuedAt,
    iss: credentials.client_email,
    scope: GOOGLE_SHEETS_SCOPE,
  })));
  const unsignedToken = `${header}.${claimSet}`;
  const signingKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(credentials.private_key),
    { hash: 'SHA-256', name: 'RSASSA-PKCS1-v1_5' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKey, encoder.encode(unsignedToken));
  return `${unsignedToken}.${toBase64Url(new Uint8Array(signature))}`;
}

function parseServiceAccountCredentials(value: string): ServiceAccountCredentials {
  try {
    const parsed = JSON.parse(value) as Partial<ServiceAccountCredentials>;
    if (typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string') {
      throw new Error('Missing service-account credentials');
    }
    return parsed as ServiceAccountCredentials;
  } catch {
    throw new GoogleSheetsDailyRecordsError('The Google service-account secret is invalid.');
  }
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const binary = atob(pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s/g, ''));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}

function toBase64Url(data: Uint8Array): string {
  let binary = '';
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function requireSheetId(environment: BackendEnvironment): string {
  if (!environment.GOOGLE_SHEET_ID) {
    throw new GoogleSheetsDailyRecordsError('The Google Sheet ID is not configured.');
  }
  return environment.GOOGLE_SHEET_ID;
}

async function readGoogleError(response: Response): Promise<string> {
  return (await response.text()) || `Google Sheets request failed with HTTP ${response.status}.`;
}

function isMissingSheetError(error: string): boolean {
  const normalised = error.toLowerCase();
  return normalised.includes('unable to parse range') || normalised.includes('range not found');
}
