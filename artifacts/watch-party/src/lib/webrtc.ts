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
  // Android: "disconnected" state timer — wait 5 s before attempting ICE restart
  // to allow transient network blips to self-recover before we intervene.
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

// ─── ICE Servers ─────────────────────────────────────────────────────────────
// ICE server list — ordered so Android devices (which often sit behind strict NAT/firewalls)
// prefer TCP on port 443 first (most likely to penetrate corporate/mobile firewalls),
// then fall back to UDP. Multiple independent TURN providers are listed so a single
// provider outage does not take down all connections.
const ICE_SERVERS: RTCIceServer[] = [
  // ── STUN (no relay, used for direct peer connections) ──────────────────────
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },

  // ── Metered free TURN — reliable, global edge network ──────────────────────
  // TCP/443 first: punches through most Android mobile firewalls
  {
    urls: "turns:global.relay.metered.ca:443?transport=tcp",
    username: "e499b2a4d1c3dda31be30f2a",
    credential: "uqBpJFSFuKvKfGtj",
  },
  {
    urls: "turn:global.relay.metered.ca:443",
    username: "e499b2a4d1c3dda31be30f2a",
    credential: "uqBpJFSFuKvKfGtj",
  },
  {
    urls: "turn:global.relay.metered.ca:80?transport=tcp",
    username: "e499b2a4d1c3dda31be30f2a",
    credential: "uqBpJFSFuKvKfGtj",
  },
  {
    urls: "turn:global.relay.metered.ca:80",
    username: "e499b2a4d1c3dda31be30f2a",
    credential: "uqBpJFSFuKvKfGtj",
  },

  // ── Numb (Citrix) — long-running public TURN fallback ──────────────────────
  {
    urls: "turn:numb.viagenie.ca",
    username: "webrtc@live.com",
    credential: "muazkh",
  },
  {
    urls: "turn:numb.viagenie.ca?transport=tcp",
    username: "webrtc@live.com",
    credential: "muazkh",
  },

  // ── Freeturn.net — additional public TURN fallback ─────────────────────────
  {
    urls: "turn:freeturn.net:3478",
    username: "free",
    credential: "free",
  },
  {
    urls: "turns:freeturn.net:5349",
    username: "free",
    credential: "free",
  },
];

// ─── Optimal Mic Capture ──────────────────────────────────────────────────────
export async function getMicStream(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
        sampleRate: 48000,
        sampleSize: 16,
        channelCount: 1,
      },
      video: false,
    });
  } catch {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch {
      return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }
  }
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
function applyOpusParams(sdp: string): string {
  const match = sdp.match(/a=rtpmap:(\d+) opus\/48000/i);
  if (!match) return sdp;
  const pt = match[1];
  let out = sdp.replace(new RegExp(`a=fmtp:${pt}[^\r\n]*\r\n`, "g"), "");
  const fmtp = `a=fmtp:${pt} maxaveragebitrate=510000;useinbandfec=1;usedtx=1;cbr=0;minptime=10;ptime=10\r\n`;
  out = out.replace(
    new RegExp(`(a=rtpmap:${pt} opus/48000[^\r\n]*\r\n)`, "i"),
    `$1${fmtp}`,
  );
  return out;
}

// ─── WebRTC Manager ───────────────────────────────────────────────────────────
export class WebRTCManager {
  private peers = new Map<number, PeerEntry>();
  private localStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private sendSignal: SignalSender;
  private onRemoteScreenStream: ScreenStreamCallback | null;
  // Cache remote video streams so stop→restart reuse the same stream object
  private remoteVideoStreams = new Map<number, MediaStream>();

  constructor(
    sendSignal: SignalSender,
    onRemoteScreenStream?: ScreenStreamCallback,
  ) {
    this.sendSignal = sendSignal;
    this.onRemoteScreenStream = onRemoteScreenStream ?? null;
  }

  setStream(stream: MediaStream) {
    this.localStream = stream;
    for (const [, entry] of this.peers) {
      const senders = entry.pc.getSenders();
      const audioTrack = stream?.getAudioTracks()[0] ?? null;
      const existingSender = senders.find((s) => s.track?.kind === "audio");
      if (existingSender) {
        if (audioTrack) existingSender.replaceTrack(audioTrack).catch(() => {});
        else existingSender.replaceTrack(null).catch(() => {});
      } else if (audioTrack) {
        entry.pc.addTrack(audioTrack, stream);
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

  private createPeer(memberId: number, polite: boolean): PeerEntry {
    const pc = new RTCPeerConnection({
      iceServers: ICE_SERVERS,
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
      reconnectTimer: null,
    };
    this.peers.set(memberId, entry);

    // Add local audio track if available
    if (this.localStream) {
      for (const track of this.localStream.getAudioTracks()) {
        pc.addTrack(track, this.localStream);
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
        this.applyAudioEncodingParams(pc);
        this.applyVideoEncodingParams(pc);
      } else if (pc.connectionState === "disconnected") {
        // Android Chrome frequently lands here on transient network blips (e.g. switching
        // between Wi-Fi and mobile data). Give the browser 5 s to self-recover before we
        // kick off an ICE restart; the browser's own ICE keep-alive may restore the
        // connection without intervention.
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
        }, 5000);
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

  private applyAudioEncodingParams(pc: RTCPeerConnection) {
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== "audio") continue;
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      for (const enc of params.encodings) {
        enc.maxBitrate = 510000;
        enc.priority = "high";
        enc.networkPriority = "high";
      }
      sender.setParameters(params).catch(() => {});
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

    const entry = this.createPeer(targetMemberId, false);

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
      if (!entry) entry = this.createPeer(fromMemberId, true);

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
  }

  destroy(): void {
    for (const memberId of [...this.peers.keys()]) {
      this.removePeer(memberId);
    }
    this.localStream = null;
    this.screenStream = null;
  }
}
