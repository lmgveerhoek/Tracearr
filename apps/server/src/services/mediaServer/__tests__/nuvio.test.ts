/**
 * Nuvio source: activity window, session mapping, and the client against a
 * mocked roster, Nuvio backend and Cinemeta.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../utils/crypto.js', () => ({
  decrypt: vi.fn((val: string) => val),
  encrypt: vi.fn((val: string) => val),
  initializeEncryption: vi.fn(),
  isEncryptionInitialized: vi.fn(() => true),
}));

import { createMediaServerClient, NuvioClient } from '../index.js';
import { clearNuvioCaches, type NuvioProgressRow } from '../nuvio/api.js';
import { clearTitleCache } from '../nuvio/titles.js';
import {
  ACTIVE_WINDOW_MS,
  isActive,
  progressToSession,
  watchedToHistory,
} from '../nuvio/parser.js';

const NOW = 1_800_000_000_000;
const account = {
  username: 'anna',
  displayName: 'Anna',
  email: 'anna@flixvoornix.nl',
  password: 'pw',
};
const row = (over: Partial<NuvioProgressRow> = {}): NuvioProgressRow => ({
  content_id: 'tt0111161',
  content_type: 'movie',
  video_id: 'tt0111161',
  position: 600_000,
  duration: 8_520_000,
  last_watched: NOW - 30_000,
  progress_key: 'tt0111161',
  ...over,
});

describe('activity', () => {
  it('counts recent, unfinished progress as playing', () => {
    expect(isActive(row(), NOW)).toBe(true);
    expect(isActive(row({ last_watched: NOW - ACTIVE_WINDOW_MS - 1 }), NOW)).toBe(false);
    expect(isActive(row({ position: 8_400_000 }), NOW)).toBe(false);
  });
});

describe('mapping', () => {
  it('maps a movie', () => {
    const s = progressToSession(account, { profile_index: 1, name: 'Main' }, row(), {
      title: 'The Shawshank Redemption',
      year: 1994,
    });
    expect(s.sessionKey).toBe('anna:1:tt0111161');
    expect(s.user).toEqual({ id: 'anna', username: 'Anna' });
    expect(s.media).toMatchObject({
      title: 'The Shawshank Redemption',
      type: 'movie',
      year: 1994,
      durationMs: 8_520_000,
    });
    expect(s.playback).toEqual({ state: 'playing', positionMs: 600_000, progressPercent: 7 });
    expect(s.player.name).toBe('Nuvio (Main)');
  });

  it('maps an episode and history', () => {
    const s = progressToSession(
      account,
      { profile_index: 2 },
      row({ content_type: 'series', season: 1, episode: 2, video_id: 'tt0903747:1:2' }),
      {
        title: 'Breaking Bad',
        episodeTitle: "Breaking Bad S1E2: Cat's in the Bag...",
      }
    );
    expect(s.media.type).toBe('episode');
    expect(s.episode).toMatchObject({
      showTitle: 'Breaking Bad',
      seasonNumber: 1,
      episodeNumber: 2,
    });
    const h = watchedToHistory(account, {
      content_id: 'tt0903747',
      content_type: 'series',
      title: 'Breaking Bad',
      season: 1,
      episode: 2,
      watched_at: NOW,
    });
    expect(h).toMatchObject({
      mediaId: 'tt0903747:1:2',
      title: 'Breaking Bad S1E2',
      type: 'episode',
      userId: 'anna',
    });
  });
});

describe('NuvioClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearNuvioCaches();
    clearTitleCache();
  });

  function mock(opts: { rosterStatus?: number } = {}) {
    const signIns: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = new URL(url);
        if (u.pathname === '/internal/nuvio-roster') {
          if (opts.rosterStatus) return new Response('no', { status: opts.rosterStatus });
          expect(new Headers(init?.headers).get('authorization')).toBe('Bearer roster-token');
          return Response.json([account]);
        }
        if (u.pathname === '/.well-known/nuvio') return Response.json({ publishable_key: 'anon' });
        if (u.pathname === '/auth/v1/token') {
          signIns.push(JSON.parse(String(init?.body)).email);
          return Response.json({ access_token: 'tok', expires_in: 3600 });
        }
        if (u.pathname === '/rest/v1/rpc/sync_pull_profiles')
          return Response.json([{ profile_index: 1, name: 'Main' }]);
        if (u.pathname === '/rest/v1/rpc/sync_pull_watch_progress') {
          return Response.json([
            row({ last_watched: Date.now() - 10_000 }),
            row({ video_id: 'old', progress_key: 'old', last_watched: 1 }),
          ]);
        }
        if (u.pathname === '/rest/v1/rpc/sync_pull_watched_items') {
          return Response.json([
            {
              content_id: 'tt0111161',
              content_type: 'movie',
              title: 'The Shawshank Redemption',
              watched_at: 5,
            },
          ]);
        }
        if (u.pathname.startsWith('/meta/movie/'))
          return Response.json({ meta: { name: 'The Shawshank Redemption', releaseInfo: '1994' } });
        return new Response('not found', { status: 404 });
      })
    );
    return { signIns };
  }

  const client = () =>
    createMediaServerClient({ type: 'nuvio', url: 'http://portal:8080', token: 'roster-token' });

  it('is created by the factory', () => {
    expect(client()).toBeInstanceOf(NuvioClient);
  });

  it('reports only recently updated progress as sessions, with titles', async () => {
    const { signIns } = mock();
    const sessions = await client().getSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.media).toMatchObject({ title: 'The Shawshank Redemption', year: 1994 });
    await client().getSessions();
    expect(signIns).toEqual(['anna@flixvoornix.nl']);
  });

  it('lists users and watch history from the roster', async () => {
    mock();
    expect((await client().getUsers()).map((u) => u.username)).toEqual(['Anna']);
    const history = await (client() as NuvioClient).getWatchHistory({ limit: 10 });
    expect(history[0]).toMatchObject({ title: 'The Shawshank Redemption', userId: 'anna' });
  });

  it('rejects a bad roster token', async () => {
    mock({ rosterStatus: 401 });
    const result = await NuvioClient.verifyServerAdmin('wrong', 'http://portal:8080');
    expect(result).toMatchObject({ success: false, code: 'INVALID_KEY' });
    expect(await client().terminateSession('x')).toBe(false);
  });
});
