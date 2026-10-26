/**
 * Nuvio watch progress -> Tracearr sessions and history.
 *
 * Nuvio's apps push watch progress while playing (and on pause or exit); it
 * has no live-session or device list and no client IP. A title counts as
 * playing while its progress was updated within ACTIVE_WINDOW_MS and it is
 * not finished.
 */

import type { MediaSession, MediaWatchHistoryItem } from '../types.js';
import type { NuvioProgressRow, NuvioRosterEntry, NuvioWatchedRow } from './api.js';

export const ACTIVE_WINDOW_MS = 3 * 60_000;
const FINISHED_RATIO = 0.95;

export interface TitleInfo {
  title: string;
  year?: number;
  episodeTitle?: string;
}

export function isActive(row: NuvioProgressRow, now = Date.now()): boolean {
  if (!row.last_watched || now - row.last_watched > ACTIVE_WINDOW_MS) return false;
  return !(row.duration > 0 && row.position / row.duration >= FINISHED_RATIO);
}

const isEpisode = (row: { content_type: string; season?: number | null }) =>
  row.content_type === 'series' || row.content_type === 'anime' || row.season != null;

export function progressToSession(
  account: NuvioRosterEntry,
  profile: { profile_index: number; name?: string },
  row: NuvioProgressRow,
  info: TitleInfo
): MediaSession {
  const episode = isEpisode(row);
  const progressPercent =
    row.duration > 0 ? Math.min(100, Math.round((row.position / row.duration) * 100)) : 0;
  return {
    sessionKey: `${account.username}:${profile.profile_index}:${row.progress_key || row.video_id}`,
    mediaId: row.video_id || row.content_id,
    user: { id: account.username, username: account.displayName || account.username },
    media: {
      title: episode
        ? info.episodeTitle || `${info.title} S${row.season}E${row.episode}`
        : info.title,
      type: episode ? 'episode' : 'movie',
      durationMs: row.duration || 0,
      year: info.year,
    },
    episode: episode
      ? {
          showTitle: info.title,
          seasonNumber: row.season ?? null,
          episodeNumber: row.episode ?? null,
        }
      : undefined,
    playback: { state: 'playing', positionMs: row.position || 0, progressPercent },
    player: {
      name: profile.name ? `Nuvio (${profile.name})` : 'Nuvio',
      deviceId: `nuvio:${account.username}:${profile.profile_index}`,
      product: 'Nuvio',
      platform: 'Nuvio',
    },
    // Nuvio's sync carries no client address.
    network: { ipAddress: '0.0.0.0', isLocal: false },
    quality: {
      bitrate: 0,
      isTranscode: false,
      videoDecision: 'directplay',
      audioDecision: 'directplay',
    },
  };
}

export function watchedToHistory(
  account: NuvioRosterEntry,
  row: NuvioWatchedRow,
  info?: TitleInfo
): MediaWatchHistoryItem {
  const episode = isEpisode(row);
  const title = info?.title || row.title || row.content_id;
  return {
    mediaId: episode ? `${row.content_id}:${row.season}:${row.episode}` : row.content_id,
    title: episode ? `${title} S${row.season}E${row.episode}` : title,
    type: episode ? 'episode' : 'movie',
    watchedAt: row.watched_at,
    userId: account.username,
    episode: episode
      ? {
          showTitle: title,
          seasonNumber: row.season ?? undefined,
          episodeNumber: row.episode ?? undefined,
        }
      : undefined,
  };
}
