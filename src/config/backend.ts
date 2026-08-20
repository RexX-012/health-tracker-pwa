export type BackendProvider = 'cloudflare' | 'vercel';

function normaliseUrl(url: string | undefined) {
  return url?.trim().replace(/\/+$/, '') ?? '';
}

export const backendUrls: Record<BackendProvider, string> = {
  cloudflare: normaliseUrl(process.env.EXPO_PUBLIC_CLOUDFLARE_API_URL),
  vercel: normaliseUrl(process.env.EXPO_PUBLIC_VERCEL_API_URL),
};

export const backendOrder: BackendProvider[] = ['cloudflare', 'vercel'];
