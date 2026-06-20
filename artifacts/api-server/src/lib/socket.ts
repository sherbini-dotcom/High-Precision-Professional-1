import { Server as SocketIOServer } from "socket.io";
import type { Server as HttpServer } from "http";
import { db } from "@workspace/db";
import {
  membersTable,
  roomsTable,
  bansTable,
  roomVideosTable,
} from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { logger } from "./logger";
import fs from "fs";
import path from "path";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");

function deleteRoomFiles(roomCode: string) {
  try {
    const dir = path.join(UPLOADS_DIR, roomCode);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    logger.error({ err, roomCode }, "Error deleting room upload files");
  }
}

async function deleteRoomFromDb(roomId: number) {
  await db.delete(roomVideosTable).where(eq(roomVideosTable.roomId, roomId));
  await db.delete(bansTable).where(eq(bansTable.roomId, roomId));
  await db.delete(membersTable).where(eq(membersTable.roomId, roomId));
  await db.delete(roomsTable).where(eq(roomsTable.id, roomId));
}

interface VideoTimeline {
  isPlaying: boolean;
  position: number;
  positionAt: number;
  seqNo: number;
}

function calcCurrentPosition(tl: VideoTimeline): number {
  if (!tl.isPlaying) return tl.position;
  return tl.position + (Date.now() - tl.positionAt) / 1000;
}

interface ChatEntry {
  memberId: number;
  name: string;
  message: string;
  timestamp: number;
  replyTo?: { memberId: number; name: string; message: string };
  whisperTo?: { memberId: number; name: string };
  voiceData?: string;
  imageData?: string;
}

const roomTimelines = new Map<string, VideoTimeline>();
const roomSyncIntervals = new Map<string, ReturnType<typeof setInterval>>();
const roomModes = new Map<string, "video" | "browser" | "screenshare" | "movies">();
const roomHyperbeamUrls = new Map<string, string>();
const kickedIPs = new Map<string, Set<string>>();
const pendingApprovals = new Map<
  string,
  Map<number, { name: string; socketId: string }>
>();
const roomChatHistory = new Map<string, ChatEntry[]>();
const roomAccessControl = new Map<string, boolean>();
const approvedMembers = new Map<string, Set<number>>();
const roomUploading = new Map<string, boolean>();
const roomSeekDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

interface CineRoomState {
  selectedItem: unknown;
  view: "browse" | "player";
  contentType: "movie" | "tv";
  category: "popular" | "top_rated";
  searchQuery: string;
  season: number;
  episode: number;
  directUrl: string;
  subtitleUrl: string;
}
const DEFAULT_CINE_ROOM_STATE: CineRoomState = {
  view: "browse", contentType: "movie", category: "popular",
  searchQuery: "", selectedItem: null, season: 1, episode: 1,
  directUrl: "", subtitleUrl: "",
};
const roomCineStates = new Map<string, CineRoomState>();
const socketDriftMap = new Map<string, { samples: number[]; reportedAt: number }>();
const socketEventTimestamps = new Map<string, number[]>();
const noPrivilegedTimers = new Map<string, ReturnType<typeof setTimeout>>();
const NO_PRIVILEGED_GRACE_MS = 2 * 60 * 1000;
const roomCodeToId = new Map<string, number>();
const roomMembersUpdateTimers = new Map<string, ReturnType<typeof setTimeout>>();
const roomPendingDisconnects = new Map<string, Set<number>>();
const roomDisconnectBatchTimers = new Map<string, ReturnType<typeof setTimeout>>();

type MemberRow = typeof membersTable.$inferSelect;
const roomOnlineCache = new Map<string, Map<number, MemberRow>>();
const roomJoinUpdateTimers = new Map<string, ReturnType<typeof setTimeout>>();

function getCachedOnlineMembers(roomCode: string): MemberRow[] {
  return Array.from(roomOnlineCache.get(roomCode)?.values() ?? []);
}

function sanitizeMember(m: MemberRow) {
  const { ip: _ip, sessionToken: _st, ...safe } = m;
  return safe;
}

const LARGE_ROOM_THRESHOLD   = 100;
const LARGE_ROOM_MEMBER_CAP  = 30;
const LARGE_ROOM_HISTORY_CAP = 10;

function isLargeRoom(roomCode: string): boolean {
  return getCachedOnlineMembers(roomCode).length > LARGE_ROOM_THRESHOLD;
}

function getMembersPayload(roomCode: string) {
  const all = getCachedOnlineMembers(roomCode).map(sanitizeMember);
  if (all.length <= LARGE_ROOM_THRESHOLD) return all;
  const privileged = all.filter((m) => m.role === "host" || m.role === "admin");
  const rest       = all.filter((m) => m.role !== "host" && m.role !== "admin");
  return [...privileged, ...rest].slice(0, LARGE_ROOM_MEMBER_CAP);
}

function getSafeOnlineMembers(roomCode: string) {
  return getCachedOnlineMembers(roomCode).map(sanitizeMember);
}

function addToOnlineCache(roomCode: string, member: MemberRow) {
  if (!roomOnlineCache.has(roomCode)) roomOnlineCache.set(roomCode, new Map());
  roomOnlineCache.get(roomCode)!.set(member.id, { ...member, isOnline: true });
}

function removeFromOnlineCache(roomCode: string, memberId: number) {
  roomOnlineCache.get(roomCode)?.delete(memberId);
  if (roomOnlineCache.get(roomCode)?.size === 0) roomOnlineCache.delete(roomCode);
}

function scheduleRoomMembersUpdateOnJoin(roomCode: string): void {
  const existing = roomJoinUpdateTimers.get(roomCode);
  if (existing !== undefined) clearTimeout(existing);
  const delay = isLargeRoom(roomCode) ? 2_000 : 300;
  const t = setTimeout(() => {
    roomJoinUpdateTimers.delete(roomCode);
    if (!ioInstance) return;
    const members = getMembersPayload(roomCode);
    if (members.length > 0) {
      ioInstance.to(roomCode).emit("membersUpdate", members);
    }
  }, delay);
  roomJoinUpdateTimers.set(roomCode, t);
}

function onlineMembers(allMembers: { isOnline: boolean }[]) {
  return allMembers.filter((m) => m.isOnline);
}

let ioInstance: SocketIOServer | null = null;

function startPeriodicSync(roomCode: string) {
  if (roomSyncIntervals.has(roomCode) || !ioInstance) return;
  const id = setInterval(() => {
    const tl = roomTimelines.get(roomCode);
    if (!tl || !tl.isPlaying || !ioInstance) return;
    const livePos = calcCurrentPosition(tl);
    ioInstance.to(roomCode).emit("syncState", {
      isPlaying: true,
      position: livePos,
      positionAt: Date.now(),
      seqNo: tl.seqNo,
      isDriftCorrection: true,
    });
  }, 3000);
  roomSyncIntervals.set(roomCode, id);
}

