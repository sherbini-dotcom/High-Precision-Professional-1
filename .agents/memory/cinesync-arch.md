---
name: CineSync Watch Party Architecture
description: Key non-obvious decisions for the CineSync watch party app (Socket.IO, HLS, IP bans, session persistence)
---

## Socket.IO path proxying
Socket.IO requires its path (`/socket.io`) listed explicitly in `artifact.toml` paths array alongside `/api`. Without it, the reverse proxy silently drops WebSocket upgrade requests.

**Why:** Replit's proxy only forwards explicitly listed paths. Socket.IO uses `/socket.io` as its default namespace path for both HTTP polling and WS upgrades.

**How to apply:** Any time Socket.IO is added to an API server artifact, add `/socket.io` to the `paths` array in `.replit-artifact/artifact.toml`.

## IP-based session persistence
Members rejoin their previous session (role restored) when their IP matches an existing member record in the room. New UUID session token is not issued — existing one is returned.

**Why:** Users refresh the page, especially on mobile. IP+room pair is the identity anchor. Session token stored in localStorage as `wp_session_<roomCode>`.

## HLS video streaming
Videos are uploaded via multer → converted to HLS segments via fluent-ffmpeg → served from `uploads/<roomCode>/hls/`. Safari uses native HLS; other browsers use hls.js.

**Why:** HLS allows playback to begin before full download and is the only format with native Safari support.

## Socket.IO server attaches to http.Server, not express app
`createServer(app)` wraps the Express app, Socket.IO attaches to the httpServer, and `io` is stored via `app.set('io', io)` for access in route handlers (e.g., emit progress from video upload route).
