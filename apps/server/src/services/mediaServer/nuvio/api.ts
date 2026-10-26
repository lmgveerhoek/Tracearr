/**
 * Nuvio sync access for a group of accounts.
 *
 * Nuvio has no admin API: each account's own watch progress is read with that
 * account's login, through the same Supabase calls Nuvio's apps make
 * (sync_pull_profiles, sync_pull_watch_progress, sync_pull_watched_items).
 * The logins come from a roster endpoint (the operator's onboarding portal),
 * which the server token authorizes.
 */

import { HttpClientError } from '../../../utils/http.js';

export interface NuvioRosterEntry {
  username: string;
  displayName?: string;
  email: string;
  password: string;
}

export interface NuvioProfile {
  profile_index: number;
  name?: string;
}

export interface NuvioProgressRow {
  content_id: string;
  content_type: string;
  video_id: string;
  season?: number | null;
  episode?: number | null;
  position: number;
  duration: number;
  last_watched: number;
  progress_key?: string;
}

export interface NuvioWatchedRow {
  content_id: string;
  content_type: string;
  title?: string;
  season?: number | null;
  episode?: number | null;
  watched_at: number;
}

const SERVICE = 'nuvio';
const ROSTER_TTL_MS = 5 * 60_000;
const DEFAULT_BACKEND = process.env.NUVIO_BACKEND_URL || 'https://api.nuvio.tv';

interface TokenEntry {
  token: string;
  expiresAt: number;
}

const tokens = new Map<string, TokenEntry>();
const rosters = new Map<string, { at: number; entries: NuvioRosterEntry[] }>();
let publishableKey: Promise<string> | null = null;

async function key(backend: string): Promise<string> {
  publishableKey ??= fetch(`${backend}/.well-known/nuvio`, { signal: AbortSignal.timeout(15_000) })
    .then(async (res) => {
      if (!res.ok) throw new Error(`Nuvio discovery failed: HTTP ${res.status}`);
      return ((await res.json()) as { publishable_key: string }).publishable_key;
    })
    .catch((error: unknown) => {
      publishableKey = null;
      throw error;
    });
  return publishableKey;
}

export class NuvioApi {
  constructor(
    private readonly rosterUrl: string,
    private readonly rosterToken: string,
    private readonly backend = DEFAULT_BACKEND
  ) {}

  async roster(force = false): Promise<NuvioRosterEntry[]> {
    const cached = rosters.get(this.rosterUrl);
    if (!force && cached && Date.now() - cached.at < ROSTER_TTL_MS) return cached.entries;
    const url = `${this.rosterUrl.replace(/\/+$/, '')}/internal/nuvio-roster`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${this.rosterToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new HttpClientError({
        service: SERVICE,
        statusCode: res.status,
        statusText: res.statusText,
        url,
      });
    }
    const entries = (await res.json()) as NuvioRosterEntry[];
    rosters.set(this.rosterUrl, { at: Date.now(), entries });
    return entries;
  }

  private async signIn(account: NuvioRosterEntry): Promise<string> {
    const res = await fetch(`${this.backend}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: await key(this.backend), 'content-type': 'application/json' },
      body: JSON.stringify({ email: account.email, password: account.password }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok)
      throw new Error(`Nuvio sign-in for ${account.username} failed: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in?: number };
    tokens.set(account.email, {
      token: body.access_token,
      expiresAt: Date.now() + Math.max(60, (body.expires_in ?? 3600) - 120) * 1000,
    });
    return body.access_token;
  }

  async rpc<T>(
    account: NuvioRosterEntry,
    name: string,
    params: Record<string, unknown>
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const cached = tokens.get(account.email);
      const token =
        cached && cached.expiresAt > Date.now() ? cached.token : await this.signIn(account);
      const res = await fetch(`${this.backend}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: {
          apikey: await key(this.backend),
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 401 && attempt === 0) {
        tokens.delete(account.email);
        continue;
      }
      if (!res.ok) throw new Error(`Nuvio ${name} for ${account.username}: HTTP ${res.status}`);
      const text = await res.text();
      return (text ? JSON.parse(text) : []) as T;
    }
  }

  async profiles(account: NuvioRosterEntry): Promise<NuvioProfile[]> {
    try {
      const list = await this.rpc<NuvioProfile[]>(account, 'sync_pull_profiles', {});
      const usable = list.filter((p) => Number.isFinite(p.profile_index));
      return usable.length ? usable : [{ profile_index: 1 }];
    } catch {
      return [{ profile_index: 1 }];
    }
  }
}

/** Test hook. */
export function clearNuvioCaches(): void {
  tokens.clear();
  rosters.clear();
  publishableKey = null;
}