function stopPeriodicSync(roomCode: string) {
  const id = roomSyncIntervals.get(roomCode);
  if (id !== undefined) {
    clearInterval(id);
    roomSyncIntervals.delete(roomCode);
  }
}

function cancelNoPrivilegedTimer(roomCode: string) {
  const t = noPrivilegedTimers.get(roomCode);
  if (t !== undefined) {
    clearTimeout(t);
    noPrivilegedTimers.delete(roomCode);
  }
}

function isSocketRateLimited(socketId: string, event: string, maxPerSecond: number): boolean {
  const key = `${socketId}:${event}`;
  const now = Date.now();
  const times = (socketEventTimestamps.get(key) ?? []).filter(t => now - t < 1000);
  if (times.length >= maxPerSecond) return true;
  times.push(now);
  socketEventTimestamps.set(key, times);
  return false;
}

function clearRoomState(roomCode: string) {
  cancelNoPrivilegedTimer(roomCode);
  stopPeriodicSync(roomCode);
  roomTimelines.delete(roomCode);
  roomModes.delete(roomCode);
  roomHyperbeamUrls.delete(roomCode);
  kickedIPs.delete(roomCode);
  pendingApprovals.delete(roomCode);
  roomChatHistory.delete(roomCode);
  roomAccessControl.delete(roomCode);
  approvedMembers.delete(roomCode);
  roomUploading.delete(roomCode);
  roomCineStates.delete(roomCode);
  roomCodeToId.delete(roomCode);
  roomOnlineCache.delete(roomCode);
  roomPendingDisconnects.delete(roomCode);
  const mbt = roomMembersUpdateTimers.get(roomCode);
  if (mbt !== undefined) { clearTimeout(mbt); roomMembersUpdateTimers.delete(roomCode); }
  const jbt = roomJoinUpdateTimers.get(roomCode);
  if (jbt !== undefined) { clearTimeout(jbt); roomJoinUpdateTimers.delete(roomCode); }
  const dbt = roomDisconnectBatchTimers.get(roomCode);
  if (dbt !== undefined) { clearTimeout(dbt); roomDisconnectBatchTimers.delete(roomCode); }
  const sdt = roomSeekDebounceTimers.get(roomCode);
  if (sdt !== undefined) { clearTimeout(sdt); roomSeekDebounceTimers.delete(roomCode); }
}

function scheduleDisconnectBatch(roomCode: string, memberId: number): void {
  if (!roomPendingDisconnects.has(roomCode)) {
    roomPendingDisconnects.set(roomCode, new Set());
  }
  roomPendingDisconnects.get(roomCode)!.add(memberId);

  const existing = roomDisconnectBatchTimers.get(roomCode);
  if (existing !== undefined) clearTimeout(existing);

  const t = setTimeout(async () => {
    roomDisconnectBatchTimers.delete(roomCode);
    const memberIds = Array.from(roomPendingDisconnects.get(roomCode) ?? []);
    roomPendingDisconnects.delete(roomCode);
    if (!ioInstance || memberIds.length === 0) return;

    try {
      if (memberIds.length > 0) {
        await db
          .update(membersTable)
          .set({ isOnline: false })
          .where(inArray(membersTable.id, memberIds));
      }

      for (const id of memberIds) {
        ioInstance.to(roomCode).emit("memberRemoved", { memberId: id });
      }

      ioInstance.to(roomCode).emit("membersUpdate", getMembersPayload(roomCode));

      const remaining = getCachedOnlineMembers(roomCode);
      const hasPrivileged = remaining.some(
        (m) => m.role === "host" || m.role === "admin",
      );
      if (!hasPrivileged && !noPrivilegedTimers.has(roomCode)) {
        logger.info({ roomCode }, `No host/admin — scheduling deletion in ${NO_PRIVILEGED_GRACE_MS / 1000}s`);
        const timer = setTimeout(async () => {
          noPrivilegedTimers.delete(roomCode);
          try {
            const [liveRoom] = await db.select().from(roomsTable).where(eq(roomsTable.code, roomCode));
            if (!liveRoom) return;
            const liveMembers = await db.select().from(membersTable).where(eq(membersTable.roomId, liveRoom.id));
            const liveOnline = onlineMembers(liveMembers);
            if (!liveOnline.some((m) => (m as unknown as { role: string }).role === "host" || (m as unknown as { role: string }).role === "admin")) {
              ioInstance?.to(roomCode).emit("roomClosed");
              const sockets = await ioInstance?.in(roomCode).fetchSockets() ?? [];
              for (const s of sockets) s.leave(roomCode);
              clearRoomState(roomCode);
              await deleteRoomFromDb(liveRoom.id);
              deleteRoomFiles(roomCode);
              logger.info({ roomCode }, "Auto-deleted room: no host/admin for grace period");
            }
          } catch (err) {
            logger.error({ err, roomCode }, "Error in no-privileged grace-period delete");
          }
        }, NO_PRIVILEGED_GRACE_MS);
        noPrivilegedTimers.set(roomCode, timer);
      } else if (hasPrivileged) {
        cancelNoPrivilegedTimer(roomCode);
      }
    } catch (err) {
      logger.error({ err }, "Error in disconnect batch");
    }
  }, 150);
  roomDisconnectBatchTimers.set(roomCode, t);
}

