import { Router } from "express";

const router = Router();

interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

// FIX AUDIO-04: STUN + TURN servers متعددة وموثوقة مع fallback هرمي
// المشكلة القديمة: servers قليلة وغير موثوقة → تقطع عند NAT صعب أو نت ضعيف
const FALLBACK_SERVERS: IceServer[] = [
  // ─── STUN سريعة ومجانية (للاتصالات المباشرة) ────────────────────────────────
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" },

  // ─── TURN via UDP/TCP/TLS (لما الاتصال المباشر مش كافي) ─────────────────────
  // Global endpoint يختار أقرب سيرفر جغرافياً تلقائياً
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
  // TLS على 443 → يعمل حتى مع الـ firewalls الصارمة جداً
  {
    urls: "turns:global.relay.metered.ca:443?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  // OpenRelay endpoints إضافية للـ redundancy
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

let cachedServers: IceServer[] | null = null;
let cacheExpiry = 0;
// [FIX-TURN-CACHE] Separate, much shorter TTL for the fallback path. Previously
// a single transient failure (network blip, 5s timeout) cached the free/shared
// fallback TURN servers for the FULL 10 minutes for every user — even if the
// real Metered API recovered a second later. Fallback now expires in 30s so we
// retry the real TURN provider quickly, while a genuine success still caches
// for the full 10 minutes.
const SUCCESS_CACHE_TTL_MS = 10 * 60 * 1000;
const FALLBACK_CACHE_TTL_MS = 30 * 1000;

router.get("/ice-servers", async (req, res) => {
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
        res.json({ iceServers: servers });
        return;
      }
    } catch {
      // fall through to fallback
    }
  }

  // [FIX-TURN-CACHE] Short cache on fallback so a transient Metered outage
  // doesn't strand every user on the shared/free TURN pool for 10 minutes.
  cachedServers = FALLBACK_SERVERS;
  cacheExpiry = Date.now() + FALLBACK_CACHE_TTL_MS;

  res.json({ iceServers: FALLBACK_SERVERS });
});

export default router;