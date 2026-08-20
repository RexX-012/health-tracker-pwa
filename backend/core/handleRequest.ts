import {
  BackendEnvironment,
  hasOpenAiConfiguration,
  hasPersonalAccessConfiguration,
} from './environment';
import { GoogleSheetsUsageError, googleSheetsUsageStore } from './googleSheetsUsage';
import {
  DailyRecordInput,
  getDateInTimeZone,
  GoogleSheetsDailyRecordsError,
  googleSheetsDailyRecordsStore,
  isValidTimeZone,
} from './googleSheetsDailyRecords';
import {
  analyseFoodWithOpenAi,
  FoodAnalysisInput,
  OpenAiFoodAnalysisError,
} from './openaiFoodAnalysis';

const HEALTH_PATH = '/health';
const ANALYSE_FOOD_PATH = '/analyze-food';
const AI_USAGE_PATH = '/ai-usage';
const DAILY_RECORD_PATH = '/daily-record';
const SETTINGS_PATH = '/settings';
const MAX_DESCRIPTION_LENGTH = 2_000;
const MAX_IMAGE_BASE64_LENGTH = 6_000_000;
const PERSONAL_ACCESS_TOKEN_HEADER = 'X-Health-Tracker-Access-Token';
const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
const PWA_ORIGIN = 'https://health-tracker-pwa.sthaaraman.workers.dev';

export async function handleRequest(
  request: Request,
  environment: BackendEnvironment = {},
): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders(request), status: 204 });
  }

  return withCors(request, await handleRequestInternal(request, environment));
}

