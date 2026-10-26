/**
 * AIOStreams as a Tracearr media server.
 *
 * Reads AIOStreams' own stream accounting (its admin dashboard API): every
 * stream its usenet engine or built-in proxy serves, with the attributed user,
 * client IP and bytes. Streams that bypass AIOStreams (direct debrid links, or
 * playback proxied by StremThru) are not visible here.
 */

import { HttpClientError } from '../../../utils/http.js';
import type {
  IMediaServerClient,
  MediaLibrary,
  MediaLibraryItem,
  MediaServerConfig,
  MediaSession,
  MediaUser,
} from '../types.js';
import { AIOStreamsApi, parseCredentials } from './api.js';
import {
  parseLiveSession,
  usersFromSessions,
  type AIOStreamsHistoryEntry,
  type AIOStreamsLiveSession,
} from './parser.js';

const HISTORY_WINDOW = 500;

export class AIOStreamsClient implements IMediaServerClient {
  public readonly serverType = 'aiostreams' as const;

  static readonly AdminVerifyError = {
    CONNECTION_FAILED: 'CONNECTION_FAILED',
    INVALID_KEY: 'INVALID_KEY',
    NOT_ADMIN: 'NOT_ADMIN',
  } as const;

  private readonly api: AIOStreamsApi;

  constructor(config: MediaServerConfig) {
    this.api = new AIOStreamsApi(config.url, parseCredentials(config.token));
  }

  async getSessions(sessionKey?: string): Promise<MediaSession[]> {
    const snapshot = await this.api.request<{ streams: AIOStreamsLiveSession[] }>(
      'GET',
      '/api/v1/dashboard/streams/live'
    );
    return snapshot.streams.filter((s) => !sessionKey || s.id === sessionKey).map(parseLiveSession);
  }

  async getUsers(): Promise<MediaUser[]> {
    const [live, history] = await Promise.all([
      this.api.request<{ streams: AIOStreamsLiveSession[] }>(
        'GET',
        '/api/v1/dashboard/streams/live'
      ),
      this.api.request<{ entries: AIOStreamsHistoryEntry[] }>(
        'GET',
        `/api/v1/dashboard/streams/history?limit=${HISTORY_WINDOW}`
      ),
    ]);
    return usersFromSessions([...live.streams, ...history.entries]);
  }

  /** AIOStreams has catalogs, not libraries; nothing to sync. */
  async getLibraries(): Promise<MediaLibrary[]> {
    return [];
  }

  async getLibraryItems(): Promise<{ items: MediaLibraryItem[]; totalCount: number }> {
    return { items: [], totalCount: 0 };
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.api.request('GET', '/api/v1/dashboard/streams/live');
      return true;
    } catch {
      return false;
    }
  }

  async terminateSession(sessionId: string): Promise<boolean> {
    try {
      await this.api.request(
        'DELETE',
        `/api/v1/dashboard/streams/sessions/${encodeURIComponent(sessionId)}`
      );
      return true;
    } catch {
      return false;
    }
  }

  static async verifyServerAdmin(
    token: string,
    serverUrl: string
  ): Promise<{ success: true } | { success: false; code: string; message: string }> {
    let api: AIOStreamsApi;
    try {
      api = new AIOStreamsApi(serverUrl, parseCredentials(token));
    } catch (error) {
      return {
        success: false,
        code: AIOStreamsClient.AdminVerifyError.INVALID_KEY,
        message: error instanceof Error ? error.message : 'Invalid credentials',
      };
    }
    try {
      if (!(await api.health())) throw new Error('health check failed');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to connect to server';
      return {
        success: false,
        code: AIOStreamsClient.AdminVerifyError.CONNECTION_FAILED,
        message: `Cannot reach AIOStreams at ${serverUrl}. ${message}`,
      };
    }
    try {
      await api.login();
      await api.request('GET', '/api/v1/dashboard/streams/live');
      return { success: true };
    } catch (error) {
      if (error instanceof HttpClientError && error.statusCode === 401) {
        return {
          success: false,
          code: AIOStreamsClient.AdminVerifyError.INVALID_KEY,
          message: 'AIOStreams rejected this username or password.',
        };
      }
      if (error instanceof HttpClientError && error.statusCode === 403) {
        return {
          success: false,
          code: AIOStreamsClient.AdminVerifyError.NOT_ADMIN,
          message: 'This AIOStreams account has no admin permission.',
        };
      }
      const message = error instanceof Error ? error.message : 'Unable to verify admin access';
      return {
        success: false,
        code: AIOStreamsClient.AdminVerifyError.CONNECTION_FAILED,
        message: `Could not verify admin access on AIOStreams at ${serverUrl}. ${message}`,
      };
    }
  }
}
