import { Router } from "express";
import type { IRouter } from "express";
import { eq, and } from "drizzle-orm";
import rateLimit from "express-rate-limit";
import { db, roomsTable, membersTable, roomVideosTable } from "@workspace/db";
import multer from "multer";
import path from "path";
import fs from "fs";
import { processToHls } from "../lib/hls";
import { GetVideoStatusParams } from "@workspace/api-zod";
// puppeteer is loaded dynamically so the server starts even if it isn't installed yet

const UPLOADS_DIR = path.join(process.cwd(), "uploads");

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const code = (req.params.code as string).toUpperCase();
    // [FIX] التحقق من أن code لا يحتوي على path traversal
    if (!/^[A-Z0-9]+$/.test(code)) {
      return cb(new Error("Invalid room code"), "");
    }
    const dir = path.join(UPLOADS_DIR, code, "raw");
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    // [FIX] اسم الملف يعتمد فقط على الـ timestamp — لا نحتفظ باسم المستخدم الأصلي
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `video_${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  // [FIX] تقليل حجم الملف من 10GB إلى 5GB — حد معقول لمنع DoS
  limits: { fileSize: 5 * 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [".mp4", ".mkv", ".avi", ".mov", ".webm", ".m4v"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Unsupported file type"));
    }
  },
});

const router: IRouter = Router();

// ── HLS segment concurrency limiter ──────────────────────────────────────────
const HLS_MAX_CONCURRENT = 60;
let hlsActive = 0;
const hlsQueue: Array<() => void> = [];

function acquireHlsSlot(): Promise<void> {
  if (hlsActive < HLS_MAX_CONCURRENT) {
    hlsActive++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => hlsQueue.push(resolve));
}

function releaseHlsSlot(): void {
  const next = hlsQueue.shift();
  if (next) {
    next();
  } else {
    hlsActive--;
  }
}

// [FIX] Rate limiter على HLS segments لمنع استنزاف الـ I/O
const hlsLimiter = rateLimit({
  windowMs: 60_000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many segment requests" },
});

router.post(
  "/rooms/:code/video",
  upload.single("video"),
  async (req, res): Promise<void> => {
    const code = (req.params.code as string).toUpperCase();
    const sessionToken = req.headers["x-session-token"] as string | undefined;
    if (!sessionToken) {
      res.status(403).json({ error: "No session token" });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    const [room] = await db
      .select()
      .from(roomsTable)
      .where(eq(roomsTable.code, code));
    if (!room) {
      res.status(404).json({ error: "Room not found" });
      return;
    }

    const [requester] = await db
      .select()
      .from(membersTable)
      .where(
        and(
          eq(membersTable.sessionToken, sessionToken),
          eq(membersTable.roomId, room.id),
        ),
      );
    if (
      !requester ||
      (requester.role !== "host" && requester.role !== "admin")
    ) {
      res.status(403).json({ error: "Only host/admin can upload videos" });
      return;
    }

    const [oldVideo] = await db
      .select()
      .from(roomVideosTable)
      .where(eq(roomVideosTable.roomId, room.id))
      .limit(1);
    if (oldVideo) {
      req.app.get("io")?.to(code).emit("contentCleared");
      await new Promise<void>((resolve) => setTimeout(resolve, 400));
      const oldHlsDir = oldVideo.hlsDir ?? path.join(UPLOADS_DIR, code, `vid_${oldVideo.id}`);
      if (fs.existsSync(oldHlsDir)) fs.rmSync(oldHlsDir, { recursive: true, force: true });
      await db.delete(roomVideosTable).where(eq(roomVideosTable.roomId, room.id));
    }

    const [video] = await db
      .insert(roomVideosTable)
      .values({
        roomId: room.id,
        originalName: req.file.originalname,
        status: "processing",
        progress: 0,
      })
      .returning();

    const hlsDir = path.join(UPLOADS_DIR, code, `vid_${video.id}`);
    res.status(202).json({ message: "Processing started", videoId: video.id });

    processToHls(
      req.file.path,
      hlsDir,
      async (percent) => {
        await db
          .update(roomVideosTable)
          .set({ progress: percent })
          .where(eq(roomVideosTable.id, video.id));
        req.app
          .get("io")
          ?.to(code)
          .emit("uploadProgress", { progress: percent });
      },
      async (_hlsDir) => {
        await db
          .update(roomVideosTable)
          .set({ status: "ready", progress: 100, hlsDir })
          .where(eq(roomVideosTable.id, video.id));
        req.app
          .get("io")
          ?.to(code)
          .emit("videoReady", {
            hlsPath: `/api/rooms/${code}/hls/${video.id}/playlist.m3u8`,
          });
      },
      async (err) => {
        await db
          .update(roomVideosTable)
          .set({ status: "error" })
          .where(eq(roomVideosTable.id, video.id));
        req.app
          .get("io")
          ?.to(code)
          .emit("videoError", { message: err.message });
      },
    );
  },
);

router.get("/rooms/:code/hls/:videoId/:filename", hlsLimiter, async (req, res): Promise<void> => {
  const code = (req.params.code as string).toUpperCase();
  const videoId = req.params.videoId as string;
  const filename = req.params.filename as string;

  // [FIX] التحقق الصارم من المدخلات لمنع Path Traversal
  if (!filename.match(/^[a-zA-Z0-9_.-]+$/) || filename.includes("..")) {
    res.status(400).json({ error: "Invalid filename" });
    return;
  }
  if (!videoId.match(/^\d+$/)) {
    res.status(400).json({ error: "Invalid videoId" });
    return;
  }
  // [FIX] التحقق من room code
  if (!/^[A-Z0-9]+$/.test(code)) {
    res.status(400).json({ error: "Invalid room code" });
    return;
  }

  const filePath = path.join(UPLOADS_DIR, code, `vid_${videoId}`, filename);

  // [FIX] التحقق من أن المسار الناتج لا يخرج من UPLOADS_DIR (Double Path Traversal)
  const resolvedPath = path.resolve(filePath);
  const resolvedUploadsDir = path.resolve(UPLOADS_DIR);
  if (!resolvedPath.startsWith(resolvedUploadsDir + path.sep)) {
    res.status(400).json({ error: "Invalid path" });
    return;
  }

  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  if (filename.endsWith(".m3u8")) {
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    // VOD playlist ثابتة بعد اكتمال المعالجة — يمكن تخزينها في cache
    // هذا يمنع كل مستخدم من طلبها من السيرفر في كل ثانية
    // public: يسمح للـ CDN/proxy بالتخزين
    // max-age=3600: صالحة لمدة ساعة (الفيديو لا يتغير)
    // stale-while-revalidate=60: يخدم النسخة المخزنة أثناء التحديث
    res.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=60");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.sendFile(resolvedPath);
    return;
  }

  if (filename.endsWith(".ts")) {
    res.setHeader("Content-Type", "video/MP2T");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("Access-Control-Allow-Origin", "*");

    await acquireHlsSlot();
    let slotReleased = false;
    const releaseOnce = () => {
      if (!slotReleased) { slotReleased = true; releaseHlsSlot(); }
    };
    res.on("finish", releaseOnce);
    res.on("close",  releaseOnce);

    res.sendFile(resolvedPath, (err) => {
      releaseOnce();
      if (err && !res.headersSent) {
        res.status(500).json({ error: "Failed to send segment" });
      }
    });
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.sendFile(resolvedPath);
});

router.get("/rooms/:code/video/status", async (req, res): Promise<void> => {
  const params = GetVideoStatusParams.safeParse(req.params);
  if (!params.success) {
    // [FIX H-03] رسالة عامة — لا تُكشف تفاصيل Zod
    res.status(400).json({ error: "Invalid params" });
    return;
  }

  const [room] = await db
    .select()
    .from(roomsTable)
    .where(eq(roomsTable.code, params.data.code.toUpperCase()));
  if (!room) {
    res.status(404).json({ error: "Room not found" });
    return;
  }

  const [video] = await db
    .select()
    .from(roomVideosTable)
    .where(eq(roomVideosTable.roomId, room.id))
    .limit(1);
  if (!video) {
    res.json({ status: "none", filename: null, hlsPath: null, progress: null });
    return;
  }
  res.json({
    status: video.status,
    filename: video.originalName,
    hlsPath:
      video.status === "ready"
        ? `/api/rooms/${params.data.code.toUpperCase()}/hls/${video.id}/playlist.m3u8`
        : null,
    progress: video.progress,
  });
});

// ── Stream extraction via Puppeteer (headless Chrome intercepts real requests) ─

const CHROMIUM_PATH = process.env.CHROMIUM_PATH ?? "/home/runner/.nix-profile/bin/chromium";

/** Score an m3u8 URL — higher = more likely to be the master/main playlist */
function scoreM3u8(url: string): number {
  let score = 0;
  const lower = url.toLowerCase();
  // Master playlist signals
  if (lower.includes("master")) score += 40;
  if (lower.includes("index.m3u8")) score += 30;
  if (lower.includes("playlist.m3u8")) score += 25;
  if (lower.includes("main")) score += 20;
  if (lower.includes("hls")) score += 10;
  // Segment-level signals (bad — penalise)
  if (/\/seg[-_]?\d/i.test(url)) score -= 50;
  if (/\/chunk[-_]?\d/i.test(url)) score -= 50;
  if (/\d{4,}\.m3u8/.test(url)) score -= 30;   // e.g. 0003.m3u8
  if (lower.includes("chunklist")) score -= 40;
  // Shorter paths tend to be master playlists
  score -= Math.floor(url.length / 80);
  return score;
}

/** Intercept actual network requests in a headless browser to capture .m3u8 / .mp4 and subtitle URLs */
async function extractStream(embedUrl: string): Promise<{ streamUrl: string | null; subtitleUrl: string | null; method: string }> {
  // Dynamic import via new Function — bypasses TypeScript module resolution
  // so the file compiles even if puppeteer isn't installed in the project.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-explicit-any
  const puppeteer: any = await (new Function("m", "return import(m)"))("puppeteer").catch(() => null);
  if (!puppeteer) return { streamUrl: null, subtitleUrl: null, method: "puppeteer-not-installed" };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any = null;
  const timeout = 30_000;

  try {
    browser = await puppeteer.default.launch({
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
        "--mute-audio",
        // do NOT add --disable-background-networking — it blocks XHR/fetch from video players
      ],
    });

    const page = await browser.newPage();

    // ── Anti-bot: hide headless signals ─────────────────────────────────────
    await page.evaluateOnNewDocument(() => {
      // Remove webdriver flag
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      // Fake plugin list (headless has 0 plugins)
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      // Fake language
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    });

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    );
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    });

    await page.setRequestInterception(true);

    // Collect ALL m3u8/mp4 candidates — pick the best one at the end
    const m3u8Candidates: string[] = [];
    let mp4Url: string | null = null;
    let subtitleUrl: string | null = null;

    page.on("request", (req: { url: () => string; resourceType: () => string; abort: () => Promise<void>; continue: () => Promise<void>; }) => {
      const url = req.url();
      const type = req.resourceType();

      if (url.includes(".m3u8")) {
        m3u8Candidates.push(url);
      } else if (!mp4Url && (url.includes(".mp4") && !url.includes(".mpd"))) {
        mp4Url = url;
      } else if (!subtitleUrl && (url.includes(".vtt") || url.includes(".srt"))) {
        subtitleUrl = url;
      }

      // Block only truly irrelevant resources — do NOT block "media" (kills video players)
      if (["image", "font", "stylesheet"].includes(type)) {
        req.abort().catch(() => undefined);
      } else {
        req.continue().catch(() => undefined);
      }
    });

    // Also intercept responses to catch redirect-resolved URLs
    page.on("response", (resp: { url: () => string; status: () => number }) => {
      const url = resp.url();
      const status = resp.status();
      if (status >= 200 && status < 400) {
        if (url.includes(".m3u8") && !m3u8Candidates.includes(url)) {
          m3u8Candidates.push(url);
        } else if (!mp4Url && url.includes(".mp4") && !url.includes(".mpd")) {
          mp4Url = url;
        } else if (!subtitleUrl && (url.includes(".vtt") || url.includes(".srt"))) {
          subtitleUrl = url;
        }
      }
    });

    // Use domcontentloaded — vidsrc sites never reach networkidle2 due to polling
    await page.goto(embedUrl, { waitUntil: "domcontentloaded", timeout }).catch(() => null);

    // Give JS time to execute after DOM is ready
    await new Promise((r) => setTimeout(r, 2500));

    // ── Try clicking any visible play buttons ──────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    await page.evaluate(new Function(`
      var sels = [
        "button[class*='play']","[class*='play-btn']","[id*='play']",
        ".jw-icon-playback",".plyr__control--overlaid",".vjs-big-play-button",
        "[data-plyr='play']",".play-button","button.play"
      ];
      for (var i = 0; i < sels.length; i++) {
        var el = document.querySelector(sels[i]);
        if (el) { el.click(); break; }
      }
    `)).catch(() => undefined);

    // ── Also scan iframes for video src / window stream vars ───────────────
    // NOTE: this function runs inside the browser via page.evaluate() —
    // DOM APIs (document, window, HTMLVideoElement…) exist at runtime even
    // though the server tsconfig doesn't include the "dom" lib.
    // We use Function + string eval to avoid TypeScript complaining about
    // browser globals that aren't in the server's type environment.
    const extractFromPage = async (targetPage: typeof page): Promise<string[]> => {
      return (targetPage as unknown as { evaluate: (fn: () => string[]) => Promise<string[]> })
        .evaluate(
          // eslint-disable-next-line @typescript-eslint/no-implied-eval
          new Function(`
            var results = [];
            try {
              document.querySelectorAll("video[src]").forEach(function(v) {
                var src = v.src;
                if (src && (src.includes(".m3u8") || src.includes(".mp4"))) results.push(src);
              });
              document.querySelectorAll("source[src]").forEach(function(s) {
                var src = s.src;
                if (src && (src.includes(".m3u8") || src.includes(".mp4"))) results.push(src);
              });
              var keys = ["hlsUrl","streamUrl","videoUrl","m3u8Url","file","src"];
              for (var i = 0; i < keys.length; i++) {
                var val = window[keys[i]];
                if (typeof val === "string" && (val.includes(".m3u8") || val.includes(".mp4"))) results.push(val);
              }
            } catch(e) {}
            return results;
          `) as () => string[],
        )
        .catch(() => [] as string[]);
    };

    // Scan main page
    const domUrls = await extractFromPage(page);
    for (const u of domUrls) {
      if (u.includes(".m3u8") && !m3u8Candidates.includes(u)) m3u8Candidates.push(u);
      else if (u.includes(".mp4") && !mp4Url) mp4Url = u;
    }

    // Scan all iframes (cross-origin iframes will silently fail — that's fine)
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const frameUrls = await extractFromPage(frame as typeof page).catch(() => [] as string[]);
      for (const u of frameUrls) {
        if (u.includes(".m3u8") && !m3u8Candidates.includes(u)) m3u8Candidates.push(u);
        else if (u.includes(".mp4") && !mp4Url) mp4Url = u;
      }
    }

    // ── Wait for network activity to settle (up to remaining timeout) ─────
    const startAt = Date.now();
    while (m3u8Candidates.length === 0 && !mp4Url && Date.now() - startAt < 8_000) {
      await new Promise((r) => setTimeout(r, 400));
    }

    // Pick the best m3u8 candidate by score; fall back to mp4
    if (m3u8Candidates.length > 0) {
      const best = m3u8Candidates.reduce((a, b) => scoreM3u8(a) >= scoreM3u8(b) ? a : b);
      return { streamUrl: best, subtitleUrl, method: "puppeteer" };
    }
    if (mp4Url) return { streamUrl: mp4Url, subtitleUrl, method: "puppeteer" };
    return { streamUrl: null, subtitleUrl: null, method: "puppeteer-not-found" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { streamUrl: null, subtitleUrl: null, method: `puppeteer-error: ${msg.slice(0, 120)}` };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

// ── HLS Proxy ─────────────────────────────────────────────────────────────────
// Browsers cannot set Referer/Origin on <video> / HLS.js requests, so many CDN-
// hosted m3u8 streams silently fail.  This proxy fetches everything server-side
// with the right headers and rewrites m3u8 playlist lines so every subsequent
// segment request also passes through the proxy.

const PROXY_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

function rewriteM3u8(body: string, baseUrl: string, proxyBase: string): string {
  const base = new URL(baseUrl);
  const ref = encodeURIComponent(base.origin + "/");

  const proxyWrap = (rawUrl: string): string => {
    let resolved: string;
    try { resolved = new URL(rawUrl, base).href; } catch { return rawUrl; }
    return `${proxyBase}?url=${encodeURIComponent(resolved)}&referer=${ref}`;
  };

  return body
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // Rewrite URI="..." attributes inside directives (EXT-X-KEY, EXT-X-MAP, etc.)
      if (trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => {
          return `URI="${proxyWrap(uri)}"`;
        });
      }

      // Plain URL line (segment or sub-playlist)
      return proxyWrap(trimmed);
    })
    .join("\n");
}

const proxyLimiter = rateLimit({ windowMs: 60_000, max: 3000, standardHeaders: true, legacyHeaders: false });

router.get("/proxy/hls", proxyLimiter, async (req, res): Promise<void> => {
  const rawUrl = req.query.url as string | undefined;
  const referer = (req.query.referer as string | undefined) ?? "";
  if (!rawUrl) { res.status(400).json({ error: "Missing url" }); return; }

  let target: URL;
  try { target = new URL(rawUrl); } catch { res.status(400).json({ error: "Invalid url" }); return; }
  if (!["http:", "https:"].includes(target.protocol)) { res.status(400).json({ error: "Unsupported protocol" }); return; }

  try {
    const headers: Record<string, string> = {
      "User-Agent": PROXY_UA,
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Origin": target.origin,
    };
    if (referer) headers["Referer"] = referer;

    const upstream = await fetch(rawUrl, { headers });
    if (!upstream.ok) { res.status(upstream.status).json({ error: `Upstream ${upstream.status}` }); return; }

    const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";

    // Read as raw buffer first — avoids corrupting binary segments when
    // we later need to check for the #EXTM3U text signature.
    const arrayBuf = await upstream.arrayBuffer();
    const buf = Buffer.from(arrayBuf);

    // Detect m3u8 by content-type OR URL hint OR the #EXTM3U magic bytes
    const EXTM3U = Buffer.from("#EXTM3U");
    const isM3u8 =
      contentType.includes("mpegurl") ||
      rawUrl.includes(".m3u8") ||
      (buf.length >= 7 && buf.slice(0, 7).equals(EXTM3U));

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", isM3u8 ? "max-age=5" : "max-age=60");

    if (isM3u8) {
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.send(rewriteM3u8(buf.toString("utf8"), rawUrl, "/api/proxy/hls"));
    } else {
      // Binary segment (.ts, .aac, etc.) — pipe raw bytes unchanged
      res.setHeader("Content-Type", contentType);
      res.send(buf);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `Proxy error: ${msg.slice(0, 120)}` });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

const extractLimiter = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false });

router.get("/rooms/:code/movies/extract-stream", extractLimiter, async (req, res): Promise<void> => {
  const code = (req.params.code as string).toUpperCase();
  const sessionToken = req.headers["x-session-token"] as string | undefined;
  if (!sessionToken) { res.status(403).json({ error: "No session token" }); return; }

  const { source, tmdbId, type, season = "1", episode = "1" } = req.query as Record<string, string>;
  if (!source || !tmdbId || !type) { res.status(400).json({ error: "Missing params" }); return; }

  const id = parseInt(tmdbId, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: "Invalid tmdbId" }); return; }

  const [room] = await db.select().from(roomsTable).where(eq(roomsTable.code, code));
  if (!room) { res.status(404).json({ error: "Room not found" }); return; }

  const [requester] = await db.select().from(membersTable).where(
    and(eq(membersTable.sessionToken, sessionToken), eq(membersTable.roomId, room.id)),
  );
  if (!requester || (requester.role !== "host" && requester.role !== "admin")) {
    res.status(403).json({ error: "Only host/admin can extract streams" }); return;
  }

  const s = Math.max(1, parseInt(season, 10) || 1);
  const e = Math.max(1, parseInt(episode, 10) || 1);

  let embedUrl: string;
  switch (source) {
    case "vidsrc_to":   embedUrl = type === "movie" ? `https://vidsrc.to/embed/movie/${id}`              : `https://vidsrc.to/embed/tv/${id}/${s}/${e}`; break;
    case "vidsrc_xyz":  embedUrl = type === "movie" ? `https://vidsrc.xyz/embed/movie?tmdb=${id}`        : `https://vidsrc.xyz/embed/tv?tmdb=${id}&season=${s}&episode=${e}`; break;
    case "vidsrc_me":   embedUrl = type === "movie" ? `https://vidsrc.me/embed/movie?tmdb=${id}`         : `https://vidsrc.me/embed/tv?tmdb=${id}&season=${s}&episode=${e}`; break;
    case "multiembed":  embedUrl = type === "movie" ? `https://multiembed.mov/?video_id=${id}&tmdb=1`     : `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${s}&e=${e}`; break;
    case "embedsu":     embedUrl = type === "movie" ? `https://embed.su/embed/movie/${id}`               : `https://embed.su/embed/tv/${id}/${s}/${e}`; break;
    case "moviesapi":   embedUrl = type === "movie" ? `https://moviesapi.club/movie/${id}`               : `https://moviesapi.club/tv/${id}-${s}-${e}`; break;
    default: res.status(400).json({ error: "Unknown source" }); return;
  }

  const result = await extractStream(embedUrl);
  res.json({ streamUrl: result.streamUrl, subtitleUrl: result.subtitleUrl, embedUrl, method: result.method });
});

export default router;
