import { Router } from "express";
import type { IRouter } from "express";
import { db, membersTable, roomsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

const router: IRouter = Router();

// Support multiple API keys:
//   HYPERBEAM_API_KEYS = "key1,key2,key3"  (comma-separated, tried in order)
//   HYPERBEAM_API_KEY  = "key1"            (single key fallback)
// Both can coexist — all keys are collected and tried until one works.
function getApiKeys(): string[] {
  const keys: string[] = [];
  const multi = process.env.HYPERBEAM_API_KEYS;
  if (multi)
    keys.push(
      ...multi
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean),
    );
  const single = process.env.HYPERBEAM_API_KEY;
  if (single && !keys.includes(single.trim())) keys.push(single.trim());
  return keys;
}

let keyIndex = 0;

// store session_id + which key was used per room so DELETE uses the same key
const roomSessions = new Map<string, { sessionId: string; apiKey: string }>();

router.post("/rooms/:code/hyperbeam", async (req, res): Promise<void> => {
  const keys = getApiKeys();
  if (!keys.length) {
    res.status(503).json({
      error:
        "Hyperbeam not configured. Add HYPERBEAM_API_KEY or HYPERBEAM_API_KEYS to environment variables.",
    });
    return;
  }

  const sessionToken = req.headers["x-session-token"] as string;
  if (!sessionToken) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { code } = req.params;
  const [room] = await db
    .select()
    .from(roomsTable)
    .where(eq(roomsTable.code, code.toUpperCase()));
  if (!room) {
    res.status(404).json({ error: "Room not found" });
    return;
  }

  const [member] = await db
    .select()
    .from(membersTable)
    .where(
      and(
        eq(membersTable.roomId, room.id),
        eq(membersTable.sessionToken, sessionToken),
      ),
    );
  if (!member || (member.role !== "host" && member.role !== "admin")) {
    res
      .status(403)
      .json({ error: "Only host/admin can start browser session" });
    return;
  }

  // If a session already exists for this room, terminate it first before starting a new one
  const existingSession = roomSessions.get(code.toUpperCase());
  if (existingSession) {
    try {
      await fetch(`https://engine.hyperbeam.com/v0/vm/${existingSession.sessionId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${existingSession.apiKey}` },
      });
    } catch { /* ignore */ }
    roomSessions.delete(code.toUpperCase());
  }

  // Try each key starting from the current index (round-robin across sessions)
  let lastError = "";
  for (let i = 0; i < keys.length; i++) {
    const tryKey = keys[(keyIndex + i) % keys.length];
    const response = await fetch("https://engine.hyperbeam.com/v0/vm", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tryKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        start_url: "https://www.google.com",
        offline_timeout: 3600,
      }),
    });

    if (response.ok) {
      const data = (await response.json()) as {
        session_id: string;
        embed_url: string;
        admin_token: string;
      };
      roomSessions.set(code.toUpperCase(), {
        sessionId: data.session_id,
        apiKey: tryKey,
      });
      keyIndex = (keyIndex + i + 1) % keys.length; // advance for next session
      res.json({
        sessionId: data.session_id,
        embedUrl: data.embed_url,
        adminToken: data.admin_token,
      });
      return;
    }

    lastError = await response.text();
  }

  res.status(502).json({ error: `Hyperbeam API error: ${lastError}` });
});

router.delete("/rooms/:code/hyperbeam", async (req, res): Promise<void> => {
  const sessionToken = req.headers["x-session-token"] as string;
  if (!sessionToken) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { code } = req.params;
  const upperCode = code.toUpperCase();

  const [room] = await db
    .select()
    .from(roomsTable)
    .where(eq(roomsTable.code, upperCode));
  if (!room) {
    res.status(404).json({ error: "Room not found" });
    return;
  }

  const [member] = await db
    .select()
    .from(membersTable)
    .where(
      and(
        eq(membersTable.roomId, room.id),
        eq(membersTable.sessionToken, sessionToken),
      ),
    );
  if (!member || (member.role !== "host" && member.role !== "admin")) {
    res.status(403).json({ error: "Only host/admin can end browser session" });
    return;
  }

  const session = roomSessions.get(upperCode);
  if (session) {
    try {
      await fetch(`https://engine.hyperbeam.com/v0/vm/${session.sessionId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.apiKey}` },
      });
    } catch {
      /* ignore — session may already be gone */
    }
    roomSessions.delete(upperCode);
  }

  res.status(204).send();
});

export { roomSessions };
export default router;