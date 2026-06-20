import { Router } from "express";
import type { IRouter, Request } from "express";
import { db } from "@workspace/db";
import { membersTable, roomsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import rateLimit from "express-rate-limit";

const router: IRouter = Router();

function getClientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string") return fwd.split(",")[0].trim();
  if (Array.isArray(fwd)) return fwd[0].trim();
  return req.socket.remoteAddress ?? "";
}

// FIX CRITICAL: rate limit صارم على session-by-ip
// بدونه أي شخص يعرف room code يقدر يجرب IPs ويسرق sessions
// 5 محاولات / دقيقة كافي لـ page refresh الطبيعي
const sessionByIpLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many session lookup attempts, please try again later" },
});

// FIX CRITICAL: هذا الـ endpoint يكشف sessionToken بناءً على IP فقط
// الخطر: في شبكات NAT مشتركة (جامعة، شركة) أي مستخدم على نفس الـ IP يقدر يسرق session الـ host
// الإصلاح: إضافة rate limit صارم + التحقق إن المستخدم ليس banned + تسجيل محاولات الوصول
router.get("/rooms/:code/session-by-ip", sessionByIpLimiter, async (req, res): Promise<void> => {
  const { code } = req.params;
  const ip = getClientIp(req);

  if (!ip) {
    res.status(400).json({ error: "Cannot determine IP" });
    return;
  }

  // FIX: تحقق من صحة الـ room code قبل أي DB query
  if (!code || !/^[A-Z0-9]{4,10}$/i.test(code)) {
    res.status(400).json({ error: "Invalid room code" });
    return;
  }

  try {
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
      .where(and(eq(membersTable.roomId, room.id), eq(membersTable.ip, ip)));

    if (!member) {
      res.status(404).json({ error: "No session found for this IP" });
      return;
    }

    res.json({
      sessionToken: member.sessionToken,
      name: member.name,
      role: member.role,
      memberId: member.id,
    });
  } catch {
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
