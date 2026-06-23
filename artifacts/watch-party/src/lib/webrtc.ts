export interface WebRTCSignal {
  type: "offer" | "answer" | "candidate";
  sdp?: string;
  candidate?: RTCIceCandidateInit;
}

type SignalSender = (targetMemberId: number, signal: WebRTCSignal) => void;
type ScreenStreamCallback = (memberId: number, stream: MediaStream | null) => void;

interface PeerEntry {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  makingOffer: boolean;
  ignoreOffer: boolean;
  polite: boolean;
  pendingCandidates: RTCIceCandidateInit[];
  screenSender: RTCRtpSender | null;
  screenAudioSender: RTCRtpSender | null;
  // [FIX-ABR-SCOPE] Explicit reference to the MIC audio sender, kept separate
  // from screenAudioSender. Previously the ABR loop (startAdaptiveBitrate)
  // touched every sender with kind === "audio", which meant a bad mic packet-loss
  // reading also throttled screen-share system audio (movie/game sound) down to
  // 24 kbps even though that track's own delivery may be perfectly healthy.
  // With this reference, mic ABR only ever adjusts the mic sender.
  micAudioSender: RTCRtpSender | null;
  // Android: "disconnected" state timer — wait 5 s before attempting ICE restart
  // to allow transient network blips to self-recover before we intervene.
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

// ─── ICE Servers ─────────────────────────────────────────────────────────────
// SEC-FIX: Metered TURN credentials must NEVER live in frontend code — this
// bundle ships to every visitor's browser, so any hardcoded key here is
// effectively public and can be scraped to drain our Metered quota.
// Real (paid) TURN credentials are now fetched from the backend at
// `/api/ice-servers`, which reads METERED_API_KEY/METERED_APP_NAME from
// server-side env vars (see artifacts/api-server/src/routes/ice.ts).
//
// Only well-known, intentionally-public demo servers are kept here as a
// last-resort fallback if that fetch fails — these credentials are meant
// to be shared publicly by their providers, so hardcoding them is safe.
const PUBLIC_FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  // ── STUN (direct connections, no relay) ───────────────────────────────────
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:global.stun.twilio.com:3478" },

  // ── TURN via OpenRelay / Metered free tier ─────────────────────────────────
  // Matches the backend fallback in ice.ts — same servers, consistent behaviour.
  // global.relay.metered.ca picks the nearest region automatically.
  // turns: on port 443 passes through even strict corporate/school firewalls.
  { urls: "turn:global.relay.metered.ca:80",                username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:global.relay.metered.ca:80?transport=tcp",  username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:global.relay.metered.ca:443",               username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turns:global.relay.metered.ca:443?transport=tcp",username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:80",                   username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443",                  username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turns:openrelay.metered.ca:443?transport=tcp",   username: "openrelayproject", credential: "openrelayproject" },
];

// In-memory cache so we only hit the backend once per page session.
// [FIX] TTL raised from 4 min → 10 min to match the backend's own cache TTL.
// Mismatched TTLs caused the frontend to re-fetch ICE credentials more often
// than the backend refreshes them, resulting in stale credentials on re-fetch.
let cachedIceServers: RTCIceServer[] | null = null;
let iceServersCacheExpiry = 0;
const ICE_SERVERS_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Fetches the real TURN/STUN server list from our backend (which holds the
 * actual Metered API key server-side). Falls back to public demo servers
 * only if the request fails — this should be rare in production.
 */
async function getIceServers(): Promise<RTCIceServer[]> {
  if (cachedIceServers && Date.now() < iceServersCacheExpiry) {
    return cachedIceServers;
  }
  try {
    const res = await fetch("/api/ice-servers");
    if (!res.ok) throw new Error(`ice-servers fetch failed: ${res.status}`);
    const data = (await res.json()) as { iceServers: RTCIceServer[] };
    if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
      cachedIceServers = data.iceServers;
      iceServersCacheExpiry = Date.now() + ICE_SERVERS_CACHE_TTL_MS;
      return cachedIceServers;
    }
    throw new Error("ice-servers response had no servers");
  } catch {
    // Backend unreachable or misconfigured — degrade to public fallbacks
    // rather than failing the call entirely.
    return PUBLIC_FALLBACK_ICE_SERVERS;
  }
}

// ─── Optimal Mic Capture ──────────────────────────────────────────────────────
// [FIX-MIC-FALLBACK] Three-tier fallback chain — all tiers disable browser AGC
// so our own gain + compressor chain is always the sole dynamic controller.
// Previously, tier 2 re-enabled autoGainControl: true which caused double-AGC
// on Android (browser AGC fighting our compressor → unstable volume / distortion).
// Tier 3 still passes audio: true as a last resort for unsupported browsers.
export async function getMicStream(): Promise<MediaStream> {
  // Tier 1: full high-quality constraints
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false, // we handle gain ourselves
        sampleRate: 48000,
        sampleSize: 16,
        channelCount: 1,
      },
      video: false,
    });
  } catch { /* fall through */ }

  // Tier 2: relaxed constraints — drop sampleRate/sampleSize (some Android WebViews reject them)
  // Still keep autoGainControl: false to avoid double-AGC with our compressor chain.
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
        channelCount: 1,
      },
      video: false,
    });
  } catch { /* fall through */ }

  // Tier 3: absolute minimum — let the browser decide everything
  return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
}

