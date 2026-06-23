// ============================================================
// artifacts/api-server/src/routes/ice.ts  — TURN Health-Check Edition
// ============================================================
// ما الجديد:
//   - probeTcp()  : TCP connect بـ timeout قصير لكل TURN server
//   - probeAllServers() : يشغّل كل الـ probes بالتوازي، يخزّن النتيجة
//   - backgroundRefresh() : بتعمل probe كل دقيقتين في الخلفية
//   - /api/ice-servers    : يرجع بس السيرفرات الشغّالة (أو كلهم لو كلهم فشلوا)
//   - /api/turn-health    : endpoint للـ debugging — يعرض حالة كل سيرفر
// ============================================================

import { Router } from "express";
import * as net from "net";

const router = Router();

// ─── Types ────────────────────────────────────────────────────────────────────

interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

interface ServerHealth {
  reachable: boolean;
  latencyMs: number;
  lastChecked: number;  // Unix ms
}

// ─── Static server lists ──────────────────────────────────────────────────────

// STUN servers — مش بنعمل لهم probe (UDP فقط، مش TCP)
// دايماً بنرجّعهم كلهم بدون فلترة
const STUN_SERVERS: IceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" },
];

// TURN servers — هنعمل لهم TCP probe ونفلتر اللي مش شغّال
const TURN_SERVERS: IceServer[] = [
  {
    urls: "turn:global.relay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:global.relay.metered.ca:80?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:global.relay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turns:global.relay.metered.ca:443?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turns:openrelay.metered.ca:443?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

// ─── ICE / Metered cache ──────────────────────────────────────────────────────

let cachedServers: IceServer[] | null = null;
let cacheExpiry = 0;
const SUCCESS_CACHE_TTL_MS = 10 * 60 * 1000;  // 10 دقائق للـ Metered الحقيقي
const FALLBACK_CACHE_TTL_MS = 30 * 1000;        // 30 ثانية للـ fallback

// ─── Health-check state ───────────────────────────────────────────────────────

// Key = "host:port"  (مثلاً "global.relay.metered.ca:80")
const healthMap = new Map<string, ServerHealth>();

// هل فيه probe شغّال دلوقتي؟ (نمنع تشغيل أكثر من probe في نفس الوقت)
let probeRunning = false;

// interval handle للـ background refresh
let backgroundInterval: ReturnType<typeof setInterval> | null = null;

// ─── TCP probe ────────────────────────────────────────────────────────────────

/**
 * بيحاول يعمل TCP connection لـ host:port.
 * بيرجع { reachable, latencyMs } بعد نجاح أو timeout أو error.
 * Timeout = 2000ms (كافي لأي سيرفر عالمي لو شغّال فعلاً)
 */
function probeTcp(
  host: string,
  port: number,
  timeoutMs = 2000,
): Promise<{ reachable: boolean; latencyMs: number }> {
  return new Promise((resolve) => {
    const start = Date.now();

    const socket = net.createConnection({ host, port });

    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ reachable: false, latencyMs: Date.now() - start });
    }, timeoutMs);

    socket.on("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ reachable: true, latencyMs: Date.now() - start });
    });

    socket.on("error", () => {
      clearTimeout(timer);
      resolve({ reachable: false, latencyMs: Date.now() - start });
    });
  });
}

// ─── URL → host:port parser ───────────────────────────────────────────────────

/**
 * يحوّل TURN URL زي "turn:global.relay.metered.ca:80?transport=tcp"
 * لـ { host, port } عشان نعمل TCP probe.
 * بيرجع null لو مش TURN (مثلاً STUN أو format غريب).
 */
function parseTurnEndpoint(url: string): { host: string; port: number } | null {
  // match: turn: أو turns: ثم host ثم :port (اختياري ؟query)
  const match = url.match(/^turns?:([^:?[\]]+):(\d+)/);
  if (!match) return null;
  return { host: match[1], port: parseInt(match[2], 10) };
}

/**
 * يطلع قائمة الـ endpoints الفريدة (host:port) من قائمة TURN servers،
 * متجنّباً تكرار نفس الـ endpoint (مثلاً turn:...:80 و turn:...:80?transport=tcp)
 */
