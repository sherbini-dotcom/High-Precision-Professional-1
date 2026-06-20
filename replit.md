# CineSync — Watch Party Platform

A real-time watch party app where friends watch videos together in perfect sync, with host/admin control, mic audio, and IP-based access management.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 + Socket.IO (real-time)
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Video: HLS streaming via ffmpeg (fluent-ffmpeg)
- Frontend: React + Vite + Tailwind CSS + hls.js + socket.io-client

## Where things live

- `lib/api-spec/openapi.yaml` — API contract (source of truth)
- `lib/db/src/schema/` — DB tables: rooms, members, bans, room_videos
- `artifacts/api-server/src/routes/` — REST routes (rooms, members, bans, video)
- `artifacts/api-server/src/lib/socket.ts` — Socket.IO event handlers
- `artifacts/api-server/src/lib/hls.ts` — ffmpeg HLS processing
- `artifacts/watch-party/src/pages/` — home.tsx, room.tsx, bans.tsx
- `artifacts/watch-party/src/lib/socket.ts` — Socket.IO client
- `artifacts/watch-party/src/lib/storage.ts` — localStorage session helpers
- Video uploads stored in `artifacts/api-server/uploads/<roomCode>/`

## Architecture decisions

- Socket.IO used for real-time sync (video play/pause/seek, member list, speaking)
- IP-based role persistence: rejoining the same room with same IP restores your previous role/session
- IP-based banning: bans are stored per room+IP and checked on join
- HLS streaming: uploaded videos are converted via ffmpeg to HLS segments for efficient streaming before full download
- Session tokens (UUID) stored in localStorage per room code for role restoration after page refresh

## Product

- Create or join private cinema rooms with a 6-character code and optional password
- Upload videos (MP4, MKV, etc.) — converted to HLS for streaming before full download
- Perfect video sync: host/admin controls play/pause/seek, all guests stay in sync
- Live microphone with volume visualization showing who's speaking
- Admin panel: kick, ban, mute, promote/demote members
- IP-based banning: banned users can't rejoin even in another browser
- Ban management page for unbanning

## Gotchas

- After schema changes: run `pnpm --filter @workspace/db run push`
- After OpenAPI spec changes: run `pnpm --filter @workspace/api-spec run codegen` then restart API server
- Socket.IO path must be listed in `artifact.toml` paths for proxy routing
- ffmpeg must be available in PATH (it's included in Replit Nix environment)
- Video uploads stored locally under `artifacts/api-server/uploads/` — not persisted across deployments without object storage
