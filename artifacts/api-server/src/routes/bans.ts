import { Router } from "express";
import type { IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, bansTable, roomsTable, membersTable } from "@workspace/db";
import { ListBansParams, UnbanMemberParams } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/rooms/:code/bans", async (req, res): Promise<void> => {
  const params = ListBansParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }

  const sessionToken = req.headers["x-session-token"] as string | undefined;
  if (!sessionToken) { res.status(403).json({ error: "No session token" }); return; }

  const [room] = await db.select().from(roomsTable).where(eq(roomsTable.code, params.data.code.toUpperCase()));
  if (!room) { res.status(404).json({ error: "Room not found" }); return; }

  const [requester] = await db.select().from(membersTable).where(
    and(eq(membersTable.sessionToken, sessionToken), eq(membersTable.roomId, room.id))
  );
  if (!requester || (requester.role !== "host" && requester.role !== "admin")) {
    res.status(403).json({ error: "Insufficient permissions" }); return;
  }

  const bans = await db.select().from(bansTable).where(eq(bansTable.roomId, room.id));
  const members = await db.select().from(membersTable).where(eq(membersTable.roomId, room.id));

  // FIX #2: Build IP → name lookup from members table
  const ipToName: Record<string, string> = {};
  for (const m of members) {
    if (m.ip && !ipToName[m.ip]) ipToName[m.ip] = m.name;
  }

  // FIX #2: Deduplicate by IP — keep the latest ban per IP only
  const sorted = bans.sort((a, b) => new Date(b.bannedAt).getTime() - new Date(a.bannedAt).getTime());
  const seen = new Set<string>();
  const deduped = sorted.filter(b => {
    if (seen.has(b.ip)) return false;
    seen.add(b.ip);
    return true;
  });

  res.json(deduped.map(b => ({
    id: b.id,
    roomId: b.roomId,
    ip: b.ip,
    name: ipToName[b.ip] ?? "Unknown",   // member name shown in UI
    bannedBy: b.bannedBy,
    bannedAt: b.bannedAt,
  })));
});

router.delete("/rooms/:code/bans/:banId", async (req, res): Promise<void> => {
  const params = UnbanMemberParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }

  const sessionToken = req.headers["x-session-token"] as string | undefined;
  if (!sessionToken) { res.status(403).json({ error: "No session token" }); return; }

  const [room] = await db.select().from(roomsTable).where(eq(roomsTable.code, params.data.code.toUpperCase()));
  if (!room) { res.status(404).json({ error: "Room not found" }); return; }

  const [requester] = await db.select().from(membersTable).where(
    and(eq(membersTable.sessionToken, sessionToken), eq(membersTable.roomId, room.id))
  );
  if (!requester || requester.role !== "host") {
    res.status(403).json({ error: "Only host can unban" }); return;
  }

  const [ban] = await db
    .delete(bansTable)
    .where(and(eq(bansTable.id, params.data.banId), eq(bansTable.roomId, room.id)))
    .returning();
  if (!ban) { res.status(404).json({ error: "Ban not found" }); return; }
  res.sendStatus(204);
});

export default router;