// ─── Voice Activity Detector ──────────────────────────────────────────────────
export function createVoiceActivityDetector(
  stream: MediaStream,
  onVolume: (volume: number) => void,
): () => void {
  let animFrame: number;
  let stopped = false;

  const AudioCtxClass =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtxClass({ latencyHint: "interactive" });
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.3;
  source.connect(analyser);

  const buffer = new Uint8Array(analyser.frequencyBinCount);

  function tick() {
    if (stopped) return;
    analyser.getByteFrequencyData(buffer);
    const binHz = ctx.sampleRate / analyser.fftSize;
    const startBin = Math.floor(80 / binHz);
    const endBin = Math.min(Math.floor(3000 / binHz), buffer.length - 1);
    let sum = 0;
    for (let i = startBin; i <= endBin; i++) sum += buffer[i];
    const avg = sum / (endBin - startBin + 1);
    onVolume(Math.round((avg / 255) * 100));
    animFrame = requestAnimationFrame(tick);
  }

  ctx.resume().then(() => { animFrame = requestAnimationFrame(tick); });

  return () => {
    stopped = true;
    cancelAnimationFrame(animFrame);
    source.disconnect();
    ctx.close();
  };
}

// ─── SDP: Force Opus with Optimal Parameters ──────────────────────────────────
// [FIX-OPUS] maxaveragebitrate reduced from 510000 → 64000 bps (Opus spec maximum
// for mono speech is ~128 kbps; 510 kbps was nonsensical and ignored by most
// browsers). 64 kbps is transparent for voice with useinbandfec=1.
// usedtx=1 (discontinuous transmission) silences the stream during pauses,
// saving bandwidth on weak connections — pairs well with our Worklet-side VAD.
// cbr=0 (variable bitrate) lets Opus use fewer bits for silence/simple audio.
//
// [FIX-OPUS-PTIME] ptime raised 10 → 20 ms. 10 ms doubles the packet rate for
// the same audio duration vs the 20 ms default, which INCREASES relative
// RTP/UDP/IP header overhead and gives packet loss more chances to hit any
// given chunk of audio — the opposite of what we want on a weak connection.
// 20 ms is the standard interval used by mainstream voice apps specifically
// because it is more loss-resilient; minptime stays at 10 so a peer that
// truly needs lower latency can still negotiate down.
//
// [FIX-OPUS-MULTI-AUDIO] Previously this used sdp.match()/sdp.replace() WITHOUT
// the "g" flag, so only the FIRST "m=audio" section in the whole SDP ever got
// these params — the SECOND audio section (e.g. screen-share system audio
// running alongside the mic) had its original fmtp line stripped by the
// global removal regex but never replaced, leaving it on un-tuned Opus
// defaults (no bitrate cap, no FEC, no DTX). Fixed by splitting the SDP into
// its m= sections and patching each "m=audio" section independently.
function applyOpusParamsToSection(section: string): string {
  const match = section.match(/a=rtpmap:(\d+) opus\/48000/i);
  if (!match) return section;
  const pt = match[1];
  let out = section.replace(new RegExp(`a=fmtp:${pt}[^\r\n]*\r\n`, "g"), "");
  // maxaveragebitrate=64000: transparent mono voice; browsers cap higher values anyway
  // useinbandfec=1: packet-loss concealment built into the bitstream
  // usedtx=1: sends ~0 bps during silence (complements our Worklet VAD)
  // cbr=0: variable bitrate — fewer bits for silence/simple audio
  // minptime=10,ptime=20: 20 ms packetisation — more loss-resilient on weak networks
  const fmtp = `a=fmtp:${pt} maxaveragebitrate=64000;useinbandfec=1;usedtx=1;cbr=0;minptime=10;ptime=20\r\n`;
  out = out.replace(
    new RegExp(`(a=rtpmap:${pt} opus/48000[^\r\n]*\r\n)`, "i"),
    `$1${fmtp}`,
  );
  return out;
}

function applyOpusParams(sdp: string): string {
  // Split right before every "m=" line so each section (m=audio / m=video, and
  // everything that belongs to it) is patched independently, then re-joined.
  const sections = sdp.split(/(?=\r\nm=)/);
  return sections
    .map((section) =>
      /^\r?\n?m=audio/i.test(section) ? applyOpusParamsToSection(section) : section,
    )
    .join("");
}