async function handleRequestInternal(
  request: Request,
  environment: BackendEnvironment,
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === HEALTH_PATH) {
    if (request.method !== 'GET') {
      return json({ error: 'Method not allowed' }, 405, { Allow: 'GET' });
    }

    return json({ status: 'ok', service: 'health-tracker-api', version: '1.0.0' });
  }

  if (url.pathname === ANALYSE_FOOD_PATH) {
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
    }

    const accessError = requirePersonalAccess(request, environment);
    if (accessError) {
      return accessError;
    }

    const body = await parseJson(request);
    if (body instanceof Response) {
      return body;
    }

    const validationError = validateFoodAnalysisRequest(body);
    if (validationError) {
      return json({ error: validationError }, 400);
    }

    const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
    if (!idempotencyKey || idempotencyKey.length > 256) {
      return json({ error: 'A valid Idempotency-Key header is required.' }, 400);
    }

    if (!hasOpenAiConfiguration(environment)) {
      return json(
        {
          code: 'AI_NOT_CONFIGURED',
          error: 'Food analysis is not configured yet.',
        },
        503,
      );
    }

    let reservation;
    try {
      reservation = await googleSheetsUsageStore.reserveAnalysis(environment, idempotencyKey);
    } catch (error) {
      return usageUnavailableResponse(error);
    }

    if (reservation.state === 'completed' && reservation.cachedResult) {
      try {
        return json({
          analysis: JSON.parse(reservation.cachedResult),
          cached: true,
          usage: usageFromReservation(reservation),
        });
      } catch {
        return json({ code: 'AI_ANALYSIS_UNAVAILABLE', error: 'The saved food analysis is unavailable.' }, 503);
      }
    }
    if (reservation.state === 'limit_reached') {
      return json(
        {
          code: 'AI_DAILY_LIMIT_REACHED',
          error: 'You have reached today\'s limit of 10 AI food analyses. Try again tomorrow.',
          usage: usageFromReservation(reservation),
        },
        429,
      );
    }
    if (reservation.state === 'processing') {
      return json(
        {
          code: 'AI_ANALYSIS_IN_PROGRESS',
          error: 'This food analysis is already being processed. Please wait a moment before trying again.',
          usage: usageFromReservation(reservation),
        },
        409,
      );
    }
    if (reservation.state === 'failed') {
      return json(
        {
          code: 'AI_ANALYSIS_FAILED',
          error: 'This food analysis could not be completed. Start a new analysis to try again.',
          usage: usageFromReservation(reservation),
        },
        502,
      );
    }
    if (!reservation.accepted || !reservation.rowNumber) {
      return json({ code: 'AI_ANALYSIS_UNAVAILABLE', error: 'Food analysis is unavailable.' }, 503);
    }

    try {
      const analysis = await analyseFoodWithOpenAi(environment, toFoodAnalysisInput(body));
      await googleSheetsUsageStore.completeAnalysis(environment, reservation.rowNumber, analysis);
      return json({ analysis, cached: false, usage: usageAfterSuccessfulCompletion(reservation) });
    } catch (error) {
      try {
        await googleSheetsUsageStore.markAnalysisFailed(environment, reservation.rowNumber);
      } catch {
        // The reservation remains in progress rather than risking a duplicate paid request.
      }
      if (error instanceof GoogleSheetsUsageError) {
        return usageUnavailableResponse(error);
      }
      const message = error instanceof OpenAiFoodAnalysisError
        ? 'Food analysis could not be completed. Start a new analysis to try again.'
        : 'Food analysis is unavailable.';
      return json({ code: 'AI_ANALYSIS_FAILED', error: message, usage: usageFromReservation(reservation) }, 502);
    }
  }

  if (url.pathname === AI_USAGE_PATH) {
    if (request.method !== 'GET') {
      return json({ error: 'Method not allowed' }, 405, { Allow: 'GET' });
    }

    const accessError = requirePersonalAccess(request, environment);
    if (accessError) {
      return accessError;
    }

    try {
      return json(await googleSheetsUsageStore.getDailyUsage(environment));
    } catch (error) {
      return usageUnavailableResponse(error);
    }
  }

  if (url.pathname === SETTINGS_PATH) {
    const accessError = requirePersonalAccess(request, environment);
    if (accessError) {
      return accessError;
    }
    if (request.method === 'GET') {
      try {
        return json(await googleSheetsDailyRecordsStore.getSettings(environment));
      } catch (error) {
        return dailyRecordsUnavailableResponse(error);
      }
    }
    if (request.method === 'PUT') {
      const idempotencyError = requireIdempotencyKey(request);
      if (idempotencyError) {
        return idempotencyError;
      }
      const body = await parseJson(request);
      if (body instanceof Response) {
        return body;
      }
      if (!isRecord(body) || !isValidTimeZone(body.timezone)) {
        return json({ error: 'A valid IANA timezone is required.' }, 400);
      }
      try {
        return json(await googleSheetsDailyRecordsStore.setTimezone(environment, body.timezone));
      } catch (error) {
        return dailyRecordsUnavailableResponse(error);
      }
    }
    return json({ error: 'Method not allowed' }, 405, { Allow: 'GET, PUT' });
  }

  if (url.pathname === DAILY_RECORD_PATH) {
    const accessError = requirePersonalAccess(request, environment);
    if (accessError) {
      return accessError;
    }
    if (request.method === 'GET') {
      try {
        const settings = await googleSheetsDailyRecordsStore.getSettings(environment);
        const date = url.searchParams.get('date') ?? getDateInTimeZone(settings.timezone);
        if (!isDateString(date)) {
          return json({ error: 'A valid date is required.' }, 400);
        }
        return json({ record: await googleSheetsDailyRecordsStore.getDailyRecord(environment, date) });
      } catch (error) {
        return dailyRecordsUnavailableResponse(error);
      }
    }
    if (request.method === 'PUT') {
      const idempotencyError = requireIdempotencyKey(request);
      if (idempotencyError) {
        return idempotencyError;
      }
      const body = await parseJson(request);
      if (body instanceof Response) {
        return body;
      }
      const input = toDailyRecordInput(body);
      if (!input) {
        return json({ error: 'A valid date, IANA timezone, and data object are required.' }, 400);
      }
      try {
        return json({ record: await googleSheetsDailyRecordsStore.saveDailyRecord(environment, input) });
      } catch (error) {
        return dailyRecordsUnavailableResponse(error);
      }
    }
    return json({ error: 'Method not allowed' }, 405, { Allow: 'GET, PUT' });
  }

  return json({ error: 'Not found' }, 404);
}

