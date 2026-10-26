/**
 * AIOStreams source: release parsing, session mapping and the dashboard
 * client (login cookie, re-login on 401, kill).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../utils/crypto.js', () => ({
  decrypt: vi.fn((val: string) => val),
  encrypt: vi.fn((val: string) => val),
  initializeEncryption: vi.fn(),
  isEncryptionInitialized: vi.fn(() => true),
}));

import { AIOStreamsClient, createMediaServerClient } from '../index.js';
import { clearSessionCache, parseCredentials } from '../aiostreams/api.js';
import {
  isLocalAddress,
  parseLiveSession,
  parseReleaseName,
  usersFromSessions,
  type AIOStreamsLiveSession,
} from '../aiostreams/parser.js';

const live = (over: Partial<AIOStreamsLiveSession> = {}): AIOStreamsLiveSession => ({
  id: 's1',
  transport: 'usenet',
  username: 'anna',
  clientIp: '203.0.113.7',
  targetKey: 'usenet:abc:0',
  filename: 'The.Shawshank.Redemption.1994.1080p.BluRay.x264-GRP.mkv',
  size: 1000,
  bytesServed: 300,
  startedAt: 1_700_000_000_000,
  lastSeenAt: 1_700_000_060_000,
  activity: 'streaming',
  start: 200,
  currentBytes: 50,
  bytesPerSec: 1_250_000,
  ...over,
});

describe('parseReleaseName', () => {
  it('reads a movie release', () => {
    expect(parseReleaseName('The.Shawshank.Redemption.1994.1080p.BluRay.x264-GRP.mkv')).toEqual({
      title: 'The Shawshank Redemption',
      year: 1994,
      season: undefined,
      episode: undefined,
      resolution: '1080p',
    });
  });

  it('reads an episode release', () => {
    const r = parseReleaseName('Severance.S02E05.2160p.ATVP.WEB-DL.mkv');
    expect(r).toMatchObject({ title: 'Severance', season: 2, episode: 5, resolution: '2160p' });
  });

  it('falls back to Unknown without a filename', () => {
    expect(parseReleaseName(undefined)).toEqual({ title: 'Unknown' });
  });
});

describe('parseLiveSession', () => {
  it('maps a usenet stream', () => {
    const s = parseLiveSession(live());
    expect(s.sessionKey).toBe('s1');
    expect(s.user).toEqual({ id: 'anna', username: 'anna' });
    expect(s.media).toMatchObject({ title: 'The Shawshank Redemption', type: 'movie', year: 1994 });
    expect(s.playback).toEqual({ state: 'playing', positionMs: 0, progressPercent: 25 });
    expect(s.network).toEqual({ ipAddress: '203.0.113.7', isLocal: false });
    expect(s.quality).toMatchObject({
      bitrate: 10_000,
      isTranscode: false,
      videoResolution: '1080p',
    });
  });

  it('maps an episode and a paused, unidentified stream', () => {
    const s = parseLiveSession(
      live({
        username: '',
        activity: 'paused',
        filename: 'Show.S01E02.720p.mkv',
        clientIp: undefined,
      })
    );
    expect(s.user.id).toBe('unidentified');
    expect(s.media.type).toBe('episode');
    expect(s.episode).toMatchObject({ showTitle: 'Show', seasonNumber: 1, episodeNumber: 2 });
    expect(s.playback.state).toBe('paused');
    expect(s.network.ipAddress).toBe('0.0.0.0');
  });
});

describe('helpers', () => {
  it('detects private and tailnet addresses', () => {
    expect(isLocalAddress('192.168.1.4')).toBe(true);
    expect(isLocalAddress('100.75.39.79')).toBe(true);
    expect(isLocalAddress('8.8.8.8')).toBe(false);
  });

  it('collects users with their latest activity', () => {
    const users = usersFromSessions([
      { username: 'anna', lastSeenAt: 10 },
      { username: 'anna', lastSeenAt: 30 },
      { username: '', lastSeenAt: 5 },
    ]);
    expect(users.map((u) => [u.id, u.lastActivityAt?.getTime()])).toEqual([
      ['anna', 30],
      ['unidentified', 5],
    ]);
  });

  it('requires username:password credentials', () => {
    expect(parseCredentials('admin:s3:cret')).toEqual({ username: 'admin', password: 's3:cret' });
    expect(() => parseCredentials('no-colon')).toThrow();
  });
});

describe('AIOStreamsClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearSessionCache();
  });

  function mockServer(opts: { expireFirst?: boolean } = {}) {
    let logins = 0;
    let liveCalls = 0;
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/api/v1/auth/login') {
        logins++;
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'set-cookie': `aiostreams.session=tok${logins}; Path=/; HttpOnly` },
        });
      }
      const cookie = new Headers(init?.headers).get('cookie');
      if (path === '/api/v1/dashboard/streams/live') {
        liveCalls++;
        if (opts.expireFirst && liveCalls === 1) return new Response('{}', { status: 401 });
        if (!cookie?.startsWith('aiostreams.session=tok'))
          return new Response('{}', { status: 401 });
        return Response.json({ success: true, data: { streams: [live()], summary: {} } });
      }
      if (path.startsWith('/api/v1/dashboard/streams/sessions/')) {
        return Response.json({ success: true, data: {} });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return { calls, logins: () => logins };
  }

  const client = () =>
    createMediaServerClient({
      type: 'aiostreams',
      url: 'https://aio.example/',
      token: 'admin:pw',
    });

  it('is created by the factory', () => {
    expect(client()).toBeInstanceOf(AIOStreamsClient);
    expect(client().serverType).toBe('aiostreams');
  });

  it('logs in once and reuses the session cookie', async () => {
    const server = mockServer();
    const c = client();
    expect((await c.getSessions())[0]?.user.username).toBe('anna');
    await c.getSessions();
    expect(server.logins()).toBe(1);
  });

  it('logs in again when the session expired', async () => {
    const server = mockServer({ expireFirst: true });
    const sessions = await client().getSessions();
    expect(sessions).toHaveLength(1);
    expect(server.logins()).toBe(2);
  });

  it('filters by session key and kills a session', async () => {
    const server = mockServer();
    const c = client();
    expect(await c.getSessions('other')).toEqual([]);
    expect(await c.terminateSession('s1')).toBe(true);
    expect(server.calls).toContain('DELETE /api/v1/dashboard/streams/sessions/s1');
  });

  it('has no libraries', async () => {
    expect(await client().getLibraries()).toEqual([]);
    expect(await client().getLibraryItems()).toEqual({ items: [], totalCount: 0 });
  });
});
