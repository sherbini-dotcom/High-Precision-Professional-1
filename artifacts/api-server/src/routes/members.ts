import { Router } from "express";
import type { IRouter } from "express";
import { eq, and } from "drizzle-orm";
import rateLimit from "express-rate-limit";
import { db, membersTable } from "@workspace/db";
import { getRoom } from "./rooms";
import {
  ListMembersParams,
  SetMemberRoleParams,
  SetMemberRoleBody,
  ToggleMuteMemberParams,
  ToggleMuteMemberBody,
  KickMemberParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

// Max 30 member-management actions per IP per minute (role change, mute, kick).
const memberActionLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  message: { error: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

router.get("/rooms/:code/members", async (req, res): Promise<void> => {
  const params = ListMembersParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }

  // Fix: require a valid session token — prevents unauthenticated member enumeration
  const sessionToken = req.headers["x-session-token"] as string | undefined;
  if (!sessionToken) {
    res.status(401).json({ error: "Session token required" });
    return;
  }

  // Use room cache instead of a direct DB query.
  const room = await getRoom(params.data.code.toUpperCase());
  if (!room) { res.status(404).json({ error: "Room not found" }); return; }

  // Verify the token belongs to a member of this room
  const [requester] = await db
    .select()
    .from(membersTable)
    .where(and(eq(membersTable.sessionToken, sessionToken), eq(membersTable.roomId, room.id)));
  if (!requester) {
    res.status(403).json({ error: "Not a member of this room" });
    return;
  }

  const members = await db.select().from(membersTable).where(eq(membersTable.roomId, room.id));
  res.json(members.map(m => ({ id: m.id, roomId: m.roomId, name: m.name, role: m.role, isMuted: m.isMuted, joinedAt: m.joinedAt })));
});

router.put("/rooms/:code/members/:memberId/role", memberActionLimiter, async (req, res): Promise<void> => {
  const params = SetMemberRoleParams.safeParse(req.params);
  const body = SetMemberRoleBody.safeParse(req.body);
  if (!params.success || !body.success) { res.status(400).json({ error: "Invalid params" }); return; }

  const sessionToken = req.headers["x-session-token"] as string | undefined;
  if (!sessionToken) { res.status(403).json({ error: "No session token" }); return; }

  // Use room cache instead of a direct DB query.
  const room = await getRoom(params.data.code.toUpperCase());
  if (!room) { res.status(404).json({ error: "Room not found" }); return; }

  const [requester] = await db.select().from(membersTable).where(and(eq(membersTable.sessionToken, sessionToken), eq(membersTable.roomId, room.id)));
  if (!requester || requester.role !== "host") { res.status(403).json({ error: "Only host can change roles" }); return; }

  const memberId = parseInt(req.params.memberId as string, 10);
  const [updated] = await db.update(membersTable).set({ role: body.data.role }).where(and(eq(membersTable.id, memberId), eq(membersTable.roomId, room.id))).returning();
  if (!updated) { res.status(404).json({ error: "Member not found" }); return; }
  res.json({ id: updated.id, roomId: updated.roomId, name: updated.name, role: updated.role, isMuted: updated.isMuted, joinedAt: updated.joinedAt });
});

router.post("/rooms/:code/members/:memberId/mute", memberActionLimiter, async (req, res): Promise<void> => {
  const params = ToggleMuteMemberParams.safeParse(req.params);
  const body = ToggleMuteMemberBody.safeParse(req.body);
  if (!params.success || !body.success) { res.status(400).json({ error: "Invalid params" }); return; }

  const sessionToken = req.headers["x-session-token"] as string | undefined;
  if (!sessionToken) { res.status(403).json({ error: "No session token" }); return; }

  // Use room cache instead of a direct DB query.
  const room = await getRoom(params.data.code.toUpperCase());
  if (!room) { res.status(404).json({ error: "Room not found" }); return; }

  const [requester] = await db.select().from(membersTable).where(and(eq(membersTable.sessionToken, sessionToken), eq(membersTable.roomId, room.id)));
  if (!requester || (requester.role !== "host" && requester.role !== "admin")) { res.status(403).json({ error: "Insufficient permissions" }); return; }

  const memberId = parseInt(req.params.memberId as string, 10);
  const [updated] = await db.update(membersTable).set({ isMuted: body.data.isMuted }).where(and(eq(membersTable.id, memberId), eq(membersTable.roomId, room.id))).returning();
  if (!updated) { res.status(404).json({ error: "Member not found" }); return; }
  res.json({ id: updated.id, roomId: updated.roomId, name: updated.name, role: updated.role, isMuted: updated.isMuted, joinedAt: updated.joinedAt });
});

router.delete("/rooms/:code/members/:memberId", memberActionLimiter, async (req, res): Promise<void> => {
  const params = KickMemberParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }

  const sessionToken = req.headers["x-session-token"] as string | undefined;
  if (!sessionToken) { res.status(403).json({ error: "No session token" }); return; }

  // Use room cache instead of a direct DB query.
  const room = await getRoom(params.data.code.toUpperCase());
  if (!room) { res.status(404).json({ error: "Room not found" }); return; }

  const [requester] = await db.select().from(membersTable).where(and(eq(membersTable.sessionToken, sessionToken), eq(membersTable.roomId, room.id)));
  if (!requester || (requester.role !== "host" && requester.role !== "admin")) { res.status(403).json({ error: "Insufficient permissions" }); return; }

  const memberId = parseInt(req.params.memberId as string, 10);
  await db.delete(membersTable).where(and(eq(membersTable.id, memberId), eq(membersTable.roomId, room.id)));
  res.sendStatus(204);
});

export default router;
