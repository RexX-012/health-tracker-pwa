import {
  AI_USAGE_SHEET_NAME,
  BackendEnvironment,
  hasGoogleSheetsConfiguration,
  MAX_DAILY_AI_ANALYSES,
} from './environment';

const GOOGLE_SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

type ServiceAccountCredentials = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

type UsageRow = {
  createdAt?: string;
  date: string;
  idempotencyKey: string;
  result?: string;
  rowNumber: number;
  status: 'completed' | 'failed' | 'processing';
};

export type DailyAiUsage = {
  limit: number;
  remaining: number;
  used: number;
};

export type AiUsageReservation = DailyAiUsage & {
  accepted: boolean;
  cachedResult?: string;
  rowNumber?: number;
  state: 'completed' | 'failed' | 'limit_reached' | 'processing' | 'reserved';
};

export class GoogleSheetsUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleSheetsUsageError';
  }
}

/**
 * A small shared counter for the active/passive backends. It is intentionally
 * kept in Google Sheets so both providers see the same personal daily limit.
 */
export class GoogleSheetsUsageStore {
  async getDailyUsage(environment: BackendEnvironment, date = getSydneyDate()): Promise<DailyAiUsage> {
    const rows = await this.getUsageRows(environment);
    const used = countCompletedAnalyses(rows, date, getActiveUsageResetAt(environment, date));
    return buildDailyUsage(used);
  }

  async reserveAnalysis(
    environment: BackendEnvironment,
    idempotencyKey: string,
    date = getSydneyDate(),
  ): Promise<AiUsageReservation> {
    const rows = await this.getUsageRows(environment);
    const alreadyRecorded = rows.find((row) => row.idempotencyKey === idempotencyKey);
    const used = countCompletedAnalyses(rows, date, getActiveUsageResetAt(environment, date));

    if (alreadyRecorded) {
      if (alreadyRecorded.status === 'completed' && alreadyRecorded.result) {
        return {
          accepted: true,
          cachedResult: alreadyRecorded.result,
          state: 'completed',
          ...buildDailyUsage(used),
        };
      }
      return {
        accepted: false,
        state: alreadyRecorded.status,
        ...buildDailyUsage(used),
      };
    }
    if (used >= MAX_DAILY_AI_ANALYSES) {
      return { accepted: false, state: 'limit_reached', ...buildDailyUsage(used) };
    }

    const rowNumber = await this.appendUsageRow(environment, [
      date,
      idempotencyKey,
      new Date().toISOString(),
      'processing',
      '',
    ]);
    return { accepted: true, rowNumber, state: 'reserved', ...buildDailyUsage(used) };
  }

  async completeAnalysis(
    environment: BackendEnvironment,
    rowNumber: number,
    analysis: unknown,
  ): Promise<void> {
    await this.updateUsageRow(environment, rowNumber, 'completed', JSON.stringify(analysis));
  }

  async markAnalysisFailed(environment: BackendEnvironment, rowNumber: number): Promise<void> {
    await this.updateUsageRow(environment, rowNumber, 'failed', 'AI_ANALYSIS_FAILED');
  }

  private async getUsageRows(environment: BackendEnvironment): Promise<UsageRow[]> {
    const accessToken = await getGoogleAccessToken(environment);
    const range = `'${AI_USAGE_SHEET_NAME}'!A:E`;
    const response = await fetch(
      `${GOOGLE_SHEETS_API_BASE}/${encodeURIComponent(requireSheetId(environment))}/values/${encodeURIComponent(range)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (!response.ok) {
      const error = await readGoogleError(response);
      if (!isMissingUsageSheetError(error)) {
        throw new GoogleSheetsUsageError(error);
      }

      await this.createUsageSheet(environment, accessToken);
      return [];
    }

    const payload = (await response.json()) as { values?: unknown[][] };
    return (payload.values ?? []).reduce<UsageRow[]>((rows, value, index) => {
      const [date, idempotencyKey, createdAt, status, result] = value;
      if (typeof date === 'string' && typeof idempotencyKey === 'string') {
        rows.push({
          createdAt: typeof createdAt === 'string' ? createdAt : undefined,
          date,
          idempotencyKey,
          result: typeof result === 'string' ? result : undefined,
          rowNumber: index + 1,
          status: normaliseUsageStatus(status),
        });
      }
      return rows;
    }, []);
  }

  private async createUsageSheet(environment: BackendEnvironment, accessToken: string): Promise<void> {
    const response = await fetch(`${GOOGLE_SHEETS_API_BASE}/${encodeURIComponent(requireSheetId(environment))}:batchUpdate`, {
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: AI_USAGE_SHEET_NAME } } }] }),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });

    if (!response.ok) {
      const error = await readGoogleError(response);
      if (!error.toLowerCase().includes('already exists')) {
        throw new GoogleSheetsUsageError(error);
      }
    }
  }

  private async appendUsageRow(environment: BackendEnvironment, values: string[]): Promise<number> {
    const accessToken = await getGoogleAccessToken(environment);
    const range = `'${AI_USAGE_SHEET_NAME}'!A:E`;
    const response = await fetch(
      `${GOOGLE_SHEETS_API_BASE}/${encodeURIComponent(requireSheetId(environment))}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      {
        body: JSON.stringify({ values: [values] }),
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      },
    );

    if (!response.ok) {
      throw new GoogleSheetsUsageError(await readGoogleError(response));
    }

    const payload = (await response.json()) as { updates?: { updatedRange?: unknown } };
    const rowNumber = parseUpdatedRowNumber(payload.updates?.updatedRange);
    if (!rowNumber) {
      throw new GoogleSheetsUsageError('Google Sheets did not confirm the reserved AI usage row.');
    }
    return rowNumber;
  }

