---
name: Role update after promote via Socket.IO
description: Pattern to ensure promoted members can immediately use admin/host controls without page refresh
---

## Rule
When the host promotes a member, the target client's role in localStorage must be updated live — don't rely on page refresh.

**How to apply:**
1. Backend (promoteMember): after DB update + membersUpdate broadcast, iterate fetchSockets() to find target, set `s.data.role = role`, emit `s.emit("roleUpdated", { role })`
2. Frontend: listen for `roleUpdated` → `setMyRole(role)` + `saveSession(code, token, role, name, id)`
3. `isPrivileged` must be derived from the state var `myRole`, NOT from `session?.role` (which is stale localStorage)
