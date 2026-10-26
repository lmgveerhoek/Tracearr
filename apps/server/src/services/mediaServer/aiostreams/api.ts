/**
 * Minimal AIOStreams dashboard API transport.
 *
 * AIOStreams authenticates its admin dashboard with a session cookie issued by
 * POST /api/v1/auth/login. Logins are rate limited, so the cookie is cached per
 * server and username and only renewed when a request comes back 401.
 */

import { HttpClientError } from '../../../utils/http.js';

export interface AIOStreamsCredentials {
  username: string;
  password: string;
}

const SERVICE = 'aiostreams';
const SESSION_COOKIE = 'aiostreams.session';
const sessionCookies = new Map<string, string>();

/** The server token is stored as `username:password` of an AIOStreams admin. */
export function parseCredentials(token: string): AIOStreamsCredentials {
  const separator = token.indexOf(':');
  if (separator <= 0 || separator === token.length - 1) {
    throw new Error('AIOStreams token must be "username:password" of an admin account');
  }
  return { username: token.slice(0, separator), password: token.slice(separator + 1) };
}

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code?: string; message?: string };
}

export class AIOStreamsApi {
  private readonly cacheKey: string;

  constructor(
    private readonly baseUrl: string,
    private readonly credentials: AIOStreamsCredentials,
    private readonly timeoutMs = 15_000
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.cacheKey = `${this.baseUrl}|${credentials.username}`;
  }

  /** Public health endpoint; needs no session. */
  async health(): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/v1/health`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as Envelope<unknown>;
    return body.success === true;
  }

  async login(): Promise<string> {
    const url = `${this.baseUrl}/api/v1/auth/login`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(this.credentials),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new HttpClientError({
        service: SERVICE,
        statusCode: res.status,
        statusText: res.statusText,
        url,
        message: `AIOStreams login failed: ${res.status} ${res.statusText}`,
      });
    }
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0] ?? '')
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    if (!cookie) throw new Error('AIOStreams login returned no session cookie');
    sessionCookies.set(this.cacheKey, cookie);
    return cookie;
  }

  /** Call a dashboard endpoint and unwrap AIOStreams' response envelope. */
  async request<T>(method: 'GET' | 'DELETE' | 'POST', path: string, body?: unknown): Promise<T> {
    let cookie = sessionCookies.get(this.cacheKey) ?? (await this.login());
    for (let attempt = 0; ; attempt++) {
      const url = `${this.baseUrl}${path}`;
      const res = await fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          Cookie: cookie,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 401 && attempt === 0) {
        sessionCookies.delete(this.cacheKey);
        cookie = await this.login();
        continue;
      }
      if (!res.ok) {
        throw new HttpClientError({
          service: SERVICE,
          statusCode: res.status,
          statusText: res.statusText,
          url,
        });
      }
      const envelope = (await res.json()) as Envelope<T>;
      if (!envelope.success) {
        throw new Error(`AIOStreams ${path}: ${envelope.error?.message ?? 'request failed'}`);
      }
      return envelope.data as T;
    }
  }
}

/** Test hook: forget cached session cookies. */
export function clearSessionCache(): void {
  sessionCookies.clear();
}