function scheduleRoomMembersUpdate(roomCode: string): void {
  const existing = roomMembersUpdateTimers.get(roomCode);
  if (existing !== undefined) clearTimeout(existing);
  const t = setTimeout(async () => {
    roomMembersUpdateTimers.delete(roomCode);
    if (!ioInstance) return;
    const roomId = roomCodeToId.get(roomCode);
    if (roomId === undefined) return;
    try {
      const allMembers = await db
        .select()
        .from(membersTable)
        .where(eq(membersTable.roomId, roomId));
      const allOnline = onlineMembers(allMembers).map(sanitizeMember);
      const onlineCount = allOnline.length;
      const stillOnline = onlineCount > LARGE_ROOM_THRESHOLD
        ? [...allOnline.filter((m) => m.role === "host" || m.role === "admin"), ...allOnline.filter((m) => m.role !== "host" && m.role !== "admin")].slice(0, LARGE_ROOM_MEMBER_CAP)
        : allOnline;
      ioInstance.to(roomCode).emit("membersUpdate", stillOnline);

      const hasPrivileged = stillOnline.some(
        (m) => (m as unknown as { role: string }).role === "host" ||
               (m as unknown as { role: string }).role === "admin",
      );
      if (!hasPrivileged && !noPrivilegedTimers.has(roomCode)) {
        logger.info(
          { roomCode },
          `No host/admin online — scheduling room deletion in ${NO_PRIVILEGED_GRACE_MS / 1000}s`,
        );
        const timer = setTimeout(async () => {
          noPrivilegedTimers.delete(roomCode);
          try {
            const [liveRoom] = await db
              .select()
              .from(roomsTable)
              .where(eq(roomsTable.code, roomCode));
            if (!liveRoom) return;
            const liveMembers = await db
              .select()
              .from(membersTable)
              .where(eq(membersTable.roomId, liveRoom.id));
            const liveOnline = onlineMembers(liveMembers);
            const stillNoPrivileged = !liveOnline.some(
              (m) => (m as unknown as { role: string }).role === "host" ||
                     (m as unknown as { role: string }).role === "admin",
            );
            if (stillNoPrivileged) {
              ioInstance?.to(roomCode).emit("roomClosed");
              const sockets = await ioInstance?.in(roomCode).fetchSockets() ?? [];
              for (const s of sockets) s.leave(roomCode);
              clearRoomState(roomCode);
              await deleteRoomFromDb(liveRoom.id);
              deleteRoomFiles(roomCode);
              logger.info({ roomCode }, "Auto-deleted room: no host/admin for grace period");
            }
          } catch (err) {
            logger.error({ err, roomCode }, "Error in no-privileged grace-period delete");
          }
        }, NO_PRIVILEGED_GRACE_MS);
        noPrivilegedTimers.set(roomCode, timer);
      } else if (hasPrivileged) {
        cancelNoPrivilegedTimer(roomCode);
      }
    } catch (err) {
      logger.error({ err }, "Error in scheduleRoomMembersUpdate");
    }
  }, 150);
  roomMembersUpdateTimers.set(roomCode, t);
}

