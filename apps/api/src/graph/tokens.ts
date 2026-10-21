import { GraphError } from '../http/errors';
import type { FetchLike } from './client';

interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * Client-credentials (app-only) token for background work: OneDrive storage under Sites.Selected
 * and notification mail from the approved mailbox. Cached per isolate until 5 minutes before expiry.
 */
export function appTokenProvider(
  entra: { tenantId: string; clientId: string; clientSecret: string },
  fetchImpl: FetchLike = (i, init) => fetch(i, init),
  now: () => number = Date.now,
) {
  // Only the token string is shared across requests. An in-flight fetch promise must not be:
  // Workers reject I/O started by one request being awaited from another.
  let cached: CachedToken | null = null;
  return async (): Promise<string> => {
    if (cached && cached.expiresAt - 300_000 > now()) return cached.token;
    {
      const res = await fetchImpl(
        `https://login.microsoftonline.com/${entra.tenantId}/oauth2/v2.0/token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: entra.clientId,
            client_secret: entra.clientSecret,
            scope: 'https://graph.microsoft.com/.default',
            grant_type: 'client_credentials',
          }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        access_token?: string;
        expires_in?: number;
        error?: string;
      };
      if (!res.ok || !body.access_token) {
        throw new GraphError(
          res.status === 200 ? 500 : res.status,
          body.error ?? 'token_error',
          'Could not acquire an app token from Entra ID',
        );
      }
      cached = { token: body.access_token, expiresAt: now() + (body.expires_in ?? 3600) * 1000 };
      return cached.token;
    }
  };
}
