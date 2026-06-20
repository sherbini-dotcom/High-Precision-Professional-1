import { Router } from "express";
import type { IRouter } from "express";
import { eq, and } from "drizzle-orm";
import rateLimit from "express-rate-limit";
import {
  db,
  roomsTable,
  membersTable,
  bansTable,
  roomVideosTable,
} from "@workspace/db";
import { generateRoomCode, getClientIp } from "../lib/roomCode";
import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcryptjs";
import {
  CreateRoomBody,
  JoinRoomBody,
  GetRoomParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

// ─── Rate limiters ────────────────────────────────────────────────────────────
const joinLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  keyGenerator: (req) => {
    const body = req.body as { sessionToken?: unknown };
    const token = body?.sessionToken;
    if (token && typeof token === "string" && token.length > 10) {
      return `tok:${token}`;
    }
    return getClientIp(req as Parameters<typeof getClientIp>[0]) || req.ip || "unknown";
  },
  message: { error: "Too many join attempts, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

const createRoomLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  message: { error: "Too many room creation attempts, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

const getRoomLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

// ─── Room & Video in-memory cache ─────────────────────────────────────────────
type RoomRow = { id: number; code: string; name: string; passwordHash: string | null; isPrivate: boolean; createdAt: Date };
type VideoRow = { status: string; originalName: string } | null;

interface CacheEntry<T> { value: T; expiresAt: number }

const roomCache  = new Map<string, CacheEntry<RoomRow>>();
const videoCache = new Map<number, CacheEntry<VideoRow>>();
const banCache   = new Map<string, CacheEntry<boolean>>();

const ROOM_CACHE_TTL  = 30_000;
const VIDEO_CACHE_TTL = 10_000;
const BAN_CACHE_TTL   = 60_000;

function getCachedRoom(code: string): RoomRow | null {
  const e = roomCache.get(code);
  if (e && e.expiresAt > Date.now()) return e.value;
  return null;
}

function setCachedRoom(room: RoomRow) {
  roomCache.set(room.code, { value: room, expiresAt: Date.now() + ROOM_CACHE_TTL });
}

export function invalidateRoomCache(code: string) {
  roomCache.delete(code);
}

export async function getRoom(code: string): Promise<RoomRow | null> {
  const cached = getCachedRoom(code);
  if (cached) return cached;
  const [room] = await db.select().from(roomsTable).where(eq(roomsTable.code, code));
  if (room) setCachedRoom(room as RoomRow);
  return (room as RoomRow) ?? null;
}

async function getVideo(roomId: number): Promise<VideoRow> {
  const e = videoCache.get(roomId);
  if (e && e.expiresAt > Date.now()) return e.value;
  const [video] = await db.select().from(roomVideosTable).where(eq(roomVideosTable.roomId, roomId)).limit(1);
  const value: VideoRow = video ? { status: video.status, originalName: video.originalName } : null;
  videoCache.set(roomId, { value, expiresAt: Date.now() + VIDEO_CACHE_TTL });
  return value;
}

async function isUserBanned(roomId: number, ip: string): Promise<boolean> {
  const key = `${roomId}:${ip}`;
  const e = banCache.get(key);
  if (e && e.expiresAt > Date.now()) return e.value;
  const [ban] = await db
    .select()
    .from(bansTable)
    .where(and(eq(bansTable.roomId, roomId), eq(bansTable.ip, ip)));
  const banned = !!ban;
  banCache.set(key, { value: banned, expiresAt: Date.now() + BAN_CACHE_TTL });
  return banned;
}

export function invalidateBanCache(roomId: number, ip: string) {
  banCache.delete(`${roomId}:${ip}`);
}

// ─── Name sanitization ────────────────────────────────────────────────────────
function sanitizeName(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[\x00-\x1F\x7F]/g, "")
    .replace(/[<>"'`&]/g, "")
    .replace(/\bon\w+\s*=/gi, "")
    .replace(/javascript\s*:/gi, "")
    .trim()
    .slice(0, 50);
}

function isValidName(name: string): boolean {
  if (!name || name.length < 1 || name.length > 50) return false;
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(name)) return false;
  if (/^\s+$/.test(name)) return false;
  if (/['";]/.test(name)) return false;
  if (/\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|ALTER|EXEC|CAST|CHAR|DECLARE)\b/i.test(name)) return false;
  if (/\.\.\/|\.\.\\/.test(name)) return false;
  if (/\$\{|\{\{|<%/.test(name)) return false;
  return true;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

router.post("/rooms", createRoomLimiter, async (req, res): Promise<void> => {
  const parsed = CreateRoomBody.safeParse(req.body);
  if (!parsed.success) {
    // [FIX H-03] رسالة عامة — لا تُكشف تفاصيل Zod للمستخدم في Production
    res.status(400).json({ error: "Invalid request data" });
    return;
  }
  const { roomName: rawRoomName, hostName: rawHostName, password } = parsed.data;

  const roomName = sanitizeName(rawRoomName);
  const hostName = sanitizeName(rawHostName);

  if (!roomName || !hostName) {
    res.status(400).json({ error: "Invalid name: contains forbidden characters" });
    return;
  }

  if (!isValidName(roomName) || !isValidName(hostName)) {
    res.status(400).json({ error: "Invalid name format" });
    return;
  }

  let code = generateRoomCode();
  for (let i = 0; i < 10; i++) {
    const [existing] = await db.select().from(roomsTable).where(eq(roomsTable.code, code));
    if (!existing) break;
    code = generateRoomCode();
  }

  const passwordHash = password ? await bcrypt.hash(password, 8) : null;
  const [room] = await db.insert(roomsTable).values({ code, name: roomName, passwordHash }).returning();
  const sessionToken = uuidv4();
  const ip = getClientIp(req as Parameters<typeof getClientIp>[0]);
  const [member] = await db
    .insert(membersTable)
    .values({ roomId: room.id, name: hostName, role: "host", ip, sessionToken, isMuted: false, isOnline: false })
    .returning();

  res.status(201).json({
    room: {
      id: room.id, code: room.code, name: room.name,
      hasPassword: !!room.passwordHash, videoStatus: null, videoName: null, createdAt: room.createdAt,
    },
    member: { id: member.id, roomId: member.roomId, name: member.name, role: member.role, isMuted: member.isMuted, joinedAt: member.joinedAt },
    sessionToken,
  });
});

router.post("/rooms/join", joinLimiter, async (req, res): Promise<void> => {
  const parsed = JoinRoomBody.safeParse(req.body);
  if (!parsed.success) {
    // [FIX H-03] رسالة عامة — لا تُكشف تفاصيل Zod
    res.status(400).json({ error: "Invalid request data" });
    return;
  }
  const { code, name: rawName, password } = parsed.data;
  const ip = getClientIp(req as Parameters<typeof getClientIp>[0]);

  const name = sanitizeName(rawName);
  if (!name) {
    res.status(400).json({ error: "Invalid name: contains forbidden characters" });
    return;
  }

  if (!isValidName(name)) {
    res.status(400).json({ error: "Invalid name format" });
    return;
  }

  const room = await getRoom(code.toUpperCase());
  if (!room) { res.status(404).json({ error: "Room not found" }); return; }

  const allMembers = await db.select({ id: membersTable.id }).from(membersTable).where(eq(membersTable.roomId, room.id));
  if (allMembers.length >= 200) {
    res.status(400).json({ error: "Room is full" });
    return;
  }

  if (await isUserBanned(room.id, ip)) {
    res.status(400).json({ error: "You are banned from this room" });
    return;
  }

  if (room.isPrivate) {
    res.status(403).json({ error: "This room is private. No new members can join." });
    return;
  }

  if (room.passwordHash && !password) {
    res.status(400).json({ error: "Password required" });
    return;
  }
  if (room.passwordHash && password) {
    const valid = await bcrypt.compare(password, room.passwordHash);
    if (!valid) { res.status(400).json({ error: "Incorrect password" }); return; }
  }

  const { sessionToken: existingToken } = parsed.data as {
    code: string; name: string; password?: string | null; sessionToken?: string | null;
  };
  let member;
  let sessionToken: string;

  if (existingToken) {
    const [existingByToken] = await db
      .select()
      .from(membersTable)
      .where(and(eq(membersTable.roomId, room.id), eq(membersTable.sessionToken, existingToken)));
    if (existingByToken) {
      sessionToken = existingByToken.sessionToken;
      member = existingByToken;
    } else {
      sessionToken = uuidv4();
      const [m] = await db
        .insert(membersTable)
        .values({ roomId: room.id, name, role: "guest", ip, sessionToken, isMuted: false, isOnline: false })
        .returning();
      member = m;
    }
  } else {
    sessionToken = uuidv4();
    const [m] = await db
      .insert(membersTable)
      .values({ roomId: room.id, name, role: "guest", ip, sessionToken, isMuted: false, isOnline: false })
      .returning();
    member = m;
  }

  const video = await getVideo(room.id);

  res.json({
    room: {
      id: room.id, code: room.code, name: room.name,
      hasPassword: !!room.passwordHash,
      videoStatus: video?.status ?? null,
      videoName: video?.originalName ?? null,
      createdAt: room.createdAt,
    },
    member: { id: member.id, roomId: member.roomId, name: member.name, role: member.role, isMuted: member.isMuted, joinedAt: member.joinedAt },
    sessionToken,
  });
});

router.get("/rooms/:code", getRoomLimiter, async (req, res): Promise<void> => {
  const params = GetRoomParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid code" }); return; }

  const room = await getRoom(params.data.code.toUpperCase());
  if (!room) { res.status(404).json({ error: "Room not found" }); return; }

  res.json({ id: room.id, code: room.code, name: room.name, hasPassword: !!room.passwordHash, isPrivate: room.isPrivate ?? false, createdAt: room.createdAt });
});

router.put("/rooms/:code/privacy", async (req, res): Promise<void> => {
  const code = (req.params.code as string).toUpperCase();
  const sessionToken = req.headers["x-session-token"] as string | undefined;
  const { isPrivate } = req.body as { isPrivate?: unknown };

  if (!sessionToken) { res.status(401).json({ error: "Missing session token" }); return; }
  if (typeof isPrivate !== "boolean") { res.status(400).json({ error: "isPrivate must be a boolean" }); return; }

  const room = await getRoom(code);
  if (!room) { res.status(404).json({ error: "Room not found" }); return; }

  const [member] = await db
    .select()
    .from(membersTable)
    .where(and(eq(membersTable.roomId, room.id), eq(membersTable.sessionToken, sessionToken)));

  if (!member || member.role !== "host") {
    res.status(403).json({ error: "Only the host can change room privacy" });
    return;
  }

  await db.update(roomsTable).set({ isPrivate }).where(eq(roomsTable.id, room.id));
  invalidateRoomCache(code);
  res.status(204).end();
});

export default router;
