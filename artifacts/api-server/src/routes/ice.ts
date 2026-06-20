import { Router } from "express";

const router = Router();

interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

const FALLBACK_SERVERS: IceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" },
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
];

let cachedServers: IceServer[] | null = null;
let cacheExpiry = 0;

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
        cacheExpiry = Date.now() + 4 * 60 * 1000;
        res.json({ iceServers: servers });
        return;
      }
    } catch {
      // fall through to fallback
    }
  }

  res.json({ iceServers: FALLBACK_SERVERS });
});

export default router;
