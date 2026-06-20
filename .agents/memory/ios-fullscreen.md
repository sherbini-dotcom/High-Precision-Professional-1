---
name: iOS fullscreen and Vite error overlay
description: Fixes for iOS Safari fullscreen crash and runtimeErrorOverlay showing WebSocket HMR errors
---

## Rule
1. Remove `runtimeErrorOverlay()` from Vite plugins AND its import — it catches WebSocket errors from Vite HMR and displays them as crashes on iOS Safari.
2. For iOS fullscreen, check `iosVideo.webkitSupportsFullscreen && iosVideo.webkitEnterFullscreen` FIRST before standard requestFullscreen. Wrap everything in try/catch.
3. `requestFullscreen` on a container element fails on iOS; must call `webkitEnterFullscreen()` directly on the `<video>` element.

**Why:** iOS Safari blocks requestFullscreen in iframes and on non-video elements. The HMR WebSocket "The operation was aborted" error is a Node.js stream abort, not a real app error.
