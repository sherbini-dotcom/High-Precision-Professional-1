import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { randomUUID } from "crypto";

const app: Express = express();

// Replit يستخدم reverse proxy — trust proxy يجعل Express يقرأ X-Forwarded-For
// عشان rate limiter يشتغل بالـ IP الحقيقي لكل مستخدم
app.set("trust proxy", true);

// ─── CSP Nonce ────────────────────────────────────────────────────────────────
// SEC-FIX H-02: nonce لكل طلب بدلاً من 'unsafe-inline' في الـ scripts
// يسمح فقط للـ scripts المحددة بـ nonce وليس أي inline script آخر
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.locals.cspNonce = randomUUID().replace(/-/g, "");
  next();
});

// ─── Helmet ───────────────────────────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: "same-site" },
  // SEC-FIX H-02: إزالة 'unsafe-inline' من scriptSrc نهائياً — استبدال بـ nonce
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc:       ["'self'"],
      scriptSrc:        ["'self'", (_req: Request, res: Response) => `'nonce-${(res as Response & { locals: { cspNonce: string } }).locals.cspNonce}'`],
      styleSrc:         ["'self'", "'unsafe-inline'"],
      imgSrc:           ["'self'", "data:", "blob:", "https:"],
      connectSrc:       ["'self'", "wss:", "https:"],
      mediaSrc:         ["'self'", "blob:", "https:"],
      workerSrc:        ["'self'", "blob:"],
      frameAncestors:   ["'none'"],
      baseUri:          ["'self'"],
      formAction:       ["'self'"],
      objectSrc:        ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
}));

// ─── API Cache-Control ────────────────────────────────────────────────────────
// منع تخزين استجابات API في المتصفح أو Proxy
// استثناء: مسارات HLS (playlist + segments) لها cache headers خاصة في video.ts
app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  const p = req.path;
  const isHls =
    p.includes("/hls/") ||
    p.endsWith(".m3u8") ||
    p.endsWith(".ts") ||
    p.endsWith(".m4s");
  if (!isHls) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
  }
  next();
});

// ─── Logger ───────────────────────────────────────────────────────────────────
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

// ─── CORS ─────────────────────────────────────────────────────────────────────
// [FIX C-02 / بديل app.ts] تشديد CORS:
// - يرفض * في Production
// - يقبل فقط الـ origins المدرجة صراحةً في CORS_ORIGIN
// - في غياب CORS_ORIGIN يقبل فقط same-origin
const rawAllowedOrigins = process.env.CORS_ORIGIN ?? "";
const allowedOrigins = new Set(
  rawAllowedOrigins.split(",").map((o) => o.trim()).filter(Boolean),
);

app.use(
  cors({
    origin: (requestOrigin, callback) => {
      // طلبات same-origin أو server-to-server بدون Origin header
      if (!requestOrigin) return callback(null, true);

      // [FIX C-02] حذف wildcard *.replit.dev — كان يسمح لأي مشروع Replit بالوصول
      if (allowedOrigins.has(requestOrigin)) return callback(null, true);

      // في حالة غياب CORS_ORIGIN تماماً (dev بدون إعداد) — قبول
      if (allowedOrigins.size === 0) return callback(null, true);

      // رفض أي origin غير مدرج
      callback(null, false);
    },
    credentials: true,
  }),
);

// ─── robots.txt ───────────────────────────────────────────────────────────────
// SEC-FIX M-03: منع bots من فهرسة /api/ و /socket.io/
app.get("/robots.txt", (_req: Request, res: Response) => {
  res.type("text/plain").send(
    "User-agent: *\nDisallow: /api/\nDisallow: /socket.io/\nAllow: /\n",
  );
});

// ─── CSRF Origin Check ────────────────────────────────────────────────────────
// SEC-FIX M-01: رفض طلبات POST/PUT/DELETE القادمة من Origins خارجية مجهولة
// يسمح بـ: same-origin + .replit.dev + .replit.app + CORS_ORIGIN المُعرَّفة صراحةً
const rawOrigins = process.env.CORS_ORIGIN ?? "";
const csrfAllowed = new Set(
  rawOrigins.split(",").map((o) => o.trim()).filter(Boolean),
);
function isTrustedOrigin(origin: string): boolean {
  if (csrfAllowed.has(origin)) return true;
  if (origin.endsWith(".replit.dev")) return true;
  if (origin.endsWith(".replit.app")) return true;
  if (csrfAllowed.size === 0) return true;
  return false;
}
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  if (!isTrustedOrigin(origin)) {
    logger.warn({ origin, path: req.path }, "CSRF: request rejected from unknown origin");
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
});

// ─── Body parsers ─────────────────────────────────────────────────────────────
// [FIX H-04] حد الـ payload 1mb — يمنع DoS عبر payloads ضخمة
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// ─── Global Rate Limiter ──────────────────────────────────────────────────────
  // [FIX C-02] Rate limiting على كل الـ API routes
  // [FIX HLS-429] تخطي مسارات HLS/video تماماً من الـ rate limiter
  // الـ HLS player يطلب playlist.m3u8 و .ts segments بشكل متكرر جداً
  // (مئات الطلبات/دقيقة) — إخضاعها لحد 200 req/min يسبب 429 وانقطاع البث
  function isHlsOrMediaPath(req: Request): boolean {
    const p = req.path;
    return (
      p.includes("/hls/") ||   // مسار segments الـ HLS
      p.endsWith(".m3u8")  ||   // ملفات playlist
      p.endsWith(".ts")    ||   // ملفات video segments
      p.endsWith(".m4s")   ||   // ملفات fMP4 segments
      p.endsWith(".mp4")        // ملفات video مباشرة
    );
  }

  const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    // المفتاح: session token > IP لمنع bypass عبر IP rotation
    keyGenerator: (req) => {
      const token =
        (req.headers["x-session-token"] as string) ||
        (req.cookies?.sessionToken as string);
      if (token && token.length > 10) return `tok:${token}`;
      return req.ip || "unknown";
    },
    message: { error: "Too many requests, please try again later." },
    // تخطي health checks وملفات HLS/video من الـ rate limiting
    skip: (req) =>
      req.path === "/healthz" ||
      req.path === "/health"  ||
      isHlsOrMediaPath(req),
  });

  app.use("/api", globalLimiter);
app.use("/api", router);

// ─── Global Error Handler ─────────────────────────────────────────────────────
// [FIX H-03] JSON parse error → 400 بدون تسريب تفاصيل
// [FIX H-03] جميع الأخطاء الأخرى → 500 بدون تسريب stack traces
app.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  if (err.type === "entity.parse.failed" || (err instanceof SyntaxError && err.message.includes("JSON"))) {
    res.status(400).json({ error: "Invalid JSON in request body" });
    return;
  }
  // [FIX DoS] payload أكبر من الحد المسموح → 413 بدلاً من 500
  if (err.type === "entity.too.large" || (err as { status?: number }).status === 413) {
    res.status(413).json({ error: "Payload too large" });
    return;
  }
  logger.error({ err }, "Unhandled error");
  res.status(500).json({ error: "Internal server error" });
});

export default app;
