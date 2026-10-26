# lmgveerhoek/Tracearr

A fork of [connorgallopo/Tracearr](https://github.com/connorgallopo/Tracearr) that adds **AIOStreams** as a media server source, for the Flixvoornix homelab.

## What it adds

- `apps/server/src/services/mediaServer/aiostreams/`: an `IMediaServerClient` over AIOStreams' admin dashboard API (`/api/v1/dashboard/streams/*`): live sessions with user, client IP, release, bytes and speed; users derived from session history; session kill.
- Server type `aiostreams` (type-only widening where the code spelled out `'plex' | 'jellyfin' | 'emby'`; no behavior change for those). AIOStreams has no realtime events, libraries or requests: it is always polled, and those features skip it.
- Add it under Settings → Servers → AIOStreams with the AIOStreams URL and `username:password` of an AIOStreams admin (`AIOSTREAMS_AUTH`).

## Limits

- AIOStreams attributes a stream to the engine/proxy username of the config. Configs sharing one forced credential all show up as one user; give each person their own credential for per-person stats and bans.
- Only streams that flow through AIOStreams (its usenet engine and built-in proxy) are visible; direct debrid links or playback proxied by StremThru are not.
- Title, year and episode come from the release filename; there is no playback position or duration.

## Staying current

- `git fetch upstream && git rebase upstream/main` on `feat/aiostreams-source`. The touchpoints outside `aiostreams/` are small and type-level, so conflicts stay trivial.
- `.github/workflows/fork-aiostreams-image.yml` builds `ghcr.io/lmgveerhoek/tracearr:aiostreams` (arm64, all-in-one image) on every push to the branch. GeoIP comes from MaxMind when a `MAXMIND_LICENSE_KEY` secret is set, otherwise from DB-IP Lite (CC BY 4.0, IP geolocation by [DB-IP](https://db-ip.com)).