  private async updateUsageRow(
    environment: BackendEnvironment,
    rowNumber: number,
    status: 'completed' | 'failed',
    result: string,
  ): Promise<void> {
    const accessToken = await getGoogleAccessToken(environment);
    const range = `'${AI_USAGE_SHEET_NAME}'!D${rowNumber}:E${rowNumber}`;
    const response = await fetch(
      `${GOOGLE_SHEETS_API_BASE}/${encodeURIComponent(requireSheetId(environment))}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
      {
        body: JSON.stringify({ values: [[status, result]] }),
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        method: 'PUT',
      },
    );

    if (!response.ok) {
      throw new GoogleSheetsUsageError(await readGoogleError(response));
    }
  }
}

export const googleSheetsUsageStore = new GoogleSheetsUsageStore();

function buildDailyUsage(used: number): DailyAiUsage {
  return {
    limit: MAX_DAILY_AI_ANALYSES,
    remaining: Math.max(MAX_DAILY_AI_ANALYSES - used, 0),
    used,
  };
}

function countCompletedAnalyses(rows: UsageRow[], date: string, resetAt: number | null): number {
  return rows.filter((row) => row.date === date
    && row.status === 'completed'
    && (resetAt === null || wasCreatedOnOrAfter(row.createdAt, resetAt))).length;
}

function normaliseUsageStatus(value: unknown): UsageRow['status'] {
  return value === 'completed' || value === 'failed' || value === 'processing'
    ? value
    : 'processing';
}

function parseUpdatedRowNumber(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = value.match(/![A-Z]+(\d+):[A-Z]+\d+$/);
  if (!match) {
    return null;
  }
  const rowNumber = Number(match[1]);
  return Number.isSafeInteger(rowNumber) && rowNumber > 0 ? rowNumber : null;
}

function getSydneyDate(value = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-AU', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Australia/Sydney',
    year: 'numeric',
  }).formatToParts(value);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function getActiveUsageResetAt(environment: BackendEnvironment, date: string): number | null {
  const value = environment.AI_USAGE_RESET_AT;
  if (!value) {
    return null;
  }

  const resetAt = Date.parse(value);
  if (!Number.isFinite(resetAt) || getSydneyDate(new Date(resetAt)) !== date) {
    return null;
  }
  return resetAt;
}

function wasCreatedOnOrAfter(createdAt: string | undefined, resetAt: number): boolean {
  if (!createdAt) {
    return false;
  }
  const createdAtTimestamp = Date.parse(createdAt);
  return Number.isFinite(createdAtTimestamp) && createdAtTimestamp >= resetAt;
}

async function getGoogleAccessToken(environment: BackendEnvironment): Promise<string> {
  if (!hasGoogleSheetsConfiguration(environment)) {
    throw new GoogleSheetsUsageError('Google Sheets usage tracking is not configured.');
  }

  const credentials = parseServiceAccountCredentials(environment.GOOGLE_SERVICE_ACCOUNT_JSON!);
  const issuedAt = Math.floor(Date.now() / 1_000);
  const assertion = await createGoogleAssertion(credentials, issuedAt);
  const tokenResponse = await fetch(credentials.token_uri ?? 'https://oauth2.googleapis.com/token', {
    body: new URLSearchParams({
      assertion,
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    method: 'POST',
  });

  if (!tokenResponse.ok) {
    throw new GoogleSheetsUsageError(await readGoogleError(tokenResponse));
  }

  const tokenPayload = (await tokenResponse.json()) as { access_token?: unknown };
  if (typeof tokenPayload.access_token !== 'string') {
    throw new GoogleSheetsUsageError('Google did not return an access token.');
  }
  return tokenPayload.access_token;
}

async function createGoogleAssertion(credentials: ServiceAccountCredentials, issuedAt: number): Promise<string> {
  const encoder = new TextEncoder();
  const header = toBase64Url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claimSet = toBase64Url(
    encoder.encode(
      JSON.stringify({
        aud: credentials.token_uri ?? 'https://oauth2.googleapis.com/token',
        exp: issuedAt + 3_600,
        iat: issuedAt,
        iss: credentials.client_email,
        scope: GOOGLE_SHEETS_SCOPE,
      }),
    ),
  );
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
      throw new Error('missing service-account credentials');
    }
    return parsed as ServiceAccountCredentials;
  } catch {
    throw new GoogleSheetsUsageError('The Google service-account secret is invalid.');
  }
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const encoded = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s/g, '');
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return bytes.buffer;
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
    throw new GoogleSheetsUsageError('The Google Sheet ID is not configured.');
  }
  return environment.GOOGLE_SHEET_ID;
}

async function readGoogleError(response: Response): Promise<string> {
  const text = await response.text();
  return text || `Google Sheets request failed with HTTP ${response.status}.`;
}

function isMissingUsageSheetError(error: string): boolean {
  const normalisedError = error.toLowerCase();
  return normalisedError.includes('unable to parse range') || normalisedError.includes('range not found');
}
