---
name: Socket.IO kick/ban cross-socket access
description: How to find and emit to a specific socket by member ID
---

## Rule
When you need to find a specific socket by member ID (for kick/ban/promote), you MUST use `socket.data` — not closure variables.

**Why:** `io.in(room).fetchSockets()` returns proxy objects. Closure vars (`currentMemberId`) are NOT accessible on these proxies. Only `socket.data` is shared across the proxy boundary.

**How to apply:**
- On joinRoom: `socket.data.memberId = member.id; socket.data.role = member.role; socket.data.roomCode = roomCode;`
- In kick/ban/promote loops: `if (s.data.memberId === targetId) { s.emit("kicked"); s.leave(room); }`
- For promote: also do `s.data.role = newRole; s.emit("roleUpdated", { role: newRole });`