function uniqueTurnEndpoints(
  servers: IceServer[],
): Array<{ key: string; host: string; port: number }> {
  const seen = new Set<string>();
  const result: Array<{ key: string; host: string; port: number }> = [];
  for (const s of servers) {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    for (const url of urls) {
      const ep = parseTurnEndpoint(url);
      if (!ep) continue;
      const key = `${ep.host}:${ep.port}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ key, ...ep });
      }
    }
  }
  return result;
}

// ─── Probe all TURN servers ───────────────────────────────────────────────────

/**
 * يعمل TCP probe لكل TURN server بالتوازي ويحدّث healthMap.
 * مش بيبلوك الـ response — بيشتغل في الخلفية.
 */
async function probeAllServers(servers: IceServer[]): Promise<void> {
  if (probeRunning) return;
  probeRunning = true;

  try {
    const endpoints = uniqueTurnEndpoints(servers);
    const now = Date.now();

    await Promise.all(
      endpoints.map(async ({ key, host, port }) => {
        const result = await probeTcp(host, port);
        healthMap.set(key, {
          reachable: result.reachable,
          latencyMs: result.latencyMs,
          lastChecked: now,
        });
      }),
    );
  } finally {
    probeRunning = false;
  }
}

// ─── Filter servers by health ─────────────────────────────────────────────────

/**
 * يفلتر قائمة TURN servers ويرجع بس اللي عندها health record reachable.
 * لو كلهم ماتوا أو مافيش health data — يرجع الكل (أحسن من لا شيء).
 */
function filterHealthyServers(servers: IceServer[]): IceServer[] {
  // لو مافيش health data خالص → اللأول مرة قبل ما الـ probe يخلص
  if (healthMap.size === 0) return servers;

  const healthy = servers.filter((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    // سيرفر STUN → دايماً مقبول (مش بنعمل له probe)
    if (urls.every((u) => u.startsWith("stun:"))) return true;
    // TURN → اتحقق من أي endpoint من endpoints السيرفر ده شغّال
    return urls.some((url) => {
      const ep = parseTurnEndpoint(url);
      if (!ep) return true; // مش قدرنا نحلله → نشمله بالأمان
      const h = healthMap.get(`${ep.host}:${ep.port}`);
      return !h || h.reachable; // لو مافيش record → نشمله (لسه ما اتشكشش)
    });
  });

  // لو كل الـ TURN ماتت، ارجّع الكل عشان المستخدم يجرّب حظه
  const hasTurn = healthy.some((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    return urls.some((u) => u.startsWith("turn:") || u.startsWith("turns:"));
  });

  return hasTurn ? healthy : servers;
}

// ─── Background refresh ───────────────────────────────────────────────────────

const HEALTH_PROBE_INTERVAL_MS = 2 * 60 * 1000; // كل 2 دقيقة

function startBackgroundRefresh(servers: IceServer[]): void {
  if (backgroundInterval) return; // شغّال بالفعل

  // probe فوري عند الأول مرة
  probeAllServers(servers).catch(() => {});

  backgroundInterval = setInterval(() => {
    probeAllServers(servers).catch(() => {});
  }, HEALTH_PROBE_INTERVAL_MS);

  // Process cleanup — لو السيرفر اتوقف منع memory leak
  process.on("exit", () => {
    if (backgroundInterval) clearInterval(backgroundInterval);
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/ice-servers
// يرجع قائمة ICE servers المفلترة بالصحة.
// أول request بيشغّل الـ probe في الخلفية (non-blocking) ويرجع الكل مباشرة.
// الـ requests التالية بتستفيد من نتيجة الـ probe.
router.get("/ice-servers", async (req, res) => {
  // ── Step 1: جرّب Metered API الحقيقي (مدفوع) ─────────────────────────────
  if (cachedServers && Date.now() < cacheExpiry) {
    res.json({ iceServers: cachedServers });
    return;
  }

  const apiKey = process.env.METERED_API_KEY;
  const appName = process.env.METERED_APP_NAME;

  if (apiKey && appName) {
    try {
      const url = `https://${appName}.metered.ca/api/v1/turn/credentials?apiKey=${apiKey}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        const servers = (await response.json()) as IceServer[];
        cachedServers = servers;
        cacheExpiry = Date.now() + SUCCESS_CACHE_TTL_MS;

        // ابدأ health-check على الـ Metered servers في الخلفية
        startBackgroundRefresh(servers);

        const healthy = filterHealthyServers(servers);
        res.json({ iceServers: [...STUN_SERVERS, ...healthy] });
        return;
      }
    } catch {
      // fall through to fallback
    }
  }

  // ── Step 2: Fallback — مجاني / OpenRelay ──────────────────────────────────
  cachedServers = TURN_SERVERS;
  cacheExpiry = Date.now() + FALLBACK_CACHE_TTL_MS;

  // ابدأ health-check على الـ fallback TURN servers
  startBackgroundRefresh(TURN_SERVERS);

  const healthyFallback = filterHealthyServers(TURN_SERVERS);
  res.json({ iceServers: [...STUN_SERVERS, ...healthyFallback] });
});

// GET /api/turn-health
// Debug endpoint — يعرض حالة كل TURN server من آخر probe.
// مفيد لـ monitoring وتشخيص مشاكل الاتصال في production.
router.get("/turn-health", (_req, res) => {
  const allServers = [...TURN_SERVERS];
  const endpoints = uniqueTurnEndpoints(allServers);

  const report = endpoints.map(({ key, host, port }) => {
    const h = healthMap.get(key);
    return {
      endpoint: key,
      host,
      port,
      reachable: h?.reachable ?? null,       // null = لسه ما اتشكشش
      latencyMs: h?.latencyMs ?? null,
      lastChecked: h?.lastChecked
        ? new Date(h.lastChecked).toISOString()
        : null,
      ageSeconds: h?.lastChecked
        ? Math.round((Date.now() - h.lastChecked) / 1000)
        : null,
    };
  });

  const reachableCount = report.filter((r) => r.reachable === true).length;
  const unreachableCount = report.filter((r) => r.reachable === false).length;
  const unknownCount = report.filter((r) => r.reachable === null).length;

  res.json({
    summary: {
      total: report.length,
      reachable: reachableCount,
      unreachable: unreachableCount,
      unknown: unknownCount,
      probeIntervalSeconds: HEALTH_PROBE_INTERVAL_MS / 1000,
    },
    servers: report,
  });
});

export default router;
