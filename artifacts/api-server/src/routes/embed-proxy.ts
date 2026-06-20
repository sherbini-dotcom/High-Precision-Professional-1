import { Router } from "express";

const router = Router();

const ALLOWED_DOMAINS = [
  "vidsrc.to", "embed.su", "vidsrc.me", "vidsrc.pro",
  "vidlink.pro", "player.videasy.net", "multiembed.mov",
  "autoembed.cc", "smashystream.xyz", "2embed.cc",
];

// Injected into every proxied page — listens for our postMessage commands
// and directly controls the video element
const CONTROL_SCRIPT = `<script>
(function(){
  'use strict';
  function findVideo(){
    return document.querySelector('video') ||
           document.querySelector('#player video') ||
           document.querySelector('.jw-video') ||
           document.querySelector('video[src]');
  }
  function act(action, seconds){
    var v = findVideo();
    if(!v){ setTimeout(function(){ act(action, seconds); }, 800); return; }
    if(action==='play')  { try{ v.play(); }catch(e){} }
    if(action==='pause') { try{ v.pause(); }catch(e){} }
    if(action==='seek'&& typeof seconds==='number'){ v.currentTime = seconds; try{ v.play(); }catch(e){} }
  }
  window.addEventListener('message', function(e){
    try{
      var d = (typeof e.data==='string') ? JSON.parse(e.data) : e.data;
      if(!d || d.__cine!==true) return;
      act(d.action, d.seconds);
    }catch(err){}
  });
  // Report real video time back to parent every second
  setInterval(function(){
    var v = findVideo();
    if(!v) return;
    try{
      window.parent.postMessage(
        JSON.stringify({ __cine:true, type:'timeupdate',
          currentTime: v.currentTime, duration: v.duration, paused: v.paused }),
        '*'
      );
    }catch(e){}
  }, 1000);
})();
</script>`;

router.get("/embed-proxy", async (req, res) => {
  const targetUrl = req.query.url as string;
  if (!targetUrl) { res.status(400).json({ error: "url required" }); return; }

  let parsed: URL;
  try { parsed = new URL(targetUrl); }
  catch { res.status(400).json({ error: "invalid url" }); return; }

  const host = parsed.hostname.replace(/^www\./, "");
  const allowed = ALLOWED_DOMAINS.some(d => host === d || host.endsWith("." + d));
  if (!allowed) { res.status(403).json({ error: "domain not allowed" }); return; }

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Referer": parsed.origin + "/",
      },
    });

    const ct = upstream.headers.get("content-type") || "";

    // Non-HTML sub-resources: proxy them as-is
    if (!ct.includes("text/html")) {
      const buf = await upstream.arrayBuffer();
      upstream.headers.forEach((val, key) => {
        const k = key.toLowerCase();
        if (!["content-security-policy","x-frame-options","content-encoding","transfer-encoding"].includes(k)) {
          res.setHeader(key, val);
        }
      });
      res.status(upstream.status).send(Buffer.from(buf));
      return;
    }

    let html = await upstream.text();
    const origin = parsed.origin;

    // Rewrite root-relative URLs so assets still load from the original server
    html = html
      .replace(/(<(?:script|link|img|source|track)[^>]+(?:src|href)=["'])(\/(?!\/))/gi, `$1${origin}/`)
      .replace(/(url\s*\(\s*["']?)(\/(?!\/))/gi, `$1${origin}/`);

    // Inject control script right before </head>
    html = html.includes("</head>")
      ? html.replace("</head>", CONTROL_SCRIPT + "\n</head>")
      : CONTROL_SCRIPT + html;

    res.status(200)
      .setHeader("Content-Type", "text/html; charset=utf-8")
      .setHeader("X-Frame-Options", "SAMEORIGIN")
      .send(html);

  } catch (err) {
    res.status(502).json({ error: "upstream fetch failed" });
  }
});

export default router;
