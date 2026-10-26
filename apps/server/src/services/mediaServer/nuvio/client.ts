/**
 * Nuvio as a Tracearr media server: a group of Nuvio accounts read through
 * their own sync data. Server URL = the roster provider (the onboarding
 * portal's base URL), token = its roster bearer token.
 *
 * Visible: what each account (and profile) is watching and has watched.
 * Not visible: client IP, device, bitrate (Nuvio's sync carries none), and
 * sessions cannot be stopped from here.
 */

import { HttpClientError } from '../../../utils/http.js';
import type {
  IMediaServerClientWithHistory,
  MediaLibrary,
  MediaLibraryItem,
  MediaServerConfig,
  MediaSession,
  MediaUser,
  MediaWatchHistoryItem,
} from '../types.js';
import { NuvioApi, type NuvioProgressRow, type NuvioWatchedRow } from './api.js';
import { isActive, progressToSession, watchedToHistory } from './parser.js';
import { titleFor } from './titles.js';

export class NuvioClient implements IMediaServerClientWithHistory {
  public readonly serverType = 'nuvio' as const;

  static readonly AdminVerifyError = {
    CONNECTION_FAILED: 'CONNECTION_FAILED',
    INVALID_KEY: 'INVALID_KEY',
    NOT_ADMIN: 'NOT_ADMIN',
  } as const;

  private readonly api: NuvioApi;

  constructor(config: MediaServerConfig) {
    this.api = new NuvioApi(config.url, config.token);
  }

  async getSessions(sessionKey?: string): Promise<MediaSession[]> {
    const now = Date.now();
    const sessions: MediaSession[] = [];
    for (const account of await this.api.roster()) {
      try {
        for (const profile of await this.api.profiles(account)) {
          const rows = await this.api.rpc<NuvioProgressRow[]>(account, 'sync_pull_watch_progress', {
            p_profile_id: profile.profile_index,
          });
          for (const row of rows.filter((r) => isActive(r, now))) {
            const info = await titleFor(row.content_id, row.content_type, row.season, row.episode);
            sessions.push(progressToSession(account, profile, row, info));
          }
        }
      } catch {
        // One account failing (changed password, Nuvio hiccup) must not hide the others.
      }
    }
    return sessionKey ? sessions.filter((s) => s.sessionKey === sessionKey) : sessions;
  }

  async getUsers(): Promise<MediaUser[]> {
    return (await this.api.roster(true)).map((a) => ({
      id: a.username,
      username: a.displayName || a.username,
      email: a.email,
      isAdmin: false,
    }));
  }

  async getWatchHistory(options?: {
    userId?: string;
    limit?: number;
  }): Promise<MediaWatchHistoryItem[]> {
    const items: MediaWatchHistoryItem[] = [];
    for (const account of await this.api.roster()) {
      if (options?.userId && options.userId !== account.username) continue;
      for (const profile of await this.api.profiles(account)) {
        const rows = await this.api
          .rpc<NuvioWatchedRow[]>(account, 'sync_pull_watched_items', {
            p_profile_id: profile.profile_index,
          })
          .catch(() => [] as NuvioWatchedRow[]);
        for (const row of rows) {
          const info =
            /^tt\d+$/.test(row.content_id) && !row.title
              ? await titleFor(row.content_id, row.content_type)
              : undefined;
          items.push(watchedToHistory(account, row, info));
        }
      }
    }
    items.sort((a, b) => Number(b.watchedAt) - Number(a.watchedAt));
    return options?.limit ? items.slice(0, options.limit) : items;
  }

  async getLibraries(): Promise<MediaLibrary[]> {
    return [];
  }

  async getLibraryItems(): Promise<{ items: MediaLibraryItem[]; totalCount: number }> {
    return { items: [], totalCount: 0 };
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.api.roster(true);
      return true;
    } catch {
      return false;
    }
  }

  /** Nuvio offers no way to stop playback on someone's device. */
  async terminateSession(): Promise<boolean> {
    return false;
  }

  static async verifyServerAdmin(
    token: string,
    serverUrl: string
  ): Promise<{ success: true } | { success: false; code: string; message: string }> {
    try {
      await new NuvioApi(serverUrl, token).roster(true);
      return { success: true };
    } catch (error) {
      if (
        error instanceof HttpClientError &&
        (error.statusCode === 401 || error.statusCode === 403)
      ) {
        return {
          success: false,
          code: NuvioClient.AdminVerifyError.INVALID_KEY,
          message: 'The roster endpoint rejected this token.',
        };
      }
      const message =
        error instanceof Error ? error.message : 'Unable to reach the roster endpoint';
      return {
        success: false,
        code: NuvioClient.AdminVerifyError.CONNECTION_FAILED,
        message: `Cannot read the Nuvio roster at ${serverUrl}. ${message}`,
      };
    }
  }
}