function emitSyncStateTo(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  socket: { emit: (ev: string, data: any) => void },
  roomCode: string,
) {
  const tl = roomTimelines.get(roomCode);
  if (!tl) return;
  const livePos = calcCurrentPosition(tl);
  socket.emit("syncState", {
    isPlaying: tl.isPlaying,
    position: livePos,
    positionAt: Date.now(),
    seqNo: tl.seqNo,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function burstSyncTo(socket: { connected: boolean; emit: (ev: string, data: any) => void }, roomCode: string): void {
  const delays = [500, 1500];
  for (const ms of delays) {
    setTimeout(() => {
      const tl = roomTimelines.get(roomCode);
      if (!tl || !socket.connected) return;
      socket.emit("syncState", {
        isPlaying: tl.isPlaying,
        position: calcCurrentPosition(tl),
        positionAt: Date.now(),
        seqNo: tl.seqNo,
      });
    }, ms);
  }
}

export function setupSocketIO(httpServer: HttpServer): SocketIOServer {
  const allowedOrigin = process.env.CORS_ORIGIN ?? "";

  const corsOrigin = allowedOrigin
    ? (
        requestOrigin: string | undefined,
        callback: (err: Error | null, allow?: boolean) => void,
      ) => {
        if (!requestOrigin) return callback(null, true);
        if (requestOrigin === allowedOrigin) return callback(null, true);
        if (
          requestOrigin.endsWith(".replit.dev") ||
          requestOrigin.endsWith(".replit.app")
        )
          return callback(null, true);
        callback(new Error("Not allowed by CORS"));
      }
    : "*";

  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: corsOrigin,
      methods: ["GET", "POST"],
      credentials: true,
    },
    transports: ["websocket", "polling"],
    pingInterval: 10000,
    pingTimeout: 5000,
  });

  ioInstance = io;

  // ─── Connection Rate Limiting ─────────────────────────────────────────────────
  // SEC-FIX C-01: منع فتح آلاف الاتصالات من نفس الـ IP (Denial-of-Service)
  const connectionTimestamps = new Map<string, number[]>();
  io.use((socket, next) => {
    const ip = socket.handshake.address;
    const now = Date.now();
    const times = (connectionTimestamps.get(ip) ?? []).filter(t => now - t < 60_000);
    if (times.length >= 30) {
      return next(new Error("Too many connections"));
    }
    times.push(now);
    connectionTimestamps.set(ip, times);
    next();
  });

  // ─── Auth Middleware ──────────────────────────────────────────────────────────
  io.use(async (socket, next) => {
    const { sessionToken, roomCode } = (socket.handshake.auth ?? {}) as {
      sessionToken?: string;
      roomCode?: string;
    };

    if (!sessionToken || !roomCode) return next();

    try {
      const [room] = await db
        .select()
        .from(roomsTable)
        // FIX: استخدام toUpperCase() بشكل متسق مع routes HTTP
        .where(eq(roomsTable.code, roomCode.toUpperCase()));

      if (!room) {
        return next(new Error("Room not found"));
      }

      const [member] = await db
        .select()
        .from(membersTable)
        .where(
          and(
            eq(membersTable.sessionToken, sessionToken),
            eq(membersTable.roomId, room.id),
          ),
        );

      if (!member) {
        return next(new Error("Invalid session token"));
      }

      socket.data.preVerifiedMemberId = member.id;
      socket.data.preVerifiedRole     = member.role;
      socket.data.preVerifiedRoomCode = roomCode.toUpperCase();
      next();
    } catch (err) {
      logger.error({ err }, "Auth middleware error");
      next(new Error("Auth check failed"));
    }
  });

  io.on("connection", (socket) => {
    let currentRoomCode: string | null = null;
    let currentMemberId: number | null = null;
    let currentRole: string | null = null;
    let currentMemberName: string | null = null;

    socket.on(
      "joinRoom",
      async ({
        roomCode: rawRoomCode,
        sessionToken,
      }: {
        roomCode: string;
        sessionToken: string;
      }) => {
        try {
          // FIX VIDEO-SYNC: توحيد الـ roomCode بـ toUpperCase دايماً
          // ده يضمن إن host و guests يدخلوا نفس الـ socket.io room بالضبط
          // لو host بعت "ABC123" وguest بعت "abc123" → كانوا في rooms مختلفة!
          const roomCode = rawRoomCode.toUpperCase();

          const [room] = await db
            .select()
            .from(roomsTable)
            .where(eq(roomsTable.code, roomCode));
          if (!room) {
            socket.emit("error", { message: "Room not found" });
            return;
          }

          roomCodeToId.set(roomCode, room.id);

          const [member] = await db
            .select()
            .from(membersTable)
            .where(
              and(
                eq(membersTable.sessionToken, sessionToken),
                eq(membersTable.roomId, room.id),
              ),
            );
          if (!member) {
            socket.emit("error", { message: "Invalid session" });
            return;
          }

          const [ban] = await db
            .select()
            .from(bansTable)
            .where(
              and(eq(bansTable.roomId, room.id), eq(bansTable.ip, member.ip)),
            );
          if (ban) {
            socket.emit("banned");
            return;
          }

          // Block guests from joining when room is private
          if (room.isPrivate && member.role === "guest") {
            socket.emit("error", { message: "This room is private. No new members can join." });
            return;
          }

          currentRoomCode = roomCode;
          currentMemberId = member.id;
          currentRole = member.role;
          currentMemberName = member.name;

          socket.data.memberId = member.id;
          socket.data.role = member.role;
          socket.data.roomCode = roomCode;

          const roomKickedIPs = kickedIPs.get(roomCode);
          const accessControlOn = roomAccessControl.get(roomCode) ?? false;
          const alreadyApproved =
            approvedMembers.get(roomCode)?.has(member.id) ?? false;
          const needsApproval =
            roomKickedIPs?.has(member.ip) ||
            (accessControlOn && member.role === "guest" && !alreadyApproved);

          if (needsApproval) {
            const approvalMap = pendingApprovals.get(roomCode) ?? new Map();
            approvalMap.set(member.id, {
              name: member.name,
              socketId: socket.id,
            });
            pendingApprovals.set(roomCode, approvalMap);
            socket.emit("pendingApproval");
            const roomSockets = await io.in(roomCode).fetchSockets();
            for (const s of roomSockets) {
              if (s.data.role === "host" || s.data.role === "admin") {
                s.emit("joinRequest", {
                  memberId: member.id,
                  name: member.name,
                });
              }
            }
            return;
          }

          await db
            .update(membersTable)
            .set({ isOnline: true })
            .where(eq(membersTable.id, member.id));

          // FIX VIDEO-SYNC: إضافة await لـ socket.join
          // بدونها في بعض الـ adapters الـ socket مش بيكون في الغرفة فعلاً
          // قبل ما المعالجة تكمل → io.to(roomCode).emit() مش بيوصلوش
          await socket.join(roomCode);

          if (member.role === "host" || member.role === "admin") {
            cancelNoPrivilegedTimer(roomCode);
          }

          if (!roomOnlineCache.has(roomCode)) {
            const existing = await db
              .select()
              .from(membersTable)
              .where(and(eq(membersTable.roomId, room.id), eq(membersTable.isOnline, true)));
            roomOnlineCache.set(roomCode, new Map(existing.map((m: MemberRow) => [m.id, m])));
          }
          addToOnlineCache(roomCode, member);

          if (!isLargeRoom(roomCode)) {
            socket.emit("membersUpdate", getMembersPayload(roomCode));
          }

          const currentOnlineCount = getCachedOnlineMembers(roomCode).length;
          if (currentOnlineCount <= 50) {
            socket.to(roomCode).emit("memberJoined", sanitizeMember({ ...member, isOnline: true }));
            // FIX WEBRTC: إضافة socketId في peerJoined حتى يقدر الـ host يوجّه الإشارات
            // الكليان محتاج الـ socketId عشان يبعت webrtcSignal للشخص الصح
            socket.to(roomCode).emit("peerJoined", { memberId: member.id, socketId: socket.id });
          }

          scheduleRoomMembersUpdateOnJoin(roomCode);

          emitSyncStateTo(socket, roomCode);
          burstSyncTo(socket, roomCode);

          try {
            const roomSocketsForSync = await io.in(roomCode).fetchSockets();
            for (const s of roomSocketsForSync) {
              if (
                (s.data.role === "host" || s.data.role === "admin") &&
                s.id !== socket.id
              ) {
                s.emit("requestPositionUpdate");
                break;
              }
            }
          } catch { /* non-critical */ }

          if (roomUploading.get(roomCode)) {
            socket.emit("uploadLocked");
          }

          const currentMode = roomModes.get(roomCode);
          if (currentMode) socket.emit("modeChange", { mode: currentMode });

          if (currentMode === "movies") {
            const cineState = roomCineStates.get(roomCode);
            if (cineState) socket.emit("moviesSync", cineState);
          }

          const hyperbeamUrl = roomHyperbeamUrls.get(roomCode);
          if (hyperbeamUrl)
            socket.emit("hyperbeamSession", { embedUrl: hyperbeamUrl });

          const history = roomChatHistory.get(roomCode) ?? [];
          const large = isLargeRoom(roomCode);
          const historyCapped = large ? history.slice(-LARGE_ROOM_HISTORY_CAP) : history;
          const historyStripped = historyCapped.map(({ voiceData: _v, imageData: _i, ...rest }) => rest);
          socket.emit("chatHistory", historyStripped);

          socket.emit("accessControlChanged", {
            enabled: roomAccessControl.get(roomCode) ?? false,
          });

          logger.info(
            { roomCode, memberName: member.name, role: member.role },
            "Member joined socket room",
          );
        } catch (err) {
          logger.error({ err }, "Error in joinRoom socket event");
        }
      },
    );

    socket.on("clockSync", ({ t0 }: { t0: number }) => {
      socket.emit("clockSyncAck", { t0, t1: Date.now() });
    });

    socket.on(
      "videoControl",
      ({
        action,
        currentTime,
      }: {
        action: "play" | "pause" | "seek";
        currentTime: number;
      }) => {
        if (!currentRoomCode || !currentMemberId) return;
        if (socket.data.role !== "host" && socket.data.role !== "admin") {
          socket.emit("error", {
            message: "Only host/admin can control video",
          });
          return;
        }
        if (isSocketRateLimited(socket.id, "video", 10)) return;
        if (!Number.isFinite(currentTime) || currentTime < 0) return;

        const now = Date.now();
        const prevTl = roomTimelines.get(currentRoomCode);
        const seq = (prevTl?.seqNo ?? 0) + 1;
        const snapRoomCode = currentRoomCode;
        const PLAY_AHEAD_MS = 1500;

        let tl: VideoTimeline;
        if (action === "play") {
          tl = { isPlaying: true,  position: currentTime, positionAt: now, seqNo: seq };
          roomTimelines.set(snapRoomCode, tl);
          startPeriodicSync(snapRoomCode);
          // Phase 1: bufferCheck فوراً لكل أفراد الغرفة
          io.to(snapRoomCode).emit("bufferCheck", { position: currentTime, seqNo: seq });
          const capturedTl = tl;
          setTimeout(() => {
            if (!ioInstance) return;
            const liveTl = roomTimelines.get(snapRoomCode);
            if (!liveTl || liveTl.seqNo !== capturedTl.seqNo) return;
            // FIX VIDEO-SYNC: إرسال syncState لكل أفراد الغرفة بعد 700ms
            ioInstance.to(snapRoomCode).emit("syncState", { ...capturedTl, playAt: Date.now() + PLAY_AHEAD_MS });
          }, 700);
        } else if (action === "pause") {
          tl = { isPlaying: false, position: currentTime, positionAt: now, seqNo: seq };
          roomTimelines.set(snapRoomCode, tl);
          stopPeriodicSync(snapRoomCode);
          // FIX VIDEO-SYNC: إرسال syncState فوراً لكل أفراد الغرفة عند الإيقاف
          io.to(snapRoomCode).emit("syncState", tl);
        } else {
          tl = { isPlaying: prevTl?.isPlaying ?? false, position: currentTime, positionAt: now, seqNo: seq };
          roomTimelines.set(snapRoomCode, tl);
          if (tl.isPlaying) {
            startPeriodicSync(snapRoomCode);
            const existingSdt = roomSeekDebounceTimers.get(snapRoomCode);
            if (existingSdt !== undefined) clearTimeout(existingSdt);
            const capturedTl = tl;
            const sdt = setTimeout(() => {
              roomSeekDebounceTimers.delete(snapRoomCode);
              if (!ioInstance) return;
              const liveTl = roomTimelines.get(snapRoomCode);
              if (!liveTl || liveTl.seqNo !== capturedTl.seqNo) return;
              ioInstance.to(snapRoomCode).emit("bufferCheck", { position: capturedTl.position, seqNo: capturedTl.seqNo });
              setTimeout(() => {
                if (!ioInstance) return;
                const liveTl2 = roomTimelines.get(snapRoomCode);
                if (!liveTl2 || liveTl2.seqNo !== capturedTl.seqNo) return;
                ioInstance.to(snapRoomCode).emit("syncState", { ...capturedTl, playAt: Date.now() + PLAY_AHEAD_MS });
              }, 400);
            }, 150);
            roomSeekDebounceTimers.set(snapRoomCode, sdt);
          } else {
            stopPeriodicSync(snapRoomCode);
            io.to(snapRoomCode).emit("syncState", tl);
          }
        }
      },
    );

    socket.on("speaking", ({ volume }: { volume: number }) => {
      if (!currentRoomCode || !currentMemberId) return;
      socket
        .to(currentRoomCode)
        .emit("speakingUpdate", [{ memberId: currentMemberId, volume }]);
    });

    socket.on("kickMember", async ({ memberId }: { memberId: number }) => {
      if (
        !currentRoomCode ||
        (socket.data.role !== "host" && socket.data.role !== "admin")
      )
        return;
      try {
        const [target] = await db
          .select()
          .from(membersTable)
          .where(eq(membersTable.id, memberId));
        if (!target) return;
        if (socket.data.role === "admin" && target.role === "host") return;

        const roomKickedSet =
          kickedIPs.get(currentRoomCode) ?? new Set<string>();
        roomKickedSet.add(target.ip);
        kickedIPs.set(currentRoomCode, roomKickedSet);

        await db
          .update(membersTable)
          .set({ isOnline: false })
          .where(eq(membersTable.id, memberId));

        const sockets = await io.in(currentRoomCode).fetchSockets();
        for (const s of sockets) {
          if (s.data.memberId === memberId) {
            s.emit("kicked");
            s.leave(currentRoomCode);
            break;
          }
        }

        const [room] = await db
          .select()
          .from(roomsTable)
          .where(eq(roomsTable.code, currentRoomCode));
        if (room) {
          const allMembers = await db
            .select()
            .from(membersTable)
            .where(eq(membersTable.roomId, room.id));
          io.to(currentRoomCode).emit(
            "membersUpdate",
            onlineMembers(allMembers),
          );
          io.to(currentRoomCode).emit("memberRemoved", { memberId });
        }
      } catch (err) {
        logger.error({ err }, "Error in kickMember");
      }
    });

    socket.on("banMember", async ({ memberId }: { memberId: number }) => {
      if (
        !currentRoomCode ||
        (socket.data.role !== "host" && socket.data.role !== "admin")
      )
        return;
      try {
        const [room] = await db
          .select()
          .from(roomsTable)
          .where(eq(roomsTable.code, currentRoomCode));
        const [target] = await db
          .select()
          .from(membersTable)
          .where(eq(membersTable.id, memberId));
        if (!target || !room) return;
        if (socket.data.role === "admin" && target.role === "host") return;

        await db
          .insert(bansTable)
          .values({
            roomId: room.id,
            ip: target.ip,
            bannedBy: currentRole ?? "admin",
          })
          .onConflictDoNothing();

        const sockets = await io.in(currentRoomCode).fetchSockets();
        for (const s of sockets) {
          if (s.data.memberId === memberId) {
            s.emit("banned");
            s.leave(currentRoomCode);
            break;
          }
        }

        const allMembers = await db
          .select()
          .from(membersTable)
          .where(eq(membersTable.roomId, room.id));
        io.to(currentRoomCode).emit("membersUpdate", onlineMembers(allMembers));
        io.to(currentRoomCode).emit("memberRemoved", { memberId });
      } catch (err) {
        logger.error({ err }, "Error in banMember");
      }
    });

    // ─── muteMember + forceMute alias ────────────────────────────────────────
    // FIX D08: الكليان القديم كان بيبعت "forceMute" بدل "muteMember"
    // الحل: الاثنين بيعملوا نفس المنطق → backward compatible
    async function handleMuteMember(memberId: number, isMuted: boolean) {
      if (
        !currentRoomCode ||
        (socket.data.role !== "host" && socket.data.role !== "admin")
      )
        return;
      try {
        const [target] = await db
          .select()
          .from(membersTable)
          .where(eq(membersTable.id, memberId));
        if (!target) return;
        if (socket.data.role === "admin" && target.role === "host") return;

        await db
          .update(membersTable)
          .set({ isMuted })
          .where(eq(membersTable.id, memberId));
        const [room] = await db
          .select()
          .from(roomsTable)
          .where(eq(roomsTable.code, currentRoomCode!));
        if (!room) return;
        const allMembers = await db
          .select()
          .from(membersTable)
          .where(eq(membersTable.roomId, room.id));
        io.to(currentRoomCode!).emit(
          "membersUpdate",
          onlineMembers(allMembers),
        );

        if (isMuted) {
          const sockets = await io.in(currentRoomCode!).fetchSockets();
          for (const s of sockets) {
            if (s.data.memberId === memberId) {
              s.emit("forceMuted");
              break;
            }
          }
        }
      } catch (err) {
        logger.error({ err }, "Error in muteMember/forceMute");
      }
    }

    socket.on(
      "muteMember",
      ({ memberId, isMuted }: { memberId: number; isMuted: boolean }) => {
        void handleMuteMember(memberId, isMuted);
      },
    );

    // FIX D08: alias للكليانات القديمة اللي بتبعت "forceMute" مباشرة
    socket.on(
      "forceMute",
      ({ memberId, targetId }: { memberId?: number; targetId?: number }) => {
        const id = memberId ?? targetId;
        if (id !== undefined) void handleMuteMember(id, true);
      },
    );

    socket.on(
      "promoteMember",
      async ({ memberId, role }: { memberId: number; role: string }) => {
        if (!currentRoomCode || socket.data.role !== "host") return;
        // SEC-FIX P-01: منع تعيين أدوار عشوائية (Privilege Escalation)
        const allowedRoles = ["guest", "admin"];
        if (!allowedRoles.includes(role)) return;
        try {
          await db
            .update(membersTable)
            .set({ role })
            .where(eq(membersTable.id, memberId));
          const [room] = await db
            .select()
            .from(roomsTable)
            .where(eq(roomsTable.code, currentRoomCode));
          if (!room) return;
          const allMembers = await db
            .select()
            .from(membersTable)
            .where(eq(membersTable.roomId, room.id));
          io.to(currentRoomCode).emit(
            "membersUpdate",
            onlineMembers(allMembers),
          );

          const sockets = await io.in(currentRoomCode).fetchSockets();
          for (const s of sockets) {
            if (s.data.memberId === memberId) {
              s.data.role = role;
              s.emit("roleUpdated", { role });
              break;
            }
          }
        } catch (err) {
          logger.error({ err }, "Error in promoteMember");
        }
      },
    );

    socket.on("approveJoin", async ({ memberId }: { memberId: number }) => {
      if (
        !currentRoomCode ||
        (socket.data.role !== "host" && socket.data.role !== "admin")
      )
        return;
      try {
        const approvalMap = pendingApprovals.get(currentRoomCode);
        if (!approvalMap?.has(memberId)) return;

        const { socketId } = approvalMap.get(memberId)!;
        const targetSocket = io.sockets.sockets.get(socketId);

        if (targetSocket) {
          const [approvedMember] = await db
            .select()
            .from(membersTable)
            .where(eq(membersTable.id, memberId));
          if (approvedMember)
            kickedIPs.get(currentRoomCode)?.delete(approvedMember.ip);
          approvalMap.delete(memberId);

          const roomApproved =
            approvedMembers.get(currentRoomCode) ?? new Set<number>();
          roomApproved.add(memberId);
          approvedMembers.set(currentRoomCode, roomApproved);

          targetSocket.data.memberId = memberId;
          targetSocket.data.role = "guest";
          targetSocket.data.roomCode = currentRoomCode;
          await targetSocket.join(currentRoomCode);

          await db
            .update(membersTable)
            .set({ isOnline: true })
            .where(eq(membersTable.id, memberId));

          const [room] = await db
            .select()
            .from(roomsTable)
            .where(eq(roomsTable.code, currentRoomCode));
          if (room) {
            const allMembers = await db
              .select()
              .from(membersTable)
              .where(eq(membersTable.roomId, room.id));
            io.to(currentRoomCode).emit(
              "membersUpdate",
              onlineMembers(allMembers),
            );
          }

          targetSocket.emit("joinApproved");
          emitSyncStateTo(targetSocket, currentRoomCode);

          if (roomUploading.get(currentRoomCode)) {
            targetSocket.emit("uploadLocked");
          }
          const currentMode = roomModes.get(currentRoomCode);
          if (currentMode)
            targetSocket.emit("modeChange", { mode: currentMode });

          if (currentMode === "movies") {
            const cineState = roomCineStates.get(currentRoomCode);
            if (cineState) targetSocket.emit("moviesSync", cineState);
          }

          const history = roomChatHistory.get(currentRoomCode) ?? [];
          targetSocket.emit("chatHistory", history);

          socket.to(currentRoomCode).emit("peerJoined", { memberId, socketId: targetSocket.id });
          const approveRoomSockets2 = await io
            .in(currentRoomCode)
            .fetchSockets();
          for (const s of approveRoomSockets2) {
            if (s.data.role === "host" || s.data.role === "admin") {
              s.emit("joinRequestHandled", { memberId });
            }
          }
        }
      } catch (err) {
        logger.error({ err }, "Error in approveJoin");
      }
    });

    socket.on("requestSync", () => {
      if (!currentRoomCode) return;
      emitSyncStateTo(socket, currentRoomCode);
    });

    socket.on("driftReport", ({ drift }: { drift: number }) => {
      if (!currentRoomCode) return;
      const existing = socketDriftMap.get(socket.id) ?? { samples: [], reportedAt: 0 };
      const samples = [...existing.samples, Math.abs(drift)].slice(-3);
      socketDriftMap.set(socket.id, { samples, reportedAt: Date.now() });
      if (samples.length >= 2 && samples.every(s => s > 3)) {
        logger.info({ socketId: socket.id, samples, roomCode: currentRoomCode }, "Sustained drift — forcing re-sync");
        emitSyncStateTo(socket, currentRoomCode);
        socketDriftMap.set(socket.id, { samples: [], reportedAt: Date.now() });
      }
    });

    socket.on("bufferReady", () => { /* acknowledged */ });

    socket.on("uploadStarted", () => {
      if (
        !currentRoomCode ||
        (socket.data.role !== "host" && socket.data.role !== "admin")
      )
        return;
      if (roomUploading.get(currentRoomCode)) {
        socket.emit("uploadAlreadyInProgress");
        return;
      }
      roomUploading.set(currentRoomCode, true);
      roomTimelines.delete(currentRoomCode);
      stopPeriodicSync(currentRoomCode);
      io.to(currentRoomCode).emit("uploadLocked");
    });

    socket.on("uploadEnded", () => {
      if (!currentRoomCode) return;
      roomUploading.delete(currentRoomCode);
      io.to(currentRoomCode).emit("uploadUnlocked");
    });

    socket.on("clearContent", async () => {
      if (
        !currentRoomCode ||
        (socket.data.role !== "host" && socket.data.role !== "admin")
      )
        return;
      const clearCode = currentRoomCode;
      roomTimelines.delete(clearCode);
      roomHyperbeamUrls.delete(clearCode);
      roomUploading.delete(clearCode);
      io.to(clearCode).emit("contentCleared");
      try {
        const [room] = await db
          .select()
          .from(roomsTable)
          .where(eq(roomsTable.code, clearCode));
        if (room) {
          await db
            .delete(roomVideosTable)
            .where(eq(roomVideosTable.roomId, room.id));
          deleteRoomFiles(clearCode);
        }
      } catch (err) {
        logger.error({ err }, "Error clearing content from db/fs");
      }
    });

    socket.on("rejectJoin", async ({ memberId }: { memberId: number }) => {
      if (
        !currentRoomCode ||
        (socket.data.role !== "host" && socket.data.role !== "admin")
      )
        return;
      const approvalMap = pendingApprovals.get(currentRoomCode);
      if (!approvalMap?.has(memberId)) return;
      const { socketId } = approvalMap.get(memberId)!;
      approvalMap.delete(memberId);
      const targetSocket = io.sockets.sockets.get(socketId);
      if (targetSocket) targetSocket.emit("joinRejected");
      try {
        const rejectRoomSockets = await io.in(currentRoomCode).fetchSockets();
        for (const s of rejectRoomSockets) {
          if (s.data.role === "host" || s.data.role === "admin") {
            s.emit("joinRequestHandled", { memberId });
          }
        }
      } catch (err) {
        logger.error({ err }, "Error broadcasting joinRequestHandled (reject)");
      }
    });

    // ─── FIX D03-D05: webrtcSignal يقبل targetMemberId أو targetId (backward compat) ─
    // الكليان القديم كان بيبعت {targetId} لكن السيرفر كان بيتوقع {targetMemberId}
    // الحل: نقرأ الاتنين ونستخدم أي واحد فيه قيمة
    socket.on(
      "webrtcSignal",
      async ({
        targetMemberId,
        targetId,
        signal,
      }: {
        targetMemberId?: number;
        targetId?: number;
        signal: unknown;
      }) => {
        if (!currentRoomCode || !currentMemberId) return;
        const resolvedTargetId = targetMemberId ?? targetId;
        if (resolvedTargetId === undefined) return;
        try {
          const sockets = await io.in(currentRoomCode).fetchSockets();
          for (const s of sockets) {
            if (s.data.memberId === resolvedTargetId) {
              s.emit("webrtcSignal", { fromMemberId: currentMemberId, signal });
              break;
            }
          }
        } catch (err) {
          logger.error({ err }, "Error in webrtcSignal");
        }
      },
    );

    socket.on("micEnabled", () => {
      if (!currentRoomCode || !currentMemberId) return;
      socket
        .to(currentRoomCode)
        .emit("peerMicEnabled", { memberId: currentMemberId });
    });

    socket.on("micDisabled", () => {
      if (!currentRoomCode || !currentMemberId) return;
      socket
        .to(currentRoomCode)
        .emit("peerMicDisabled", { memberId: currentMemberId });
    });

    socket.on("audioChunk", (payload: { sr: number; buf: ArrayBuffer }) => {
      if (!currentRoomCode || !currentMemberId) return;
      if (isSocketRateLimited(socket.id, "audio", 50)) return;
      socket.volatile.to(currentRoomCode).emit("audioChunk", {
        fromMemberId: currentMemberId,
        sr: payload.sr,
        buf: payload.buf,
      });
    });

    socket.on(
      "changeMode",
      ({ mode }: { mode: "video" | "browser" | "screenshare" | "movies" }) => {
        if (!currentRoomCode) return;
        // SEC-FIX C-02: فقط host/admin يقدر يغير الوضع
        if (socket.data.role !== "host" && socket.data.role !== "admin") return;
        roomModes.set(currentRoomCode, mode as "video" | "browser" | "screenshare");
        // لما الهوست يتحول لـ movies mode يبدأ من الأول → نمسح الحالة القديمة
        if (mode === "movies") roomCineStates.delete(currentRoomCode);
        socket.to(currentRoomCode).emit("modeChange", { mode });
      },
    );

    // ── Movies Sync ──────────────────────────────────────────────────────────
    // الهوست/الأدمن بيبعتوا الأحداث دي، والسيرفر بيوصلها للضيوف تلقائياً

    socket.on("moviesSelect", ({ item }: { item: unknown }) => {
      if (!currentRoomCode) return;
      if (socket.data.role !== "host" && socket.data.role !== "admin") return;
      const cur = roomCineStates.get(currentRoomCode) ?? { ...DEFAULT_CINE_ROOM_STATE };
      roomCineStates.set(currentRoomCode, {
        ...cur,
        selectedItem: item,
        view: item ? "player" : "browse",
        season: 1,
        episode: 1,
        directUrl: "",
        subtitleUrl: "",
      });
      socket.to(currentRoomCode).emit("moviesSelect", { item });
    });

    socket.on("moviesSeason", ({ season }: { season: number }) => {
      if (!currentRoomCode) return;
      if (socket.data.role !== "host" && socket.data.role !== "admin") return;
      const cur = roomCineStates.get(currentRoomCode) ?? { ...DEFAULT_CINE_ROOM_STATE };
      roomCineStates.set(currentRoomCode, { ...cur, season, episode: 1, directUrl: "", subtitleUrl: "" });
      socket.to(currentRoomCode).emit("moviesSeason", { season });
    });

    socket.on("moviesEpisode", ({ episode }: { episode: number }) => {
      if (!currentRoomCode) return;
      if (socket.data.role !== "host" && socket.data.role !== "admin") return;
      const cur = roomCineStates.get(currentRoomCode) ?? { ...DEFAULT_CINE_ROOM_STATE };
      roomCineStates.set(currentRoomCode, { ...cur, episode, directUrl: "", subtitleUrl: "" });
      socket.to(currentRoomCode).emit("moviesEpisode", { episode });
    });

    socket.on("moviesDirectUrl", ({ directUrl, subtitleUrl }: { directUrl: string; subtitleUrl?: string }) => {
      if (!currentRoomCode) return;
      if (socket.data.role !== "host" && socket.data.role !== "admin") return;
      if (typeof directUrl !== "string") return;
      if (directUrl && !directUrl.startsWith("http://") && !directUrl.startsWith("https://")) return;
      const safeSubtitle = typeof subtitleUrl === "string" ? subtitleUrl : "";
      if (safeSubtitle && !safeSubtitle.startsWith("http://") && !safeSubtitle.startsWith("https://")) return;
      const cur = roomCineStates.get(currentRoomCode) ?? { ...DEFAULT_CINE_ROOM_STATE };
      roomCineStates.set(currentRoomCode, { ...cur, directUrl, subtitleUrl: safeSubtitle });
      socket.to(currentRoomCode).emit("moviesDirectUrl", { directUrl, subtitleUrl: safeSubtitle });
    });

    socket.on(
      "moviesFilter",
      ({ type, category }: { type: "movie" | "tv"; category: "popular" | "top_rated" }) => {
        if (!currentRoomCode) return;
        if (socket.data.role !== "host" && socket.data.role !== "admin") return;
        const cur = roomCineStates.get(currentRoomCode) ?? { ...DEFAULT_CINE_ROOM_STATE };
        roomCineStates.set(currentRoomCode, {
          ...cur,
          contentType: type,
          category,
          searchQuery: "",
          selectedItem: null,
          view: "browse",
          season: 1,
          episode: 1,
        });
        socket.to(currentRoomCode).emit("moviesFilter", { type, category });
      },
    );

    socket.on("moviesSearch", ({ query }: { query: string }) => {
      if (!currentRoomCode) return;
      if (socket.data.role !== "host" && socket.data.role !== "admin") return;
      const cur = roomCineStates.get(currentRoomCode) ?? { ...DEFAULT_CINE_ROOM_STATE };
      roomCineStates.set(currentRoomCode, {
        ...cur,
        searchQuery: query,
        selectedItem: null,
        view: "browse",
      });
      socket.to(currentRoomCode).emit("moviesSearch", { query });
    });
    // ─────────────────────────────────────────────────────────────────────────

    socket.on("screenShareStarted", () => {
      if (!currentRoomCode) return;
      socket.to(currentRoomCode).emit("screenShareStarted");
    });

    socket.on("screenShareStopped", () => {
      if (!currentRoomCode) return;
      socket.to(currentRoomCode).emit("screenShareStopped");
    });

    socket.on(
      "webrtcInitiateOffer",
      async ({ targetMemberId }: { targetMemberId: number }) => {
        if (!currentRoomCode || !currentMemberId) return;
        try {
          const sockets = await io.in(currentRoomCode).fetchSockets();
          for (const s of sockets) {
            if (s.data.memberId === targetMemberId) {
              s.emit("webrtcInitiateOffer", { targetMemberId: currentMemberId });
              break;
            }
          }
        } catch (err) {
          logger.error({ err }, "Error in webrtcInitiateOffer relay");
        }
      },
    );

    socket.on("hyperbeamReady", ({ embedUrl }: { embedUrl: string }) => {
      if (
        !currentRoomCode ||
        (socket.data.role !== "host" && socket.data.role !== "admin")
      )
        return;
      // SEC-FIX H-01: منع حقن URLs ضارة (XSS عبر hyperbeam)
      if (typeof embedUrl !== "string" || !embedUrl.startsWith("https://")) return;
      roomHyperbeamUrls.set(currentRoomCode, embedUrl);
      socket.to(currentRoomCode).emit("hyperbeamSession", { embedUrl });
    });

    socket.on("hyperbeamEnded", () => {
      if (
        !currentRoomCode ||
        (socket.data.role !== "host" && socket.data.role !== "admin")
      )
        return;
      roomHyperbeamUrls.delete(currentRoomCode);
      socket.to(currentRoomCode).emit("hyperbeamEnded");
    });

    socket.on("setAccessControl", ({ enabled }: { enabled: boolean }) => {
      if (!currentRoomCode || socket.data.role !== "host") return;
      roomAccessControl.set(currentRoomCode, enabled);
      io.to(currentRoomCode).emit("accessControlChanged", { enabled });
    });

    socket.on(
      "chatMessage",
      async ({
        message,
        replyTo,
        whisperTo,
        voiceData,
        imageData,
      }: {
        message: string;
        replyTo?: { memberId: number; name: string; message: string };
        whisperTo?: { memberId: number; name: string };
        voiceData?: string;
        imageData?: string;
      }) => {
        if (!currentRoomCode || !currentMemberId || !currentMemberName) return;
        // FIX E02: رفع الحد من 5 → 20 رسالة/ثانية لدعم المحادثات السريعة
        if (isSocketRateLimited(socket.id, "chat", 20)) return;

        if (voiceData && voiceData.length > 800000) return;
        if (imageData && imageData.length > 800000) return;
        if (voiceData && !voiceData.startsWith("data:audio/")) return;
        if (imageData && !imageData.startsWith("data:image/")) return;

        const trimmed = message?.trim() ?? "";
        if (!voiceData && !imageData && (!trimmed || trimmed.length > 500)) return;

        const safeTrimmed = trimmed
          .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
          .replace(/&#([0-9]+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
          .replace(/<[^>]*>/g, "")
          .replace(/javascript\s*:/gi, "")
          .replace(/vbscript\s*:/gi, "")
          .replace(/data\s*:\s*text\/html/gi, "")
          .replace(/\bon\w+\s*=/gi, "")
          .replace(/[<>]/g, "")
          .slice(0, 500);

        const entry: ChatEntry = {
          memberId: currentMemberId,
          name: currentMemberName,
          message: safeTrimmed,
          timestamp: Date.now(),
          ...(replyTo ? { replyTo } : {}),
          ...(whisperTo ? { whisperTo } : {}),
          ...(voiceData ? { voiceData } : {}),
          ...(imageData ? { imageData } : {}),
        };

        if (whisperTo) {
          try {
            const roomSockets = await io.in(currentRoomCode).fetchSockets();
            for (const s of roomSockets) {
              if (s.data.memberId === whisperTo.memberId || s.id === socket.id) {
                s.emit("chatMessage", entry);
              }
            }
          } catch (err) {
            logger.error({ err }, "Error in whisper chatMessage");
          }
          return;
        }

        const history = roomChatHistory.get(currentRoomCode) ?? [];
        history.push(entry);
        if (history.length > 200) history.shift();
        roomChatHistory.set(currentRoomCode, history);
        io.to(currentRoomCode).emit("chatMessage", entry);
      },
    );

    socket.on("closeRoom", async () => {
      if (!currentRoomCode || socket.data.role !== "host") return;
      const closeCode = currentRoomCode;
      try {
        clearRoomState(closeCode);

        io.to(closeCode).emit("roomClosed");
        const sockets = await io.in(closeCode).fetchSockets();
        for (const s of sockets) s.leave(closeCode);

        const [room] = await db
          .select()
          .from(roomsTable)
          .where(eq(roomsTable.code, closeCode));
        if (room) {
          await deleteRoomFromDb(room.id);
          deleteRoomFiles(closeCode);
        }

        logger.info(
          { roomCode: closeCode },
          "Room permanently deleted by host",
        );
      } catch (err) {
        logger.error({ err }, "Error in closeRoom");
      }
    });

    socket.on("disconnect", async () => {
      socketDriftMap.delete(socket.id);
      for (const key of socketEventTimestamps.keys()) {
        if (key.startsWith(socket.id + ":")) socketEventTimestamps.delete(key);
      }

      if (!currentMemberId || !currentRoomCode) return;
      const snapRoomCode = currentRoomCode;
      const snapMemberId = currentMemberId;

      if (
        (currentRole === "host" || currentRole === "admin") &&
        roomUploading.get(snapRoomCode) 
      ) {
        roomUploading.delete(snapRoomCode);
        roomTimelines.delete(snapRoomCode);
        stopPeriodicSync(snapRoomCode);
        io.to(snapRoomCode).emit("uploadUnlocked");
        logger.info({ roomCode: snapRoomCode }, "Upload unlocked after host/admin disconnect");
      }
      removeFromOnlineCache(snapRoomCode, snapMemberId);
      scheduleDisconnectBatch(snapRoomCode, snapMemberId);
    });
  });

  return io;
}

export { roomTimelines };