function requirePersonalAccess(request: Request, environment: BackendEnvironment): Response | null {
  if (!hasPersonalAccessConfiguration(environment)) {
    return json(
      {
        code: 'PERSONAL_ACCESS_NOT_CONFIGURED',
        error: 'Personal access is not configured yet.',
      },
      503,
    );
  }

  if (request.headers.get(PERSONAL_ACCESS_TOKEN_HEADER) !== environment.APP_ACCESS_TOKEN) {
    return json(
      {
        code: 'PERSONAL_ACCESS_DENIED',
        error: 'This food analysis service is only available on the authorised device.',
      },
      401,
    );
  }

  return null;
}

async function parseJson(request: Request): Promise<unknown | Response> {
  try {
    return await request.json();
  } catch {
    return json({ error: 'A valid JSON request body is required.' }, 400);
  }
}

function validateFoodAnalysisRequest(body: unknown): string | null {
  if (!isRecord(body)) {
    return 'The request body must be an object.';
  }

  const description = body.description;
  const image = body.image;
  const hasDescription = typeof description === 'string' && description.trim().length > 0;
  const hasImage = isRecord(image) && typeof image.base64 === 'string' && image.base64.length > 0;

  if (!hasDescription && !hasImage) {
    return 'Provide a food description, an image, or both.';
  }
  if (typeof description === 'string' && description.length > MAX_DESCRIPTION_LENGTH) {
    return `Food descriptions must be ${MAX_DESCRIPTION_LENGTH} characters or fewer.`;
  }
  if (isRecord(image) && typeof image.base64 === 'string' && image.base64.length > 0) {
    if (image.base64.length > MAX_IMAGE_BASE64_LENGTH) {
      return 'The food image is too large.';
    }
    if (typeof image.mediaType !== 'string' || !image.mediaType.startsWith('image/')) {
      return 'The food image must include an image media type.';
    }
  }

  return null;
}

function toDailyRecordInput(body: unknown): DailyRecordInput | null {
  if (!isRecord(body) || !isDateString(body.date) || !isValidTimeZone(body.timezone) || !isRecord(body.data)) {
    return null;
  }
  return { data: body.data, date: body.date, timezone: body.timezone };
}

function requireIdempotencyKey(request: Request): Response | null {
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  return idempotencyKey && idempotencyKey.length <= 256
    ? null
    : json({ error: 'A valid Idempotency-Key header is required.' }, 400);
}

function isDateString(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function toFoodAnalysisInput(body: unknown): FoodAnalysisInput {
  const value = body as Record<string, unknown>;
  const image = isRecord(value.image) && typeof value.image.base64 === 'string' && typeof value.image.mediaType === 'string'
    ? { base64: value.image.base64, mediaType: value.image.mediaType }
    : undefined;
  return {
    description: typeof value.description === 'string' ? value.description.trim() : undefined,
    image,
  };
}

function usageFromReservation(reservation: {
  limit: number;
  remaining: number;
  used: number;
}) {
  return {
    limit: reservation.limit,
    remaining: reservation.remaining,
    used: reservation.used,
  };
}

function usageAfterSuccessfulCompletion(reservation: {
  limit: number;
  used: number;
}) {
  const used = reservation.used + 1;
  return {
    limit: reservation.limit,
    remaining: Math.max(reservation.limit - used, 0),
    used,
  };
}

function usageUnavailableResponse(error: unknown): Response {
  const message = error instanceof GoogleSheetsUsageError
    ? error.message
    : 'The AI usage counter is unavailable.';
  return json({ code: 'AI_USAGE_UNAVAILABLE', error: message }, 503);
}

function dailyRecordsUnavailableResponse(error: unknown): Response {
  const message = error instanceof GoogleSheetsDailyRecordsError
    ? error.message
    : 'Daily data storage is unavailable.';
  return json({ code: 'DAILY_DATA_UNAVAILABLE', error: message }, 503);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function json(body: unknown, status = 200, headers: HeadersInit = {}) {
  return Response.json(body, {
    headers: {
      'Cache-Control': 'no-store',
      ...headers,
    },
    status,
  });
}

function corsHeaders(request: Request): HeadersInit {
  if (request.headers.get('Origin') !== PWA_ORIGIN) {
    return {};
  }

  return {
    'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key, X-Health-Tracker-Access-Token',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Origin': PWA_ORIGIN,
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function withCors(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  const accessHeaders = corsHeaders(request);
  for (const [name, value] of Object.entries(accessHeaders)) {
    headers.set(name, value);
  }

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
