/**
 * AIOStreams stream sessions → Tracearr media sessions.
 *
 * AIOStreams does not transcode or know playback position: a session is a
 * byte stream (its usenet engine or its built-in proxy) with a release
 * filename, a client IP and byte counters. Title, year and episode come from
 * the release name; progress is how far into the file the newest read is.
 */

import type { MediaSession, MediaUser } from '../types.js';

/** AIOStreams `LiveStreamSession` (GET /api/v1/dashboard/streams/live). */
export interface AIOStreamsLiveSession {
  id: string;
  transport: 'usenet' | 'proxy';
  /** Engine/proxy username the stream is attributed to; empty when unidentified. */
  username: string;
  clientIp?: string;
  targetKey: string;
  filename?: string;
  size: number;
  bytesServed: number;
  startedAt: number;
  lastSeenAt: number;
  activity: 'streaming' | 'paused' | 'idle';
  start: number;
  currentBytes: number;
  bytesPerSec: number;
}

/** AIOStreams `StreamSessionRow` (GET /api/v1/dashboard/streams/history). */
export interface AIOStreamsHistoryEntry {
  id: string;
  transport: 'usenet' | 'proxy';
  username: string;
  clientIp?: string;
  filename?: string;
  startedAt: number;
  lastSeenAt: number;
}

export const UNIDENTIFIED_USER = 'unidentified';

export interface ParsedRelease {
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  resolution?: string;
}

const EPISODE_RE = /\bS(\d{1,2})[ ._-]?E(\d{1,3})\b/i;
const YEAR_RE = /\b(19\d{2}|20\d{2})\b/;
const RESOLUTION_RE = /\b(2160p|1080p|720p|576p|480p|4k)\b/i;

/** Best-effort title/year/episode from a scene-style release filename. */
export function parseReleaseName(filename: string | undefined): ParsedRelease {
  if (!filename) return { title: 'Unknown' };
  const base = filename.replace(/\.[a-z0-9]{2,4}$/i, '');
  const episode = EPISODE_RE.exec(base);
  const year = YEAR_RE.exec(base);
  const resolution = RESOLUTION_RE.exec(base)?.[1]?.toLowerCase();
  const cut = [episode?.index, year?.index, RESOLUTION_RE.exec(base)?.index]
    .filter((i): i is number => typeof i === 'number' && i > 0)
    .reduce((a, b) => Math.min(a, b), base.length);
  const title =
    base
      .slice(0, cut)
      .replace(/[._]+/g, ' ')
      .replace(/[\s-]+$/, '')
      .trim() || base;
  return {
    title,
    year: year ? Number(year[1]) : undefined,
    season: episode ? Number(episode[1]) : undefined,
    episode: episode ? Number(episode[2]) : undefined,
    resolution: resolution === '4k' ? '2160p' : resolution,
  };
}

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

export function isLocalAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  const v4 = ip.replace(/^::ffff:/, '');
  return PRIVATE_V4.some((re) => re.test(v4)) || ip === '::1' || /^f[cd]/i.test(ip);
}

function userOf(username: string): { id: string; username: string } {
  const name = username.trim() || UNIDENTIFIED_USER;
  return { id: name, username: name };
}

export function parseLiveSession(session: AIOStreamsLiveSession): MediaSession {
  const release = parseReleaseName(session.filename);
  const position = session.start + session.currentBytes;
  const progressPercent =
    session.size > 0 ? Math.min(100, Math.round((position / session.size) * 100)) : 0;
  const isEpisode = release.season !== undefined;
  const user = userOf(session.username);
  return {
    sessionKey: session.id,
    mediaId: session.targetKey,
    user,
    media: {
      title: isEpisode ? `${release.title} S${release.season}E${release.episode}` : release.title,
      type: isEpisode ? 'episode' : release.title === 'Unknown' ? 'unknown' : 'movie',
      durationMs: 0,
      year: release.year,
    },
    episode: isEpisode
      ? {
          showTitle: release.title,
          seasonNumber: release.season ?? null,
          episodeNumber: release.episode ?? null,
        }
      : undefined,
    playback: {
      state: session.activity === 'streaming' ? 'playing' : 'paused',
      positionMs: 0,
      progressPercent,
    },
    player: {
      name: `AIOStreams (${session.transport})`,
      deviceId: `${user.id}@${session.clientIp ?? 'unknown'}`,
      product: 'AIOStreams',
      platform: session.transport === 'usenet' ? 'Usenet' : 'Proxy',
    },
    network: {
      ipAddress: session.clientIp ?? '0.0.0.0',
      isLocal: isLocalAddress(session.clientIp),
    },
    quality: {
      bitrate: Math.round((session.bytesPerSec * 8) / 1000),
      isTranscode: false,
      videoDecision: 'directplay',
      audioDecision: 'directplay',
      videoResolution: release.resolution,
    },
  };
}

/** Users seen in live and recent sessions; AIOStreams keeps no user list. */
export function usersFromSessions(
  sessions: Array<Pick<AIOStreamsHistoryEntry, 'username' | 'lastSeenAt'>>
): MediaUser[] {
  const latest = new Map<string, number>();
  for (const s of sessions) {
    const name = s.username.trim() || UNIDENTIFIED_USER;
    latest.set(name, Math.max(latest.get(name) ?? 0, s.lastSeenAt));
  }
  return [...latest.entries()].map(([name, lastSeenAt]) => ({
    id: name,
    username: name,
    isAdmin: false,
    lastActivityAt: lastSeenAt ? new Date(lastSeenAt) : undefined,
  }));
}
