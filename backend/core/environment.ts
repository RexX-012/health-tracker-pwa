export type BackendEnvironment = {
  APP_ACCESS_TOKEN?: string;
  AI_USAGE_RESET_AT?: string;
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_SHEET_ID?: string;
  OPENAI_API_KEY?: string;
};

export const requiredSecretNames = [
  'APP_ACCESS_TOKEN',
  'OPENAI_API_KEY',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'GOOGLE_SHEET_ID',
] as const;

export const MAX_DAILY_AI_ANALYSES = 10;
export const AI_USAGE_SHEET_NAME = 'AI usage';
export const APP_SETTINGS_SHEET_NAME = 'App settings';
export const DAILY_RECORDS_SHEET_NAME = 'Daily records';
export const FOOD_ENTRIES_SHEET_NAME = 'Food entries';
export const DEFAULT_TIME_ZONE = 'Australia/Sydney';

export function hasOpenAiConfiguration(environment: BackendEnvironment) {
  return Boolean(environment.OPENAI_API_KEY);
}

export function hasPersonalAccessConfiguration(environment: BackendEnvironment) {
  return Boolean(environment.APP_ACCESS_TOKEN);
}

export function hasGoogleSheetsConfiguration(environment: BackendEnvironment) {
  return Boolean(environment.GOOGLE_SERVICE_ACCOUNT_JSON && environment.GOOGLE_SHEET_ID);
}
