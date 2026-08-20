import { backendOrder, BackendProvider, backendUrls } from '../config/backend';

const DEFAULT_TIMEOUT_MS = 8_000;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export type BackendRequest = {
  body?: unknown;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  timeoutMs?: number;
};

export type BackendResponse<T> = {
  data: T;
  provider: BackendProvider;
  status: number;
};

export class BackendRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'BackendRequestError';
  }
}

export class BackendUnavailableError extends Error {
  constructor(public readonly failures: string[]) {
    super('Both backend services are unavailable. Please try again shortly.');
    this.name = 'BackendUnavailableError';
  }
}

export async function requestWithFailover<T>(
  path: string,
  { body, headers = {}, idempotencyKey, method = 'GET', timeoutMs = DEFAULT_TIMEOUT_MS }: BackendRequest = {},
): Promise<BackendResponse<T>> {
  if (WRITE_METHODS.has(method) && !idempotencyKey) {
    throw new Error('Mutating requests require an idempotency key.');
  }

  const availableProviders = backendOrder.filter((provider) => backendUrls[provider]);
  if (availableProviders.length === 0) {
    throw new Error('No backend URLs are configured.');
  }

  const failures: string[] = [];

  for (const provider of availableProviders) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const requestHeaders: Record<string, string> = { Accept: 'application/json', ...headers };

    if (body !== undefined) {
      requestHeaders['Content-Type'] = 'application/json';
    }
    if (idempotencyKey) {
      requestHeaders['Idempotency-Key'] = idempotencyKey;
    }

    try {
      const response = await fetch(`${backendUrls[provider]}${path.startsWith('/') ? path : `/${path}`}`, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: requestHeaders,
        method,
        signal: controller.signal,
      });

      if (response.ok) {
        return { data: (await response.json()) as T, provider, status: response.status };
      }

      const message = await response.text();
      if (response.status >= 400 && response.status < 500) {
        throw new BackendRequestError(message || 'The request could not be completed.', response.status);
      }

      failures.push(`${provider}: HTTP ${response.status}`);
    } catch (error) {
      if (error instanceof BackendRequestError) {
        throw error;
      }
      failures.push(`${provider}: ${error instanceof Error ? error.message : 'request failed'}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new BackendUnavailableError(failures);
}