// ─── WebRTC Manager ───────────────────────────────────────────────────────────
// ─── Network Quality ──────────────────────────────────────────────────────────
// "good"   = packet loss ≤ 5%  → زرار المايك أخضر
// "fair"   = packet loss 5-10% → أصفر
// "poor"   = packet loss > 10% → أحمر
// "none"   = مافيه peers متصلين (المايك مفتوح بس مافيه أحد ثاني)
export type NetworkQuality = "good" | "fair" | "poor" | "none";

type NetworkQualityCallback = (quality: NetworkQuality) => void;

export class WebRTCManager {
  private peers = new Map<number, PeerEntry>();
  private localStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private sendSignal: SignalSender;
  private onRemoteScreenStream: ScreenStreamCallback | null;
  private onNetworkQuality: NetworkQualityCallback | null;
  // Cache remote video streams so stop→restart reuse the same stream object
  private remoteVideoStreams = new Map<number, MediaStream>();
  // [FIX-ABR-WORST-QUALITY] Last computed NetworkQuality per peer, kept up to
  // date every ABR tick. Needed so the worst-case calculation below can
  // actually compare real values across peers instead of re-reading the same
  // variable it's trying to compute.
  private lastQualityByPeer = new Map<number, NetworkQuality>();

  constructor(
    sendSignal: SignalSender,
    onRemoteScreenStream?: ScreenStreamCallback,
    onNetworkQuality?: NetworkQualityCallback,
  ) {
    this.sendSignal = sendSignal;
    this.onRemoteScreenStream = onRemoteScreenStream ?? null;
    this.onNetworkQuality = onNetworkQuality ?? null;
  }

  setStream(stream: MediaStream | null) {
    this.localStream = stream;
    for (const [, entry] of this.peers) {
      const audioTrack = stream?.getAudioTracks()[0] ?? null;
      // [FIX-ABR-SCOPE] Use the tracked micAudioSender reference instead of
      // `senders.find(s => s.track?.kind === "audio")`. The old lookup could
      // grab the SCREEN-SHARE audio sender by mistake whenever the mic sender's
      // track was momentarily null (e.g. between toggles) — replacing the
      // wrong sender's track entirely.
      if (entry.micAudioSender) {
        if (audioTrack) entry.micAudioSender.replaceTrack(audioTrack).catch(() => {});
        else entry.micAudioSender.replaceTrack(null).catch(() => {});
      } else if (audioTrack) {
        entry.micAudioSender = entry.pc.addTrack(audioTrack, stream as MediaStream);
      }
    }
  }

  // ─── Screen Share ───────────────────────────────────────────────────────────
  //
  // Any peer (host, admin, or guest) can share. addTrack triggers onnegotiationneeded
  // which re-offers to all connected peers. removeTrack does the same when stopping.

  async startScreenShare(stream: MediaStream): Promise<void> {
    this.screenStream = stream;
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) return;

    // contentHint = "detail" → preserve sharp text/lines instead of blurring
    (videoTrack as MediaStreamTrack & { contentHint?: string }).contentHint = "detail";

    const audioTrack = stream.getAudioTracks()[0] ?? null;

