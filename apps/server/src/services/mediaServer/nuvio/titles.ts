/**
 * Titles for Nuvio progress rows, which carry only IDs. IMDb IDs are looked up
 * in Cinemeta (public, no key) and cached for a day.
 */

import type { TitleInfo } from './parser.js';

const CINEMETA = process.env.NUVIO_CINEMETA_URL || 'https://v3-cinemeta.strem.io';
const TTL_MS = 24 * 3600_000;
const cache = new Map<string, { at: number; info: Promise<TitleInfo> }>();

interface CinemetaMeta {
  name?: string;
  releaseInfo?: string;
  year?: string | number;
  videos?: Array<{ season?: number; episode?: number; name?: string; title?: string }>;
}

async function fetchMeta(type: string, id: string): Promise<CinemetaMeta | null> {
  const kind = type === 'movie' ? 'movie' : 'series';
  const res = await fetch(`${CINEMETA}/meta/${kind}/${encodeURIComponent(id)}.json`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  return ((await res.json()) as { meta?: CinemetaMeta }).meta ?? null;
}

export function titleFor(
  contentId: string,
  contentType: string,
  season?: number | null,
  episode?: number | null
): Promise<TitleInfo> {
  const key = `${contentType}:${contentId}`;
  let entry = cache.get(key);
  if (!entry || Date.now() - entry.at > TTL_MS) {
    const info = (
      /^tt\d+$/.test(contentId) ? fetchMeta(contentType, contentId) : Promise.resolve(null)
    )
      .then((meta) => ({
        title: meta?.name || contentId,
        year: Number.parseInt(String(meta?.year ?? meta?.releaseInfo ?? ''), 10) || undefined,
        videos: meta?.videos ?? [],
      }))
      .catch(() => ({ title: contentId, year: undefined, videos: [] }));
    entry = { at: Date.now(), info: info as unknown as Promise<TitleInfo> };
    cache.set(key, entry);
  }
  return entry.info.then((base) => {
    const { videos = [], ...rest } = base as TitleInfo & { videos?: CinemetaMeta['videos'] };
    const match =
      season != null
        ? videos?.find((v) => v.season === season && v.episode === episode)
        : undefined;
    const name = match?.name || match?.title;
    return {
      ...rest,
      episodeTitle: name ? `${rest.title} S${season}E${episode}: ${name}` : undefined,
    };
  });
}

/** Test hook. */
export function clearTitleCache(): void {
  cache.clear();
}
