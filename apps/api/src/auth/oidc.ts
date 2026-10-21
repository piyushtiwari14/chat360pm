import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { AuthError } from '../http/errors';
import type { FetchLike } from '../graph/client';
import { randomToken, sha256B64url } from './crypto';

/** Sign-in asks only for identity; Outlook scopes are requested incrementally when first needed. */
export const BASE_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'User.Read'];
export const OUTLOOK_SCOPES = ['Mail.Send', 'Calendars.ReadWrite'];

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scope: string;
  idToken?: string;
}

export interface IdClaims extends JWTPayload {
  oid: string;
  tid: string;
  nonce?: string;
  name?: string;
  preferred_username?: string;
  email?: string;
  auth_time?: number;
}

export interface OidcClient {
  authorizeUrl(params: {
    state: string;
    nonce: string;
    codeChallenge: string;
    scopes: string[];
    prompt?: string;
    loginHint?: string;
  }): string;
  exchangeCode(code: string, verifier: string): Promise<TokenSet>;
  refresh(refreshToken: string, scopes: string[]): Promise<TokenSet>;
  verifyIdToken(idToken: string, nonce: string): Promise<IdClaims>;
}

export async function pkcePair() {
  const verifier = randomToken(48);
  return { verifier, challenge: await sha256B64url(verifier) };
}

export function createOidcClient(opts: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: FetchLike;
  jwks?: JWTVerifyGetKey;
  now?: () => number;
}): OidcClient {
  const authority = `https://login.microsoftonline.com/${opts.tenantId}`;
  const issuer = `${authority}/v2.0`;
  const fetchImpl = opts.fetch ?? ((i, init) => fetch(i, init));
  const jwksUrl = new URL(`${authority}/discovery/v2.0/keys`);
  // A remote JWKS set caches its pending download, which must not be shared across Worker
  // requests, so one is created per verification (sign-ins are infrequent).
  const jwksFor = () => opts.jwks ?? createRemoteJWKSet(jwksUrl);
  const now = opts.now ?? Date.now;

  async function token(params: Record<string, string>): Promise<TokenSet> {
    const res = await fetchImpl(`${authority}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        ...params,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
      suberror?: string;
    };
    if (!res.ok || !body.access_token) {
      if (body.error === 'invalid_grant' || body.error === 'interaction_required') {
        throw new AuthError(
          body.suberror === 'consent_required' ? 'consent_required' : 'unauthenticated',
          'Your Microsoft sign-in has expired. Please sign in again.',
        );
      }
      throw new AuthError('unauthenticated', 'Microsoft sign-in failed. Please try again.');
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      expiresAt: now() + (body.expires_in ?? 3600) * 1000,
      scope: body.scope ?? '',
      ...(body.id_token ? { idToken: body.id_token } : {}),
    };
  }

  return {
    authorizeUrl({ state, nonce, codeChallenge, scopes, prompt, loginHint }) {
      const q = new URLSearchParams({
        client_id: opts.clientId,
        response_type: 'code',
        redirect_uri: opts.redirectUri,
        response_mode: 'query',
        scope: scopes.join(' '),
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        ...(prompt ? { prompt } : {}),
        ...(loginHint ? { login_hint: loginHint } : {}),
      });
      return `${authority}/oauth2/v2.0/authorize?${q.toString()}`;
    },
    exchangeCode: (code, verifier) =>
      token({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: opts.redirectUri,
      }),
    refresh: (refreshToken, scopes) =>
      token({ grant_type: 'refresh_token', refresh_token: refreshToken, scope: scopes.join(' ') }),
    async verifyIdToken(idToken, nonce) {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(idToken, jwksFor(), {
          issuer,
          audience: opts.clientId,
          algorithms: ['RS256'],
          currentDate: new Date(now()),
          clockTolerance: 120,
        }));
      } catch {
        throw new AuthError(
          'unauthenticated',
          'The Microsoft sign-in response could not be verified.',
        );
      }
      const claims = payload as IdClaims;
      if (claims.nonce !== nonce)
        throw new AuthError('unauthenticated', 'Sign-in response did not match this request.');
      if (claims.tid !== opts.tenantId)
        throw new AuthError('not_authorized', 'This account is not from the Chat360 tenant.');
      if (!claims.oid)
        throw new AuthError('unauthenticated', 'Sign-in response is missing the user identifier.');
      return claims;
    },
  };
}