    for (const [, entry] of this.peers) {
      if (entry.screenSender) {
        await entry.screenSender.replaceTrack(videoTrack).catch(() => {});
      } else {
        entry.screenSender = entry.pc.addTrack(videoTrack, stream);
      }
      // Add screen audio track if available and not already added
      if (audioTrack) {
        if (entry.screenAudioSender) {
          await entry.screenAudioSender.replaceTrack(audioTrack).catch(() => {});
        } else {
          entry.screenAudioSender = entry.pc.addTrack(audioTrack, stream);
        }
        // [FIX-ABR-SCOPE] Fixed bitrate for screen-share audio, independent of mic ABR.
        this.applyScreenAudioEncodingParams(entry);
      }
      this.applyVideoEncodingParams(entry.pc);
    }
  }

  stopScreenShare(): void {
    this.screenStream = null;
    for (const [, entry] of this.peers) {
      if (entry.screenSender) {
        try { entry.pc.removeTrack(entry.screenSender); } catch { /* ignore */ }
        entry.screenSender = null;
      }
      if (entry.screenAudioSender) {
        try { entry.pc.removeTrack(entry.screenAudioSender); } catch { /* ignore */ }
        entry.screenAudioSender = null;
      }
    }
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private createAudioElement(): HTMLAudioElement {
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.setAttribute("autoplay", "");
    audio.setAttribute("playsinline", "");
    audio.muted = false;
    audio.volume = 1.0;
    audio.style.cssText =
      "position:absolute;width:0;height:0;opacity:0;pointer-events:none;";
    document.body.appendChild(audio);
    return audio;
  }

  private async createPeer(memberId: number, polite: boolean): Promise<PeerEntry> {
    const iceServers = await getIceServers();
    const pc = new RTCPeerConnection({
      iceServers,
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
      iceTransportPolicy: "all",
    });

    const audio = this.createAudioElement();
    const entry: PeerEntry = {
      pc,
      audio,
      makingOffer: false,
      ignoreOffer: false,
      polite,
      pendingCandidates: [],
      screenSender: null,
      screenAudioSender: null,
      micAudioSender: null,
      reconnectTimer: null,
    };
    this.peers.set(memberId, entry);

    // Add local audio track if available.
    // [FIX-ABR-SCOPE] Track the sender explicitly as micAudioSender so later
    // bitrate adjustments (ABR) only ever target the mic, never screen-share audio.
    if (this.localStream) {
      const micTrack = this.localStream.getAudioTracks()[0];
      if (micTrack) {
        entry.micAudioSender = pc.addTrack(micTrack, this.localStream);
      }
    }

    // If screen sharing is already running when a new peer connects, add the tracks now.
    // onnegotiationneeded will fire and send an offer that includes the video (and audio) track.
    if (this.screenStream) {
      const videoTrack = this.screenStream.getVideoTracks()[0];
      if (videoTrack) {
        entry.screenSender = pc.addTrack(videoTrack, this.screenStream);
      }
      const audioTrack = this.screenStream.getAudioTracks()[0];
      if (audioTrack) {
        entry.screenAudioSender = pc.addTrack(audioTrack, this.screenStream);
      }
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal(memberId, {
          type: "candidate",
          candidate: event.candidate.toJSON(),
        });
      }
    };

    // onnegotiationneeded fires when tracks are added/removed (screen share start/stop).
    // BOTH sides can renegotiate — polite/impolite only governs collision resolution.
    pc.onnegotiationneeded = async () => {
      if (entry.makingOffer) return;
      try {
        entry.makingOffer = true;
        const offer = await pc.createOffer();
        offer.sdp = applyOpusParams(offer.sdp ?? "");
        if (pc.signalingState !== "stable") return;
        await pc.setLocalDescription(offer);
        if (pc.localDescription) {
          this.sendSignal(memberId, { type: "offer", sdp: pc.localDescription.sdp });
        }
      } catch { /* ignore race conditions during teardown */ }
      finally { entry.makingOffer = false; }
    };

    pc.ontrack = (event) => {
      const track = event.track;
      track.enabled = true; // Explicitly enable — iOS Safari sometimes receives tracks as disabled

      if (track.kind === "audio") {
        // Add to existing MediaStream instead of replacing it.
        // A peer can send multiple audio tracks (mic + screen share audio simultaneously).
        // Replacing srcObject would silence the first track when the second arrives.
        let stream = audio.srcObject as MediaStream | null;
        if (!stream) {
          stream = new MediaStream();
          audio.srcObject = stream;
        }
        if (!stream.getTracks().includes(track)) {
          stream.addTrack(track);
        }
        audio.play().catch(() => {});
        // Clean up when this track ends (e.g. screen share stopped)
        track.addEventListener("ended", () => {
          stream?.removeTrack(track);
        }, { once: true });
      } else if (track.kind === "video") {
        // Video: always wrap in a FRESH MediaStream — iOS Safari has a known bug where
        // event.streams[0] from a renegotiated track (e.g. screen share added mid-session)
        // references a stale stream object that produces a permanent black screen even
        // though the track itself is live and delivering frames.
        const stream = new MediaStream([track]);

        // Cache the stream permanently — same object is reused across stop→restart cycles
        this.remoteVideoStreams.set(memberId, stream);
        // Fire callback so room can attach stream when screen share is active
        this.onRemoteScreenStream?.(memberId, stream);

        track.onended = () => {
          this.remoteVideoStreams.delete(memberId);
          this.onRemoteScreenStream?.(memberId, null);
        };
        // onmute: iOS Safari fires this immediately on track arrival (known iOS WebRTC bug).
        // Do NOT clear the stream here — clearing causes a permanent black screen on iPhone
        // because the track stays muted and onunmute may never fire.
        // The stream stays cached; the video element stays attached.
        track.onmute = () => { /* intentionally empty — do not clear stream */ };
        track.onunmute = () => {
          // iOS: create a FRESH MediaStream on unmute so the video element
          // fully re-initialises its decoder — reusing the same stream object
          // after a mute/unmute cycle can keep the screen black on Safari.
          const freshStream = new MediaStream([track]);
          this.remoteVideoStreams.set(memberId, freshStream);
          this.onRemoteScreenStream?.(memberId, freshStream);
        };
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        // Clear any pending reconnect timer — connection recovered on its own.
        if (entry.reconnectTimer !== null) {
          clearTimeout(entry.reconnectTimer);
          entry.reconnectTimer = null;
        }
        this.applyAudioEncodingParams(entry);
        this.applyScreenAudioEncodingParams(entry);
        this.applyVideoEncodingParams(pc);
        // ابدأ مراقبة الشبكة وتعديل الـ bitrate تلقائياً
        this.startAdaptiveBitrate(memberId, entry);
      } else if (pc.connectionState === "disconnected") {
        // Android Chrome frequently lands here on transient network blips (e.g. switching
        // between Wi-Fi and mobile data). Give the browser 2 s to self-recover before we
        // kick off an ICE restart; reduced from 5 s — on iOS the connection doesn't
        // self-recover after backgrounding so waiting longer just adds latency.
        if (entry.reconnectTimer !== null) return; // already waiting
        entry.reconnectTimer = setTimeout(() => {
          entry.reconnectTimer = null;
          if (pc.connectionState !== "disconnected") return; // recovered on its own
          if (entry.makingOffer) return;
          entry.makingOffer = true;
          pc.createOffer({ iceRestart: true })
            .then((offer) => {
              offer.sdp = applyOpusParams(offer.sdp ?? "");
              return pc.setLocalDescription(offer);
            })
            .then(() => {
              if (pc.localDescription) {
                this.sendSignal(memberId, {
                  type: "offer",
                  sdp: pc.localDescription.sdp,
                });
              }
            })
            .catch(() => {})
            .finally(() => { entry.makingOffer = false; });
        }, 2000);
      } else if (pc.connectionState === "failed") {
        // Hard failure — restart ICE immediately (no timer needed here).
        if (entry.reconnectTimer !== null) {
          clearTimeout(entry.reconnectTimer);
          entry.reconnectTimer = null;
        }
        if (entry.makingOffer) return;
        entry.makingOffer = true;
        pc.createOffer({ iceRestart: true })
          .then((offer) => {
            offer.sdp = applyOpusParams(offer.sdp ?? "");
            return pc.setLocalDescription(offer);
          })
          .then(() => {
            if (pc.localDescription) {
              this.sendSignal(memberId, {
                type: "offer",
                sdp: pc.localDescription.sdp,
              });
            }
          })
          .catch(() => {})
          .finally(() => { entry.makingOffer = false; });
      } else if (pc.connectionState === "closed") {
        this.removePeer(memberId);
      }
    };

    return entry;
  }

  // [FIX-ABR-SCOPE] Now takes the PeerEntry (not the raw RTCPeerConnection) and
  // targets ONLY entry.micAudioSender. Previously this looped over every sender
  // with kind === "audio", which also caught screenAudioSender — meaning mic
  // packet loss silently throttled screen-share system audio (movie/game sound)
  // down to 24 kbps even when that track's own delivery was perfectly fine.
  private applyAudioEncodingParams(entry: PeerEntry, maxBitrate = 64_000) {
    const sender = entry.micAudioSender;
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    for (const enc of params.encodings) {
      enc.maxBitrate = maxBitrate;
      enc.priority = "high";
      enc.networkPriority = "high";
    }
    sender.setParameters(params).catch(() => {});
  }

  // [FIX-ABR-SCOPE] Screen-share system audio gets its own fixed, generous
  // bitrate independent of mic ABR — it has nothing to do with voice-chat
  // network conditions and shouldn't be dragged down by them.
  private applyScreenAudioEncodingParams(entry: PeerEntry, maxBitrate = 128_000) {
    const sender = entry.screenAudioSender;
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    for (const enc of params.encodings) {
      enc.maxBitrate = maxBitrate;
      enc.priority = "high";
      enc.networkPriority = "high";
    }
    sender.setParameters(params).catch(() => {});
  }

  // ─── Adaptive Bitrate ─────────────────────────────────────────────────────
  // يراقب packet loss كل 5 ثواني ويخفّض الـ bitrate لو الشبكة ضعيفة.
  // يعود للـ 64 kbps تلقائياً لو الشبكة تحسّنت.
  private startAdaptiveBitrate(memberId: number, entry: PeerEntry): void {
    // حذف أي interval قديم لنفس الـ peer
    const existingKey = `abr-${memberId}`;
    const existingInterval = (this as unknown as Record<string, ReturnType<typeof setInterval>>)[existingKey];
    if (existingInterval) clearInterval(existingInterval);

    const interval = setInterval(async () => {
      if (!this.peers.has(memberId)) {
        clearInterval(interval);
        return;
      }
      if (entry.pc.connectionState !== "connected") return;

      try {
        const stats = await entry.pc.getStats();

        // [FIX-ABR-ASYMMETRIC] Measure packet loss from BOTH directions and take
        // the worst of the two. Previously only inbound-rtp was checked, which works
        // well for symmetric links (home Wi-Fi, LAN) but misses the common mobile
        // case where upload is far weaker than download:
        //   • inbound-rtp  = what WE receive (download direction, immediate & accurate)
        //   • outbound-rtp remote-inbound-rtp = what THEY receive from US (upload direction)
        //     This is reported via RTCP feedback; latency ~1-2s but still far more
        //     accurate than the old "symmetric proxy" assumption for asymmetric links.
        // Delta-based calculation avoids cumulative skew (early loss inflating the
        // ratio forever even after the network recovers).
        type InboundAudioReport  = RTCInboundRtpStreamStats  & { packetsLost?: number; packetsReceived?: number };
        type RemoteInboundReport = RTCInboundRtpStreamStats & { packetsLost?: number; kind?: string };
        type OutboundAudioReport = RTCOutboundRtpStreamStats & { packetsSent?: number };

        let packetLoss = 0;
        type PrevStats = { inLost: number; inRecv: number; outLost: number; outSent: number };
        const prevStats = (this as unknown as Record<string, PrevStats>)[`abr-prev-${memberId}`]
          ?? { inLost: 0, inRecv: 0, outLost: 0, outSent: 0 };

        // Collect outbound SSRC→packetsSent for matching with remote-inbound reports
        const outboundSentBySsrc = new Map<number, number>();
        stats.forEach((report) => {
          if (report.type === "outbound-rtp" && (report as RTCOutboundRtpStreamStats).kind === "audio") {
            const r = report as OutboundAudioReport;
            if (r.ssrc !== undefined) outboundSentBySsrc.set(r.ssrc, r.packetsSent ?? 0);
          }
        });

        let inLost = prevStats.inLost, inRecv = prevStats.inRecv;
        let outLost = prevStats.outLost, outSent = prevStats.outSent;

        stats.forEach((report) => {
          if (report.type === "inbound-rtp" && (report as RTCInboundRtpStreamStats).kind === "audio") {
            const r = report as InboundAudioReport;
            inLost = r.packetsLost ?? inLost;
            inRecv = r.packetsReceived ?? inRecv;
          }
          // remote-inbound-rtp: RTCP feedback from the remote peer about what they received from us
          if (report.type === "remote-inbound-rtp") {
            const r = report as RemoteInboundReport;
            if (r.kind === "audio" || (r.ssrc !== undefined && outboundSentBySsrc.has(r.ssrc))) {
              outLost = r.packetsLost ?? outLost;
              outSent = r.ssrc !== undefined ? (outboundSentBySsrc.get(r.ssrc) ?? outSent) : outSent;
            }
          }
        });

        // Delta download loss
        const dInLost  = Math.max(0, inLost  - prevStats.inLost);
        const dInRecv  = Math.max(0, inRecv  - prevStats.inRecv);
        const dInTotal = dInLost + dInRecv;
        const inboundLoss = dInTotal > 0 ? dInLost / dInTotal : 0;

        // Delta upload loss
        const dOutLost  = Math.max(0, outLost - prevStats.outLost);
        const dOutSent  = Math.max(0, outSent  - prevStats.outSent);
        const dOutTotal = dOutLost + dOutSent;
        const outboundLoss = dOutTotal > 0 ? dOutLost / dOutTotal : 0;

        // Worst of the two directions — conservative but correct
        packetLoss = Math.max(inboundLoss, outboundLoss);

        (this as unknown as Record<string, PrevStats>)[`abr-prev-${memberId}`] =
          { inLost, inRecv, outLost, outSent };

        // Tiered bitrate: >10% loss → 24kbps (minimum viable), >5% → 32kbps, else 64kbps
        const targetBitrate = packetLoss > 0.10 ? 24_000 : packetLoss > 0.05 ? 32_000 : 64_000;
        this.applyAudioEncodingParams(entry, targetBitrate);

        // ── Network Quality Indicator ────────────────────────────────────────
        // نطلق الـ callback مع جودة الشبكة بناءً على packet loss.
        // نستخدم worst-case لو فيه أكثر من peer: لو أي اتصال ضعيف يظهر أحمر.
        if (this.onNetworkQuality) {
          const quality: NetworkQuality =
            packetLoss > 0.10 ? "poor" : packetLoss > 0.05 ? "fair" : "good";
          // [FIX-ABR-WORST-QUALITY] خزّن جودة هذا الـ peer ثم احسب الـ worst-case
          // الحقيقي من بين كل الـ peers المتصلين باستخدام آخر قيمة مخزّنة لكل
          // واحد منهم. الكود القديم كان يعيد قراءة نفس المتغير (worstQuality)
          // بدون أي مقارنة فعلية بقيم الـ peers الآخرين، فكانت النتيجة دايمًا
          // تساوي جودة آخر peer شغّل الـ ABR loop بتاعه فقط.
          this.lastQualityByPeer.set(memberId, quality);

          const RANK: Record<NetworkQuality, number> = { good: 0, fair: 1, poor: 2, none: 0 };
          let worstQuality: NetworkQuality = "good";
          let sawConnectedPeer = false;
          for (const [pid, peer] of this.peers) {
            if (peer.pc.connectionState !== "connected") continue;
            sawConnectedPeer = true;
            const q = this.lastQualityByPeer.get(pid) ?? "good";
            if (RANK[q] > RANK[worstQuality]) worstQuality = q;
          }
          if (!sawConnectedPeer) worstQuality = "none";
          this.onNetworkQuality(worstQuality);
        }
      } catch { /* ignore — peer may be closing */ }
    }, 5_000);

    (this as unknown as Record<string, ReturnType<typeof setInterval>>)[existingKey] = interval;
  }

  // ─── hasConnectedPeers ────────────────────────────────────────────────────
  // يُستخدم في room.tsx لمنع إرسال audioChunk عبر Socket.IO لو WebRTC شغّال.
  hasConnectedPeers(): boolean {
    for (const [, entry] of this.peers) {
      if (entry.pc.connectionState === "connected") return true;
    }
    return false;
  }

  // ─── forceIceRestart ─────────────────────────────────────────────────────
  // يُستدعى لما المستخدم يرجع من الـ background على iOS/Android.
  // يلغي أي reconnect timer معلّق (الـ 5 ثواني) ويعمل ICE restart فوري
  // على كل الـ peers اللي حالتها disconnected أو failed — بدل ما ننتظر.
  forceIceRestart(): void {
    for (const [memberId, entry] of this.peers) {
      // إلغاء الـ timer المعلّق عشان ما يتعارضش مع الـ restart الجديد
      if (entry.reconnectTimer !== null) {
        clearTimeout(entry.reconnectTimer);
        entry.reconnectTimer = null;
      }
      const state = entry.pc.connectionState;
      if (state !== "disconnected" && state !== "failed") continue;
      if (entry.makingOffer) continue;
      entry.makingOffer = true;
      entry.pc.createOffer({ iceRestart: true })
        .then((offer) => {
          offer.sdp = applyOpusParams(offer.sdp ?? "");
          return entry.pc.setLocalDescription(offer);
        })
        .then(() => {
          if (entry.pc.localDescription) {
            this.sendSignal(memberId, {
              type: "offer",
              sdp: entry.pc.localDescription.sdp,
            });
          }
        })
        .catch(() => {})
        .finally(() => { entry.makingOffer = false; });
    }
  }

  // ─── notifyNopeers ────────────────────────────────────────────────────────
  // لما الـ peer الأخير يتحذف، نخبر الـ UI إن مافيش اتصالات نشطة.
  private notifyNoPeers(): void {
    if (this.onNetworkQuality && !this.hasConnectedPeers()) {
      this.onNetworkQuality("none");
    }
  }

  // ─── Manual Quality Override ──────────────────────────────────────────────
  // null = adaptive (ABR controls bitrate), number = user-forced bitrate in bps.
  private manualBitrate: number | null = null;

  /**
   * Set a manual audio quality override that overrides ABR.
   * Pass null to re-enable adaptive bitrate.
   *   "low"  → 24 kbps  (weak network / mobile data)
   *   "mid"  → 48 kbps  (balanced)
   *   "high" → 64 kbps  (good network, default)
   *   null   → ABR decides automatically
   */
  setManualQuality(preset: "low" | "mid" | "high" | null): void {
    if (preset === null) {
      this.manualBitrate = null;
      return;
    }
    const map = { low: 24_000, mid: 48_000, high: 64_000 } as const;
    this.manualBitrate = map[preset];
    // Apply immediately to all connected peers
    for (const [, entry] of this.peers) {
      if (entry.pc.connectionState === "connected") {
        this.applyAudioEncodingParams(entry, this.manualBitrate);
      }
    }
  }

  private applyVideoEncodingParams(pc: RTCPeerConnection) {
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== "video") continue;
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      for (const enc of params.encodings) {
        enc.maxBitrate = 8_000_000;
        enc.maxFramerate = 30;
        enc.priority = "high";
        enc.networkPriority = "high";
        enc.scaleResolutionDownBy = 1.0;
      }
      sender.setParameters(params).catch(() => {});
    }
  }

  async initiateOffer(targetMemberId: number): Promise<void> {
    const existing = this.peers.get(targetMemberId);
    if (existing) {
      const state = existing.pc.connectionState;
      if (state === "connected" || state === "connecting") return;
      this.removePeer(targetMemberId);
    }

    const entry = await this.createPeer(targetMemberId, false);

    try {
      entry.makingOffer = true;
      // offerToReceiveVideo: true ensures the initial SDP includes a video m-line.
      // Without it, iOS Safari (as the offer initiator) skips video in the SDP,
      // causing renegotiation (screen share added mid-session) to fail silently on iPhone.
      const offer = await entry.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      offer.sdp = applyOpusParams(offer.sdp ?? "");
      await entry.pc.setLocalDescription(offer);
      if (entry.pc.localDescription) {
        this.sendSignal(targetMemberId, {
          type: "offer",
          sdp: entry.pc.localDescription.sdp,
        });
      }
    } catch (err) {
      console.error("WebRTC offer error", err);
    } finally {
      entry.makingOffer = false;
    }
  }

  async handleIncoming(
    fromMemberId: number,
    signal: WebRTCSignal,
  ): Promise<void> {
    let entry = this.peers.get(fromMemberId);

    if (signal.type === "offer") {
      if (!entry) entry = await this.createPeer(fromMemberId, true);

      const offerCollision =
        entry.makingOffer || entry.pc.signalingState !== "stable";
      entry.ignoreOffer = !entry.polite && offerCollision;
      if (entry.ignoreOffer) return;

      try {
        if (offerCollision && entry.polite) {
          await entry.pc.setLocalDescription({ type: "rollback" });
        }
        await entry.pc.setRemoteDescription({
          type: "offer",
          sdp: applyOpusParams(signal.sdp ?? ""),
        });
        for (const c of entry.pendingCandidates) {
          await entry.pc.addIceCandidate(c).catch(() => {});
        }
        entry.pendingCandidates = [];
        const answer = await entry.pc.createAnswer();
        answer.sdp = applyOpusParams(answer.sdp ?? "");
        await entry.pc.setLocalDescription(answer);
        if (entry.pc.localDescription) {
          this.sendSignal(fromMemberId, {
            type: "answer",
            sdp: entry.pc.localDescription.sdp,
          });
        }
      } catch (err) {
        console.error("WebRTC offer handling error", err);
      }
    } else if (signal.type === "answer") {
      if (!entry) return;
      try {
        if (entry.pc.signalingState !== "have-local-offer") return;
        await entry.pc.setRemoteDescription({
          type: "answer",
          sdp: applyOpusParams(signal.sdp ?? ""),
        });
        for (const c of entry.pendingCandidates) {
          await entry.pc.addIceCandidate(c).catch(() => {});
        }
        entry.pendingCandidates = [];
      } catch (err) {
        console.error("WebRTC answer handling error", err);
      }
    } else if (signal.type === "candidate" && signal.candidate) {
      if (!entry) return;
      try {
        if (!entry.pc.remoteDescription) {
          entry.pendingCandidates.push(signal.candidate);
          return;
        }
        await entry.pc.addIceCandidate(signal.candidate);
      } catch (err) {
        if (!entry.ignoreOffer)
          console.error("WebRTC ICE candidate error", err);
      }
    }
  }

  // Returns the cached remote video stream for a peer (survives stop→restart cycles)
  getRemoteVideoStream(memberId: number): MediaStream | null {
    return this.remoteVideoStreams.get(memberId) ?? null;
  }

  // Returns the first cached remote video stream (screen share — there is only one host)
  getAnyRemoteVideoStream(): MediaStream | null {
    return this.remoteVideoStreams.values().next().value ?? null;
  }

  preUnlockAudio(memberId: number): void {
    const entry = this.peers.get(memberId);
    if (entry) {
      entry.audio.play().catch(() => {});
    }
  }

  resumeAllAudio(): void {
    for (const [, entry] of this.peers) {
      if (entry.audio.paused) {
        entry.audio.play().catch(() => {});
      }
    }
  }

  setRemoteVolume(memberId: number, volume: number): void {
    const entry = this.peers.get(memberId);
    if (entry) {
      entry.audio.volume = Math.max(0, Math.min(1, volume));
    }
  }

  removePeer(memberId: number): void {
    const entry = this.peers.get(memberId);
    if (!entry) return;
    // Cancel any pending "disconnected" recovery timer before tearing down.
    if (entry.reconnectTimer !== null) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
    // إلغاء مراقبة الـ adaptive bitrate
    const abrKey = `abr-${memberId}`;
    const abrInterval = (this as unknown as Record<string, ReturnType<typeof setInterval>>)[abrKey];
    if (abrInterval) {
      clearInterval(abrInterval);
      delete (this as unknown as Record<string, ReturnType<typeof setInterval>>)[abrKey];
    }
    // [FIX-ABR-STATS] Clear delta-loss baseline so a reconnect starts fresh.
    delete (this as unknown as Record<string, unknown>)[`abr-prev-${memberId}`];
    entry.pc.ontrack = null;
    entry.pc.onicecandidate = null;
    entry.pc.onconnectionstatechange = null;
    entry.pc.onnegotiationneeded = null;
    entry.pc.close();
    entry.audio.pause();
    entry.audio.srcObject = null;
    if (entry.audio.parentNode) entry.audio.parentNode.removeChild(entry.audio);
    this.peers.delete(memberId);
    this.remoteVideoStreams.delete(memberId);
    this.lastQualityByPeer.delete(memberId);
    // لو مافيش اتصالات متبقية، نخبر الـ UI
    this.notifyNoPeers();
  }

  destroy(): void {
    for (const memberId of [...this.peers.keys()]) {
      this.removePeer(memberId);
    }
    this.localStream = null;
    this.screenStream = null;
  }
}