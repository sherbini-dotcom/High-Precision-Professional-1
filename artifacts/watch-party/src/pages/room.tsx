import { useState, useEffect, useRef, useCallback } from "react";
import { useRoute, useLocation } from "wouter";
import { useGetRoom, useGetVideoStatus, useListBans, useUnbanMember, getListBansQueryKey, useSetRoomPrivacy } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { getSession, saveSession, clearSession } from "@/lib/storage";
import { connectSocket, disconnectSocket } from "@/lib/socket";
import type { Socket } from "socket.io-client";
import { WebRTCManager, getMicStream, type NetworkQuality } from "@/lib/webrtc";
import type { WebRTCSignal } from "@/lib/webrtc";
import {
  Film, Upload, Users, Mic, MicOff, Copy, Check, Shield,
  Crown, User, Volume2, Ban, Trash2, LogOut, Link, Loader2,
  Lock, Play, Pause, AlertCircle, WifiOff, Maximize, Minimize,
  SkipForward, SkipBack, Globe, X, UserCheck, MessageSquare, Send,
  ShieldOff, RefreshCw, Bell, BellOff, Monitor, MonitorOff, ChevronLeft, ArrowLeft, ArrowRight
} from "lucide-react";
import CineStream, { type CineState, DEFAULT_CINE_STATE } from "@/components/CineStream";
import Hyperbeam from "@hyperbeam/web";

interface Member {
  id: number;
  roomId: number;
  name: string;
  role: string;
  isMuted: boolean;
  joinedAt: string;
  isOnline?: boolean;
}

interface JoinRequest { memberId: number; name: string; }

interface ChatMessage {
  id: string;
  memberId: number;
  name: string;
  message: string;
  timestamp: number;
  replyTo?: { memberId: number; name: string; message: string };
  imageData?: string;
  reactions?: Record<string, number[]>;
}

function formatTime(sec: number): string {
  if (!isFinite(sec) || isNaN(sec) || sec < 0) return "0:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}


export default function Room() {
  const [, params] = useRoute("/room/:code");
  const code = params?.code?.toUpperCase() ?? "";
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  const session = getSession(code);
  const sessionToken = session?.sessionToken ?? "";
  const myMemberId = session?.memberId ?? 0;
  const myName = session?.name ?? "";

  const [myRole, setMyRole] = useState<string>(session?.role ?? "guest");
  const isPrivileged = myRole === "host" || myRole === "admin";

  const [members, setMembers] = useState<Member[]>([]);
  const [speakingState, setSpeakingState] = useState<Record<number, number>>({});
  // مؤشر جودة الشبكة: good=أخضر / fair=أصفر / poor=أحمر / none=مافيش peers
  const [networkQuality, setNetworkQuality] = useState<NetworkQuality>("none");
  const [videoHlsPath, setVideoHlsPath] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadSpeed, setUploadSpeed] = useState<number | null>(null);
  const [uploadRemaining, setUploadRemaining] = useState<number | null>(null);
  const uploadXhrRef = useRef<XMLHttpRequest | null>(null);
  const uploadStartRef = useRef<number>(0);
  const uploadFileSize = useRef<number>(0);
  const [isConnected, setIsConnected] = useState(false);
  const [copied, setCopied] = useState(false);
  // MOD #6: invite copy feedback state
  const [copiedInvite, setCopiedInvite] = useState(false);
  const [micEnabled, setMicEnabled] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [kicked, setKicked] = useState(false);
  const [banned, setBanned] = useState(false);
  const [pendingApproval, setPendingApproval] = useState(false);
  const [joinRejected, setJoinRejected] = useState(false);
  const [joinRequests, setJoinRequests] = useState<JoinRequest[]>([]);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isBrowserFullscreen, setIsBrowserFullscreen] = useState(false);
  const [iosFullscreenControlsVisible, setIOSFullscreenControlsVisible] = useState(true);
  const iosFullscreenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isMobileDevice = isIOSDevice || /Android/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1;
  // FIX-DESKTOP-FULLSCREEN: على iOS نحتاج تبديل الـ container لما isBrowserFullscreen يتغير،
  // لذلك نمرره كـ dep. على desktop، native fullscreen يكفي بدون إعادة mount للـ SDK،
  // فنمرر null (ثابت) عشان useEffect ميشتغلش تاني لما يدخل/يخرج من fullscreen.
  const iosBrowserFullscreen = isIOSDevice ? isBrowserFullscreen : null;
  const [isLandscape, setIsLandscape] = useState(() => window.matchMedia("(orientation: landscape)").matches);
  const [browserWidened, setBrowserWidened] = useState(false);
  const [iosViewport, setIosViewport] = useState({ w: window.innerWidth, h: window.innerHeight, t: 0 });
  const browserContainerRef = useRef<HTMLDivElement>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [browserControlsVisible, setBrowserControlsVisible] = useState(true);
  const [tapToPlay, setTapToPlay] = useState(false);
  useEffect(() => { tapToPlayRef.current = tapToPlay; }, [tapToPlay]);
  const pendingPlayTimeRef = useRef(0);

  const [mode, setMode] = useState<"video" | "browser" | "screenshare" | "movies">("video");
  const [cineState, setCineState] = useState<CineState>(DEFAULT_CINE_STATE);
  const cineStateRef = useRef<CineState>(DEFAULT_CINE_STATE);
  useEffect(() => { cineStateRef.current = cineState; }, [cineState]);
  const [cineDirectUrl, setCineDirectUrl] = useState("");
  const [cineSubtitleUrl, setCineSubtitleUrl] = useState("");
  const [hyperbeamEmbed, setHyperbeamEmbed] = useState<string | null>(null);
  const [hyperbeamAdminToken, setHyperbeamAdminToken] = useState<string | null>(null);
  const [startingBrowser, setStartingBrowser] = useState(false);
  const hbContainerRef    = useRef<HTMLDivElement>(null);
  const hbIOSContainerRef = useRef<HTMLDivElement>(null);
  const hbInstanceRef     = useRef<{ destroy?: () => void } | null>(null);
  // FIX-FULLSCREEN: ref يتابع isBrowserFullscreen عشان socket handlers تقدر تقراه بدون stale closure
  const isBrowserFullscreenRef = useRef(false);

  // Screen Share state
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [remoteScreenStream, setRemoteScreenStream] = useState<MediaStream | null>(null);
  const [screenShareError, setScreenShareError] = useState<string | null>(null);
  const [iosNeedsTap, setIosNeedsTap] = useState(false);
  // iOS custom fullscreen overlay for screen share (مثل Hyperbeam تماماً)
  const [isSSIOSFullscreen, setIsSSIOSFullscreen] = useState(false);
  const [ssIOSControlsVisible, setSSIOSControlsVisible] = useState(true);
  const ssIOSTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // video element داخل الـ iOS overlay — يشارك نفس الـ srcObject
  const screenVideoIOSRef = useRef<HTMLVideoElement>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement>(null);
  const webrtcManagerRef = useRef<WebRTCManager | null>(null);

  // MOD #10: access control state
  const [accessControlEnabled, setAccessControlEnabled] = useState(false);
  const [isPrivateLocal, setIsPrivateLocal] = useState<boolean | null>(null);

  const [panelOpen, setPanelOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"members" | "bans" | "chat">("members");

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [showStickerPanel, setShowStickerPanel] = useState(false);
  const [reactionPickerFor, setReactionPickerFor] = useState<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  // Floating notification toast (chat message or member join)
  const [chatToast, setChatToast] = useState<{ name: string; text: string; tab: "chat" | "members" | "joinApproved" | "joinRejected" | "joinRequest"; memberId?: number } | null>(null);
  const chatToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Refs so socket callbacks (captured at mount) always see the latest panel state
  const panelOpenRef = useRef(false);
  const activeTabRef = useRef<"members" | "bans" | "chat">("members");
  // Track which member IDs were online last update so we can detect new joins
  const prevOnlineMembersRef = useRef<Set<number>>(new Set());
  const [swipingMsgIdx, setSwipingMsgIdx] = useState<number | null>(null);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const touchStartXRef = useRef(0);
  const touchStartYRef = useRef(0);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);
  // Toast swipe-to-dismiss
  const [toastSwipe, setToastSwipe] = useState({ x: 0, y: 0 });
  const toastTouchRef = useRef({ x: 0, y: 0 });

  const [notifSoundEnabled, setNotifSoundEnabled] = useState(true);
  const notifSoundEnabledRef = useRef(true);
  const [bellPulse, setBellPulse] = useState(false);
  useEffect(() => { notifSoundEnabledRef.current = notifSoundEnabled; }, [notifSoundEnabled]);
  useEffect(() => { panelOpenRef.current = panelOpen; }, [panelOpen]);
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);

  // FIX SOUND-STUCK: إشعار اتعلق لأن الـ context كان suspended والـ resume فشل من غير user gesture.
  // نخزن النوع هنا ونشغله أول ما المستخدم يلمس الشاشة في tryResumeAudio.
  const pendingSoundTypeRef = useRef<"request" | "message" | null>(null);
  // Stable ref to playNotifSound so tryResumeAudio (defined in a [] effect) can call it
  const playNotifSoundRef = useRef<((type: "request" | "message") => void) | null>(null);


  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    // FIX TOAST-POS: نعيد القياس لما pendingApproval يتغير
    // لأن لما pendingApproval=true الـ header مش بيتعرض فـ headerH بيفضل 0
    // ولما approval بييجي والـ header يظهر للأول مرة لازم نقيسه من جديد
    const ro = new ResizeObserver(() => setHeaderH(el.offsetHeight));
    ro.observe(el);
    setHeaderH(el.offsetHeight);
    return () => ro.disconnect();
  }, [pendingApproval]);
  // Clear draft when panel closes so the input is always fresh on reopen
  useEffect(() => { if (!panelOpen) setChatInput(""); }, [panelOpen]);

  // ── Welcome overlay ────────────────────────────────────────────────────────
  const [showWelcome, setShowWelcome] = useState(false);
  const [welcomeLeaving, setWelcomeLeaving] = useState(false);
  const welcomeShownRef = useRef(!!sessionStorage.getItem(`welcome_shown_${code}`));
  const welcomeSoundPendingRef = useRef(false);

  const triggerBellPulse = useCallback(() => {
    setBellPulse(true);
    setTimeout(() => setBellPulse(false), 600);
  }, []);

  // Auto-recover AudioContext on ANY user interaction (touch or click anywhere on the page).
  // iOS/Android suspend the AudioContext when the tab goes to background or the screen locks.
  // Listening passively on every touchstart/click lets us silently resume the moment the user
  // next touches the screen — completely eliminating the manual mute→unmute workaround.
  useEffect(() => {
    const tryResumeAudio = () => {
      const ctx = audioPlayerRef.current;
      if (!ctx) return;
      if (ctx.state === "closed") {
        // Context is dead — recreate it and restart the silent keep-alive
        try {
          const AudioCtxClass = window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
          if (!AudioCtxClass) return;
          const newCtx = new AudioCtxClass();
          audioPlayerRef.current = newCtx;
          // [FIX-WORKLET-PRELOAD-RESUME] Also preload the worklet on the recreated
          // context so the next mic toggle doesn't hit the 50-200ms addModule delay.
          newCtx.audioWorklet
            .addModule("/audio-processor.js")
            .then(() => { workletModuleLoadedForCtxRef.current = audioPlayerRef.current; })
            .catch(() => { /* non-fatal — toggleMic will retry */ });
          try {
            const buf = newCtx.createBuffer(1, newCtx.sampleRate, newCtx.sampleRate);
            const ch2 = buf.getChannelData(0);
            for (let i = 0; i < ch2.length; i++) ch2[i] = (Math.random() * 2 - 1) * 0.0005;
            const src = newCtx.createBufferSource();
            src.buffer = buf;
            src.loop = true;
            const gain = newCtx.createGain();
            gain.gain.value = 0.001;
            src.connect(gain);
            gain.connect(newCtx.destination);
            src.start();
            silentKeepAliveRef.current = src;
          } catch { /* ignore */ }
        } catch { /* ignore */ }
      } else if (ctx.state === "suspended") {
        ctx.resume()
          .then(() => {
            // Restart silent keep-alive after resume so iOS keeps the audio session alive
            try {
              const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
              const ch = buf.getChannelData(0);
              for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * 0.0005;
              const src = ctx.createBufferSource();
              src.buffer = buf;
              src.loop = true;
              const gain = ctx.createGain();
              gain.gain.value = 0.001;
              src.connect(gain);
              gain.connect(ctx.destination);
              src.start();
              silentKeepAliveRef.current = src;
            } catch { /* ignore */ }
            // FIX SOUND-STUCK: play any notification that arrived while ctx was suspended.
            // We deferred it because resume() without a user gesture silently fails on iOS.
            // Now we ARE inside a user-gesture handler so it works.
            const pending = pendingSoundTypeRef.current;
            if (pending) {
              pendingSoundTypeRef.current = null;
              setTimeout(() => { playNotifSoundRef.current?.(pending); }, 50);
            }
          })
          .catch(() => {});
      }
    };
    document.addEventListener("touchstart", tryResumeAudio, { passive: true, capture: true });
    document.addEventListener("click", tryResumeAudio, { capture: true });
    return () => {
      document.removeEventListener("touchstart", tryResumeAudio, { capture: true });
      document.removeEventListener("click", tryResumeAudio, { capture: true });
    };
  }, []);

  const playNotifSound = useCallback((type: "request" | "message") => {
    triggerBellPulse();
    if (!notifSoundEnabledRef.current) return;
    try {
      // Reuse the shared audioPlayerRef to avoid Android's 6-AudioContext limit.
      // If not yet initialised (no user interaction yet) skip — iOS blocks new
      // AudioContext creation outside a user gesture anyway.
      const ctx = audioPlayerRef.current;
      if (!ctx || ctx.state === "closed") return;

      const scheduleNotes = (c: AudioContext) => {
        const playNote = (freq: number, startAt: number, dur: number, vol: number, wave: OscillatorType = "sine") => {
          const osc = c.createOscillator();
          const gain = c.createGain();
          osc.type = wave;
          osc.frequency.setValueAtTime(freq, startAt);
          gain.gain.setValueAtTime(0, startAt);
          gain.gain.linearRampToValueAtTime(vol, startAt + 0.01);
          gain.gain.exponentialRampToValueAtTime(0.001, startAt + dur);
          osc.connect(gain);
          gain.connect(c.destination);
          osc.start(startAt);
          osc.stop(startAt + dur);
        };
        const t = c.currentTime;
        if (type === "request") {
          playNote(523.25, t,        0.35, 0.28, "sine");
          playNote(659.25, t + 0.14, 0.35, 0.25, "sine");
          playNote(783.99, t + 0.28, 0.45, 0.22, "sine");
          playNote(1046.5, t + 0.28, 0.45, 0.08, "triangle");
        } else {
          playNote(1318.5, t,        0.3,  0.18, "sine");
          playNote(1046.5, t + 0.12, 0.45, 0.15, "sine");
          playNote(2093,   t,        0.2,  0.04, "triangle");
        }
      };

      // FIX SOUND-STUCK: على iOS/Android، الـ resume() من غير user gesture بيرجع resolved
      // لكن الصوت الفعلي مش بيشتغل. الحل: نخزن نوع الإشعار في ref ونشغله في
      // tryResumeAudio أول ما المستخدم يلمس الشاشة (user gesture حقيقي).
      if (ctx.state === "suspended") {
        pendingSoundTypeRef.current = type;
        // حاول resume بدون أمل كبير — لو نجح تمام، لو لا tryResumeAudio بيعمله
        ctx.resume().then(() => {
          const pending = pendingSoundTypeRef.current;
          if (pending) {
            pendingSoundTypeRef.current = null;
            setTimeout(() => { scheduleNotes(ctx); }, 50);
          }
        }).catch(() => { /* deferred to tryResumeAudio on next user touch */ });
      } else {
        scheduleNotes(ctx);
      }
    } catch { /* ignore */ }
  }, [triggerBellPulse]);
  // FIX: نحدث الـ ref مباشرة بعد التعريف (بدل useEffect) عشان نتجنب "used before declaration"
  playNotifSoundRef.current = playNotifSound;

  const playWelcomeSound = useCallback(() => {
    try {
      const AudioCtxClass = window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtxClass) return;
      let ctx = audioPlayerRef.current;
      if (!ctx || ctx.state === "closed") {
        ctx = new AudioCtxClass();
        audioPlayerRef.current = ctx;
      }
      const scheduleNotes = (c: AudioContext) => {
        const playNote = (freq: number, startAt: number, dur: number, vol: number) => {
          const osc = c.createOscillator();
          const gain = c.createGain();
          osc.type = "sine";
          osc.frequency.setValueAtTime(freq, startAt);
          gain.gain.setValueAtTime(0, startAt);
          gain.gain.linearRampToValueAtTime(vol, startAt + 0.04);
          gain.gain.exponentialRampToValueAtTime(0.001, startAt + dur);
          osc.connect(gain);
          gain.connect(c.destination);
          osc.start(startAt);
          osc.stop(startAt + dur);
        };
        const t = c.currentTime;
        // Modern 3-note chime: A5 → C#6 → E6 (clean A-major ascending ping)
        playNote(880.00, t,        0.55, 0.15); // A5
        playNote(1108.7, t + 0.13, 0.55, 0.13); // C#6
        playNote(1318.5, t + 0.26, 0.90, 0.12); // E6 (long resolve)
      };
      if (ctx.state === "suspended") {
        ctx.resume().then(() => scheduleNotes(ctx!)).catch(() => {});
      } else {
        scheduleNotes(ctx);
      }
    } catch { /* ignore */ }
  }, []);

  // Tracks whether THIS client initiated the current upload.
  // Only the uploader should emit uploadEnded — emitting it from every client
  // causes the server to delete the room timeline and stop periodic sync
  // for every guest that receives videoReady, which breaks sync for everyone.
  const isUploadingRef = useRef(false);

  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerH, setHeaderH] = useState(0);
  const socketRef = useRef<Socket | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<unknown>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isPlayingRef = useRef(false);
  const seekingRef = useRef(false);
  const isRemoteControlRef = useRef(false);
  const isLocalControlRef = useRef(false);
  const localControlTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingVideoSyncRef = useRef<{ targetTime: number; shouldPlay: boolean; storedAt: number } | null>(null);
  const isSyncActiveRef = useRef(false);         // debounce: prevents concurrent seeks
  const canPlaySyncedRef = useRef(false);        // prevents canplay firing on every HLS segment
  const tapToPlayRef = useRef(false);            // iOS: play() was blocked — skip heartbeat sync until user taps
  // NO nativeIOSFullscreenRef — we read webkitDisplayingFullscreen directly (more reliable than events
  // because the webkitbeginfullscreen listener can't be attached when video is not yet in the DOM)
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const browserControlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks the last play() promise so safePause can wait for it before pausing,
  // preventing "play() interrupted by pause()" AbortErrors in the console.
  const playPromiseRef = useRef<Promise<void> | null>(null);
  // [FIX] workletNodeRef replaces the deprecated ScriptProcessorNode.
  // AudioWorkletNode runs in a dedicated audio thread — never blocked by React
  // renders or network I/O — giving glitch-free capture on weak connections.
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  // [FIX-CLEANUP] Keep refs to all mic graph nodes so stopMic() can disconnect
  // them explicitly before closing the context — prevents memory leaks on Android.
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micCompressorRef = useRef<DynamicsCompressorNode | null>(null);
  const micGainRef = useRef<GainNode | null>(null);
  // [FIX-WEBRTC-PROCESSED-AUDIO] Destination node that receives the PROCESSED
  // signal (compressor + makeup gain) and is what we actually hand to WebRTC.
  // Previously WebRTCManager.setStream() was given the raw getUserMedia stream
  // directly, so the entire compressor/gain chain built below only ever fed the
  // volume meter and the Socket.IO fallback worklet — the common-case WebRTC
  // path carried completely unprocessed audio (no AGC, since we disabled the
  // browser's own AGC to avoid double-AGC with a compressor that, in practice,
  // never reached that path). Now both paths hear the same processed signal.
  const micDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  // [FIX-WORKLET-CACHE] Track which AudioContext instance already had the worklet
  // module registered. addModule() is idempotent on the same context but still
  // fires a network request every call — causing 50-200ms of startup delay on
  // every mic toggle after the first. Skipping it when the module is already
  // registered makes subsequent mic opens feel instant.
  const workletModuleLoadedForCtxRef = useRef<AudioContext | null>(null);
  const audioPlayerRef = useRef<AudioContext | null>(null);
  const silentKeepAliveRef = useRef<AudioBufferSourceNode | null>(null);
  const wasPlayingBeforeHiddenRef = useRef(false);
  const nextAudioTimeRef = useRef<Map<number, number>>(new Map());
  // [FIX-SEQ] Per-speaker last-received sequence number — used to detect and
  // discard out-of-order audio packets on lossy connections.
  const lastAudioSeqRef = useRef<Map<number, number>>(new Map());
  // [FIX-CLICK] One persistent DynamicsCompressor per speaker.
  // Creating a new compressor for every 170ms chunk made it start from zero each
  // time → abrupt gain-reduction jumps → audible clicking. A persistent node
  // keeps the compressor's gain-reduction history between chunks → smooth audio.
  const speakerCompressorsRef = useRef<Map<number, DynamicsCompressorNode>>(new Map());
  // [FIX-ADAPTIVE-JITTER] Per-speaker adaptive cushion (seconds). Starts at 120ms,
  // grows when bursts are detected (Socket.IO TCP stalls), shrinks when network is clean.
  const jitterCushionRef = useRef<Map<number, number>>(new Map());

  // ── [FIX-1-JITTER-QUEUE] Per-speaker MinHeap ordered by seq ───────────────
  // Replaces the old "schedule immediately on arrival" approach.
  // Incoming chunks are pushed into a per-speaker heap; a scheduler loop drains
  // them in seq order at the correct audioContext time, preventing burst-induced
  // out-of-order playback and the silence gaps that followed.
  type JitterChunk = {
    seq: number;
    audioBuf: AudioBuffer;
    // audioTime from the worklet clock at the moment the chunk was produced.
    // Used for scheduling even when the main-thread Date.now() has drifted.
    audioTime: number | undefined;
  };
  // MinHeap keyed by seq so the lowest seq is always at index 0.
  class SeqMinHeap {
    private h: JitterChunk[] = [];
    push(c: JitterChunk) {
      this.h.push(c);
      let i = this.h.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (this.h[p].seq <= this.h[i].seq) break;
        [this.h[p], this.h[i]] = [this.h[i], this.h[p]];
        i = p;
      }
    }
    pop(): JitterChunk | undefined {
      if (!this.h.length) return undefined;
      const top = this.h[0];
      const last = this.h.pop()!;
      if (this.h.length) {
        this.h[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = 2 * i + 2;
          let s = i;
          if (l < this.h.length && this.h[l].seq < this.h[s].seq) s = l;
          if (r < this.h.length && this.h[r].seq < this.h[s].seq) s = r;
          if (s === i) break;
          [this.h[i], this.h[s]] = [this.h[s], this.h[i]];
          i = s;
        }
      }
      return top;
    }
    peek(): JitterChunk | undefined { return this.h[0]; }
    get size() { return this.h.length; }
    clear() { this.h = []; }
  }
  // Per-speaker jitter heaps and their drain-loop interval handles.
  const jitterQueuesRef = useRef<Map<number, SeqMinHeap>>(new Map());
  const jitterDrainTimersRef = useRef<Map<number, ReturnType<typeof setInterval>>>(new Map());
  const micEnabledRef = useRef(false);
  // [FIX-BG-MIC] Set to true when we go to background with the mic ON.
  // On iOS/Android the mic track silently dies in background — readyState may
  // still say "live" and muted may already be cleared by the time visibilitychange
  // fires on return. This flag lets handleForeground force a recovery even when
  // the track LOOKS healthy, since we know it was interrupted.
  const micWasOnBeforeHiddenRef = useRef(false);
  const membersRef = useRef<Member[]>([]);
  // NTP-style clock offset: server_clock - local_clock (ms)
  const serverClockOffsetRef = useRef<number>(0);
  const clockSyncSamplesRef = useRef<number[]>([]);
  // Drift report throttle — last time we emitted driftReport to server (ms)
  const lastDriftReportRef = useRef<number>(0);
  // iOS: cooldown to avoid calling syncToTarget on playMismatch more than once per 3s
  const lastPlayMismatchSyncRef = useRef<number>(0);
  // Sequence number: ignore syncState events older than what we already applied
  const lastSyncSeqRef = useRef<number>(-1);
  // Scheduled play timeout — cleared when a newer syncState cancels the pending play
  const scheduledPlayTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks the active bufferCheck jitter timer so it can be cancelled when a
  // newer bufferCheck or a syncState arrives (prevents stale pre-seeks).
  const bufferCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Privileged users: suppress applying syncState for 2.5s after any local action
  // (seek/play/pause). Prevents the server's echo from reverting the local change.
  const suppressSyncUntilRef = useRef<number>(0);
  // iOS fullscreen: poll currentTime so external seekbar stays in sync with native controls
  const iosFullscreenPollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data: bans, isLoading: bansLoading, refetch: refetchBans } = useListBans(code, {
    request: { headers: { "x-session-token": sessionToken } },
    query: {
      enabled: !!code && !!sessionToken && isPrivileged && panelOpen && activeTab === "bans",
      queryKey: getListBansQueryKey(code),
    },
  });
  const unban = useUnbanMember({
    request: { headers: { "x-session-token": sessionToken } },
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListBansQueryKey(code) });
      },
    },
  });

  const { data: roomData } = useGetRoom(code, { query: { enabled: !!code, queryKey: [code, "room"] } });
  const setPrivacyMutation = useSetRoomPrivacy({
    request: { headers: { "x-session-token": sessionToken } },
    mutation: { onSuccess: () => queryClient.invalidateQueries({ queryKey: [code, "room"] }) },
  });
  const { data: videoStatus, refetch: refetchVideoStatus } = useGetVideoStatus(code, {
    query: { enabled: !!code, queryKey: [code, "videoStatus"], refetchInterval: videoHlsPath ? false : 5000 }
  });

  useEffect(() => { micEnabledRef.current = micEnabled; }, [micEnabled]);
  useEffect(() => { membersRef.current = members; }, [members]);
  // Ref so socket handlers always read the latest isPrivileged without re-registering
  const isPrivilegedRef = useRef(isPrivileged);
  useEffect(() => { isPrivilegedRef.current = isPrivileged; }, [isPrivileged]);
  // Track whether we've already sent the initial batch of WebRTC offers on join
  const webrtcInitiatedRef = useRef(false);

  // ── Media Session API ─────────────────────────────────────────────────────
  // Registers the page as an active media app with the OS. This is the primary
  // mechanism that keeps iOS from aggressively suspending the tab when the screen
  // locks: iOS shows lock screen controls and keeps the audio session alive only
  // when mediaSession is set up. Also provides Android notification controls.
  // FIX IOS-BG: MediaSession دايماً شغال بغض النظر عن الفيديو
  // iOS بيوقف الـ tab في الخلفية لو مفيش media session نشط
  // الحل: نضبط الـ metadata فوراً لما المستخدم يدخل الغرفة
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: "Watch Party",
        artist: `Room ${code}`,
      });
      // يقول لـ iOS "في ميديا شغالة" عشان يحافظ على الـ tab حي
      navigator.mediaSession.playbackState = "playing";
    } catch { /* ignore */ }
    return () => {
      try { navigator.mediaSession.metadata = null; } catch { /* ignore */ }
      try { navigator.mediaSession.playbackState = "none"; } catch { /* ignore */ }
    };
  }, [code]);

  // Video-specific MediaSession action handlers (play/pause/seek من شاشة القفل)
  useEffect(() => {
    if (!videoHlsPath || !("mediaSession" in navigator)) return;

    // Lock screen play/pause — privileged only. Guests are completely blocked so the
    // lock screen controls cannot bypass the in-app guest restrictions.
    const msPlay = () => {
      const v = videoRef.current;
      if (!v || !isPrivilegedRef.current) return;
      v.play().catch(() => {});
      socketRef.current?.emit("videoControl", { action: "play", currentTime: v.currentTime });
    };
    const msPause = () => {
      const v = videoRef.current;
      if (!v || !isPrivilegedRef.current) return;
      v.pause();
      socketRef.current?.emit("videoControl", { action: "pause", currentTime: v.currentTime });
    };
    // Lock screen ±10 s seek (host only — guests snap back on next sync)
    const msSeekBack = ({ seekOffset }: { seekOffset?: number }) => {
      const v = videoRef.current;
      if (!v || !isPrivilegedRef.current) return;
      const t = Math.max(0, v.currentTime - (seekOffset ?? 10));
      isLocalControlRef.current = true;
      v.currentTime = t;
      // Re-call play() inside the mediaSession handler (has user-gesture context).
      // Without this, iOS stops audio during the seek rebuffer and never resumes
      // it in background — user hears silence until they open the app.
      if (!v.paused) v.play().catch(() => {});
      socketRef.current?.emit("videoControl", { action: "seek", currentTime: t });
      setTimeout(() => { isLocalControlRef.current = false; }, 500);
    };
    const msSeekFwd = ({ seekOffset }: { seekOffset?: number }) => {
      const v = videoRef.current;
      if (!v || !isPrivilegedRef.current) return;
      const t = Math.min(isFinite(v.duration) ? v.duration : Infinity, v.currentTime + (seekOffset ?? 10));
      isLocalControlRef.current = true;
      v.currentTime = t;
      // Same as msSeekBack: re-activate audio track inside user-gesture context.
      if (!v.paused) v.play().catch(() => {});
      socketRef.current?.emit("videoControl", { action: "seek", currentTime: t });
      setTimeout(() => { isLocalControlRef.current = false; }, 500);
    };

    try { navigator.mediaSession.setActionHandler("play",         msPlay);     } catch { /* ignore */ }
    try { navigator.mediaSession.setActionHandler("pause",        msPause);    } catch { /* ignore */ }
    try { navigator.mediaSession.setActionHandler("seekbackward", msSeekBack); } catch { /* ignore */ }
    try { navigator.mediaSession.setActionHandler("seekforward",  msSeekFwd);  } catch { /* ignore */ }

    return () => {
      try { navigator.mediaSession.setActionHandler("play",         null); }   catch { /* ignore */ }
      try { navigator.mediaSession.setActionHandler("pause",        null); }   catch { /* ignore */ }
      try { navigator.mediaSession.setActionHandler("seekbackward", null); }   catch { /* ignore */ }
      try { navigator.mediaSession.setActionHandler("seekforward",  null); }   catch { /* ignore */ }
    };
  }, [videoHlsPath, code]);

  // Screen Wake Lock — prevents screen from auto-locking while inside the room
  useEffect(() => {
    if (!("wakeLock" in navigator)) return;
    const requestWakeLock = async () => {
      try {
        wakeLockRef.current = await (navigator as Navigator & { wakeLock: { request: (type: string) => Promise<WakeLockSentinel> } }).wakeLock.request("screen");
      } catch { /* ignore — user may have denied or browser doesn't support */ }
    };
    requestWakeLock();
    // Wake lock is released automatically when page is hidden — re-acquire when visible again
    const onVisibility = () => { if (document.visibilityState === "visible") requestWakeLock(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
    };
  }, []);

  // When a new message arrives while already on the chat tab → smooth scroll
  useEffect(() => {
    if (activeTab === "chat" && panelOpen) {
      chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [chatMessages]);

  // When the user opens the chat tab (or panel opens on chat) → instant jump to bottom
  useEffect(() => {
    if (activeTab === "chat" && panelOpen) {
      chatBottomRef.current?.scrollIntoView({ behavior: "instant" as ScrollBehavior });
      setUnreadCount(0);
    }
  }, [activeTab, panelOpen]);

  useEffect(() => {
    if (!sessionToken || !code) {
      try { localStorage.setItem("wp_join_code", code); } catch { /* ignore */ }
      setLocation("/");
    }
  }, [code, sessionToken]);

  useEffect(() => {
    if (!isIOSDevice) return;
    const vv = window.visualViewport;
    const update = () => {
      setIosViewport({
        w: vv ? Math.round(vv.width) : window.innerWidth,
        h: vv ? Math.round(vv.height) : window.innerHeight,
        t: vv ? Math.round(vv.offsetTop) : 0,
      });
    };
    update();
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    const onOrientationChange = () => setTimeout(update, 50);
    window.addEventListener("orientationchange", onOrientationChange);
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      window.removeEventListener("orientationchange", onOrientationChange);
    };
  }, [isIOSDevice]);

  // ── Service Worker Keep-alive (iOS Background) ──────────────────────────────
  // بيسجّل service worker بيبعت HTTP request كل 25 ثانية.
  // ده بيساعد iOS يحافظ على الـ tab حي في الخلفية عن طريق:
  // 1. إثبات للـ browser إن في network activity مستمر
  // 2. إبقاء الـ SW process نشط حتى لو الـ main thread اتوقف لحظياً
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let swRegistration: ServiceWorkerRegistration | null = null;

    const registerAndStart = async () => {
      try {
        swRegistration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        // انتظر إن الـ SW يبقى active
        const sw = swRegistration.active ?? swRegistration.waiting ?? swRegistration.installing;
        const sendStart = (worker: ServiceWorker) =>
          worker.postMessage({ type: "START_KEEPALIVE" });

        if (swRegistration.active) {
          sendStart(swRegistration.active);
        } else if (sw) {
          sw.addEventListener("statechange", function onState() {
            if ((this as ServiceWorker).state === "activated") {
              sendStart(this as ServiceWorker);
              sw.removeEventListener("statechange", onState);
            }
          });
        }
      } catch { /* بيفشل في بعض المتصفحات - مش مشكلة */ }
    };

    registerAndStart();

    return () => {
      // Stop keepalive لما المستخدم يخرج من الغرفة
      if (swRegistration?.active) {
        swRegistration.active.postMessage({ type: "STOP_KEEPALIVE" });
      }
    };
  }, []);

  useEffect(() => {
    if (!sessionToken || !code) return;

    const socket = connectSocket(code, sessionToken);
    socketRef.current = socket;

    // FIX RE-ENTER: بنعمل الـ AudioContext فوراً لما الـ effect يشتغل لأن المستخدم
    // بيكون لسه في نافذة الـ user gesture من الـ navigation. لو فشل (blocked)
    // بيرجع suspended ونصلحه في tryResumeAudio على أول لمسة.
    const initAudioPlayer = () => {
      if (audioPlayerRef.current) return;
      try {
        const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AudioCtxClass) return;
        // NOTE: Do NOT set latencyHint:"interactive" here — iOS treats that hint
        // as a voice-chat session which loses background audio playback permission.
        // Default (no hint) keeps the "music" session type that iOS allows in background.
        audioPlayerRef.current = new AudioCtxClass();

        // [FIX-WORKLET-PRELOAD] Pre-load the worklet module right after context
        // creation so it's cached by the time the user first presses the mic button.
        // Without this, addModule() runs AFTER the mic press (50-200ms delay) and
        // the opening syllable of the first sentence is silently dropped.
        // toggleMic() guards with workletModuleLoadedForCtxRef so it won't reload.
        audioPlayerRef.current.audioWorklet
          .addModule("/audio-processor.js")
          .then(() => { workletModuleLoadedForCtxRef.current = audioPlayerRef.current; })
          .catch(() => { /* non-fatal — toggleMic will retry */ });

        // iOS keep-alive: loop a buffer with imperceptible low-level noise so iOS
        // detects a real audio signal and keeps the audio session alive on lock screen.
        // An all-zeros buffer (gain 0.0001) is indistinguishable from silence to iOS
        // and it will suspend the session — tiny noise ensures the session stays active.
        try {
          const ctx0 = audioPlayerRef.current;
          const silentBuf = ctx0.createBuffer(1, ctx0.sampleRate, ctx0.sampleRate);
          const ch = silentBuf.getChannelData(0);
          for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * 0.0005;
          const silentSrc = ctx0.createBufferSource();
          silentSrc.buffer = silentBuf;
          silentSrc.loop = true;
          const silentGain = ctx0.createGain();
          silentGain.gain.value = 0.001; // −60 dB: completely inaudible, but real signal
          silentSrc.connect(silentGain);
          silentGain.connect(ctx0.destination);
          silentSrc.start();
          silentKeepAliveRef.current = silentSrc;
        } catch { /* ignore */ }
      } catch { /* ignore — AudioContext not available or blocked on this device */ }
    };
    // نستدعيه فوراً — Navigation IS a user gesture, so this often creates a running context.
    // لو الـ browser رفض (created as suspended) بيصحح tryResumeAudio على أول touchstart.
    initAudioPlayer();
    // Fallback: لو فشل تماماً أو الـ context لسه null، نعيد المحاولة على أول interaction
    const onFirstInteraction = () => {
      initAudioPlayer();
      // لو الـ context اتعمل وحالته suspended، نحاول resume فوراً (ده user gesture)
      if (audioPlayerRef.current?.state === "suspended") {
        audioPlayerRef.current.resume().catch(() => {});
      }
      // اطلب صلاحية الـ browser notification — لازم user gesture
      if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission().catch(() => {});
      }
      document.removeEventListener("touchstart", onFirstInteraction);
      document.removeEventListener("click", onFirstInteraction);
    };
    document.addEventListener("touchstart", onFirstInteraction, { passive: true });
    document.addEventListener("click", onFirstInteraction);

    // مساعد لعرض إشعار OS (يشتغل حتى لو الـ tab مخفية أو الـ browser في الخلفية)
    const showBrowserNotif = (title: string, body: string) => {
      if (!("Notification" in window) || Notification.permission !== "granted") return;
      try { new Notification(title, { body, icon: "/favicon.ico" }); } catch { /* ignore */ }
    };

    // NTP clock sync — compute server_clock - local_clock offset for precise lag compensation
    const doClockSync = () => {
      const t0 = Date.now();
      socket.emit("clockSync", { t0 });
      socket.once("clockSyncAck", ({ t0: echo, t1 }: { t0: number; t1: number }) => {
        const t2 = Date.now();
        const rtt = t2 - echo;
        // Only accept samples with low RTT to reduce noise
        if (rtt > 500) return;
        const offset = t1 - echo - rtt / 2;
        const samples = clockSyncSamplesRef.current;
        samples.push(offset);
        if (samples.length > 10) samples.shift();
        // Use median of samples (robust against outliers)
        const sorted = [...samples].sort((a, b) => a - b);
        serverClockOffsetRef.current = sorted[Math.floor(sorted.length / 2)];

        // FIX-CLOCK-DRIFT-ALERT: if clock offset > 500ms the local clock is
        // too far off for accurate playAt scheduling → force an immediate resync
        // so the server sends a fresh syncState with the corrected timing.
        if (Math.abs(serverClockOffsetRef.current) > 500 && samples.length >= 3) {
          socket.emit("requestSync");
        }
      });
    };

    const handleConnect = () => {
      setIsConnected(true);
      // Reset stale sync lock that may have been left from an in-flight sync
      // at the moment of disconnect (e.g. screen lock on mobile).
      // Without this, the incoming syncState after reconnect hits
      // isSyncActiveRef.current = true and is silently dropped.
      isSyncActiveRef.current = false;
      setIsSyncing(false);
      socket.emit("joinRoom", { roomCode: code, sessionToken });
      // FIX-SYNC-1: requestSync delayed to 1200ms so 3 clockSync samples (0ms, 400ms, 1000ms)
      // complete first → serverClockOffsetRef is calibrated before the first syncState
      // with playAt arrives, preventing guests from scheduling play at the wrong local time.
      setTimeout(() => socket.emit("requestSync"), 1200);
      // Fire clock sync 6 times with increasing delays for maximum accuracy
      [0, 400, 1000, 2500, 5000, 12000].forEach(d => setTimeout(doClockSync, d));
    };
    socket.on("connect", handleConnect);
    socket.on("disconnect", () => setIsConnected(false));

    // If socket already connected before listener was registered (race condition on Android),
    // trigger the connect logic immediately
    if (socket.connected) {
      handleConnect();
    }

    // Liveness probe timer — cleared when clockSyncAck confirms the connection is alive.
    let livenessTimer: ReturnType<typeof setTimeout> | null = null;

    // ── handleForeground ────────────────────────────────────────────────────
    // Single handler shared by visibilitychange, pageshow (Android bfcache restore),
    // and the network online event. Recovers audio, video, socket, and mic after the
    // app returns from the background or after a network interruption.
    const handleForeground = () => {
      // 0. [FIX-IOS-RECONNECT] ICE restart فوري لما المستخدم يرجع من الـ background.
      //    الكود القديم كان ينتظر 5 ثواني قبل ICE restart (في onconnectionstatechange)
      //    + 500ms للـ WebRTCManager destroy/recreate = أكثر من 10 ثواني تأخير على iOS.
      //    نشغّل forceIceRestart هنا فوراً على الـ peers المنقطعة قبل أي حاجة تانية،
      //    وبالتوازي مع باقي الـ recovery steps — بدل ما نستنى.
      webrtcManagerRef.current?.forceIceRestart();

      // 1. Resume AudioContext (suspended by browser on background/lock screen)
      if (audioPlayerRef.current?.state === "suspended") {
        audioPlayerRef.current.resume().catch(() => {});
      }

      // 2. Resume HLS.js segment loading.
      //    Android Chrome stops fetching segments while the tab is backgrounded to
      //    save battery. startLoad(-1) tells hls.js to resume from the current
      //    playback position — without this the video stalls permanently on return.
      const hls = hlsRef.current as { startLoad?: (startPos: number) => void } | null;
      if (hls?.startLoad) { try { hls.startLoad(-1); } catch { /* ignore */ } }

      // 2b. Resume video playback.
      //     iOS and Android always pause the <video> element when the tab is
      //     backgrounded or the screen locks. Try play() immediately on return;
      //     if autoplay policy blocks it, fall back to the "Tap to play" prompt.
      const v = videoRef.current;
      const shouldResume = wasPlayingBeforeHiddenRef.current ||
        (pendingVideoSyncRef.current?.shouldPlay ?? isPlayingRef.current);
      wasPlayingBeforeHiddenRef.current = false;
      if (v && v.paused && shouldResume) {
        v.play().catch(() => {
          tapToPlayRef.current = true;
          setTapToPlay(true);
        });
      } else if (v && !v.paused) {
        // Audio re-activation: when play() is triggered from a background sync
        // (no user gesture), mobile browsers allow the video to play but silently
        // cut the audio track (muted-autoplay policy). The video is NOT paused, so
        // the block above is skipped and the silence persists on return.
        // Re-calling play() with foreground context re-connects the audio output.
        // Also clear an explicit muted flag in case the browser set it.
        if (v.muted) v.muted = false;
        v.play().catch(() => {});
      }

      // 3. Socket liveness check + re-sync.
      //    Android silently drops WebSocket connections when the screen locks.
      //    socket.connected can remain true (zombie state) while no messages
      //    are being delivered. Strategy:
      //      a) If socket is clearly disconnected → reconnect immediately.
      //      b) If socket claims connected → probe with clockSync. If no ack
      //         within 3 s, force a full disconnect + reconnect cycle.
      const s = socketRef.current;
      if (s) {
        if (!s.connected) {
          s.connect();
        } else {
          // Cancel any existing probe so we don't have multiple timers racing.
          if (livenessTimer) { clearTimeout(livenessTimer); livenessTimer = null; }

          livenessTimer = setTimeout(() => {
            livenessTimer = null;
            // No ack received — the connection is a zombie. Kick it.
            const sx = socketRef.current;
            if (sx?.connected) { sx.disconnect(); setTimeout(() => sx.connect(), 150); }
          }, 3000);

          // When the ack comes back the connection is proven alive.
          s.once("clockSyncAck", () => {
            if (livenessTimer) { clearTimeout(livenessTimer); livenessTimer = null; }
            // Re-sync immediately now that we know the socket is healthy.
            if (!isPrivilegedRef.current) {
              setTimeout(() => socketRef.current?.emit("requestSync"), 100);
            } else {
              setTimeout(() => {
                const v = videoRef.current;
                if (!v || v.readyState === 0) return;
                const action = v.paused ? "pause" : "play";
                socketRef.current?.emit("videoControl", { action, currentTime: v.currentTime });
              }, 100);
            }
          });

          s.emit("clockSync", { t0: Date.now() });
        }
      }

      // 4. Mic recovery — restart if Android/iOS killed the media stream.
      recoverDeadMicIfNeeded();
    };

    // [FIX-MIC-RECOVERY-SCOPE] Extracted from handleForeground so the SAME
    // dead-track detection + rebuild also runs on the "online" event (network
    // dropped and came back while the tab stayed in the foreground). Without
    // this, handleOnline only re-attached the OLD micDestRef stream to the
    // freshly recreated WebRTCManager — but micDestRef's track is a synthetic
    // MediaStreamAudioDestinationNode output, which does NOT go "ended" when
    // its upstream source (the real microphone track) dies. So the old,
    // silently-dead audio kept getting reattached as if it were healthy,
    // and the only way to actually recover was to manually toggle the mic
    // off/on — which is exactly the symptom users were hitting after a
    // network blip with the tab still open and focused.
    // Returns true if a dead mic was detected and a rebuild was kicked off.
    const recoverDeadMicIfNeeded = (): boolean => {
      if (!micEnabledRef.current) return false;
      const stream = micStreamRef.current;
      // [FIX-MIC-TRACK-ENDED] الكود القديم كان يفحص stream.active بس —
      // لكن لما النت يقطع ويرجع، الـ stream تفضل active لكن الـ track
      // نفسه بيبقى readyState === "ended" أو muted، فالصوت يقطع بدون
      // ما الـ recovery تشتغل. الحل: نفحص التراكات نفسها كمان.
      // [FIX-MUTED-FALSEPOSITIVE] Only treat readyState === "ended" as "dead".
      // t.muted is a TEMPORARY state set by the OS during phone calls, Bluetooth
      // headset switches, and audio-route changes — the OS clears it automatically
      // seconds later. Treating muted as dead triggers a full 500ms mic teardown +
      // restart on every phone call / BT connect, causing an audible gap for all
      // peers. readyState === "ended" is permanent and IS the right signal to act on.
      const trackDead = stream?.getAudioTracks().some(
        t => t.readyState === "ended"
      ) ?? false;
      // [FIX-BG-MIC] On iOS/Android the mic track can be silently killed while in
      // background. By the time visibilitychange fires on return, readyState may
      // read "live" and muted may be false again — making the track LOOK healthy
      // even though audio capture has stopped. If we know the mic was on before
      // the app was backgrounded, force a full rebuild to be safe.
      const backgroundedWithMicOn = micWasOnBeforeHiddenRef.current;
      micWasOnBeforeHiddenRef.current = false; // consume the flag
      if (!stream || !stream.active || trackDead || backgroundedWithMicOn) {
        if (micIntervalRef.current) { clearInterval(micIntervalRef.current); micIntervalRef.current = null; }
        stream?.getTracks().forEach(t => t.stop());
        micStreamRef.current = null;
        workletNodeRef.current?.port.close();
        workletNodeRef.current?.disconnect();
        workletNodeRef.current = null;
        // [FIX-WEBRTC-PROCESSED-AUDIO] Drop the WebRTC-bound track explicitly too —
        // the destination node belongs to the AudioContext we're about to close.
        webrtcManagerRef.current?.setStream(null);
        micDestRef.current?.stream.getTracks().forEach(t => t.stop());
        try { micDestRef.current?.disconnect(); } catch { /* ignore */ }
        micDestRef.current = null;
        try { micGainRef.current?.disconnect(); } catch { /* ignore */ }
        micGainRef.current = null;
        try { micCompressorRef.current?.disconnect(); } catch { /* ignore */ }
        micCompressorRef.current = null;
        try { micSourceRef.current?.disconnect(); } catch { /* ignore */ }
        micSourceRef.current = null;
        // [FIX-SHARED-CTX] Do NOT close audioContextRef here — after FIX-CTX-REUSE,
        // audioContextRef.current === audioPlayerRef.current (the same shared context
        // used for BOTH mic capture AND incoming audio playback). Closing it would
        // silence all received audio until the room is reloaded. Just null the ref
        // so the next toggleMic() picks up the still-running shared context.
        audioContextRef.current = null;
        analyserRef.current = null;
        micEnabledRef.current = false;
        setMicEnabled(false);
        // [FIX-DOUBLE-DISPATCH] Previously two dispatches fired simultaneously:
        // one unconditional and one inside a setMicEnabled() updater — both called
        // toggleMic before React re-rendered, starting two concurrent mic sessions
        // (duplicate audio, resource leaks, state corruption). Fix: single dispatch,
        // guarded by micEnabledRef (the synchronous source-of-truth), not React state.
        setTimeout(() => {
          if (socketRef.current && !micEnabledRef.current) {
            document.dispatchEvent(new CustomEvent("wp:restartMic"));
          }
        }, 500);
        return true;
      }
      return false;
    };

    // visibilitychange: fires on tab switch + screen lock/unlock (most browsers).
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        // Save whether the video was actively playing before we go hidden.
        // The browser fires an onPause event when it suspends the video element,
        // which sets isPlayingRef.current = false. Without saving this state here,
        // handleForeground has no way to know the video should resume on return.
        wasPlayingBeforeHiddenRef.current = !!(videoRef.current && !videoRef.current.paused);
        // [FIX-BG-MIC] Remember whether the mic was live before backgrounding.
        // iOS/Android kill the mic track silently in background. By the time
        // visibilitychange fires on return, readyState and muted may look fine
        // even though audio capture has stopped. We need this flag to force a
        // recovery in recoverDeadMicIfNeeded() regardless of apparent track health.
        micWasOnBeforeHiddenRef.current = micEnabledRef.current;
      } else {
        handleForeground();
      }
    };

    // pageshow: fires when Android restores a page from the back/forward cache
    // (bfcache). visibilitychange often does NOT fire in this scenario, so this
    // covers the "user pressed back button on Android then re-entered the tab" case.
    const handlePageShow = (e: PageTransitionEvent) => {
      if (e.persisted) handleForeground();
    };

    // online: fires when the device regains network connectivity after being
    // offline (airplane mode, lost WiFi, etc.). Force a clean reconnect so the
    // socket doesn't linger in a broken state waiting for the next ping cycle.
    const handleOnline = () => {
      const s = socketRef.current;
      if (!s) return;
      if (!s.connected) {
        s.connect();
      } else {
        // Connection may be stale after a network break — force a fresh one.
        s.disconnect();
        setTimeout(() => s.connect(), 200);
      }

      // [FIX-MIC-RECOVERY-ON-RECONNECT] Check the mic BEFORE deciding whether
      // to reattach it to the recreated WebRTCManager below. If the real
      // microphone track died during the network drop, recoverDeadMicIfNeeded
      // tears the whole mic graph down and triggers a full rebuild via
      // "wp:restartMic" — which will call WebRTCManager.setStream() itself
      // once the new mic stream is ready. In that case we must NOT also
      // reattach the old (now torn-down) micDestRef stream further below.
      const micWasDead = recoverDeadMicIfNeeded();

      // FIX-WEBRTC-ICE-RESTART: network change invalidates existing ICE candidates.
      // Destroy and re-create the WebRTCManager so it gathers new candidates on
      // the restored network interface (WiFi → mobile data, VPN change, etc.).
      // We do this in a 500ms timeout to let the socket reconnect first so the
      // new webrtcSignal events have a live channel to travel through.
      const manager = webrtcManagerRef.current;
      if (manager) {
        setTimeout(() => {
          manager.destroy();
          const newManager = new WebRTCManager(
            (targetMemberId, signal) => {
              socketRef.current?.emit("webrtcSignal", { targetMemberId, signal });
            },
            (_memberId, stream) => {
              if (stream) setRemoteScreenStream(stream);
              else { setRemoteScreenStream(null); setMode("video"); }
            },
            (quality) => {
              setNetworkQuality(quality);
            },
          );
          webrtcManagerRef.current = newManager;

          // [FIX-RECONNECT-AUDIO] The old manager (and all its peer connections)
          // was just destroyed and replaced. Without these two steps, WebRTC audio
          // silently breaks again after every network change (Wi-Fi ↔ mobile data,
          // VPN toggle, airplane mode):
          //
          // 1. Re-attach the live PROCESSED mic stream to the NEW manager. setStream()
          //    was only ever called once, in toggleMic(); the new manager starts with
          //    localStream = null, so any peer it creates would carry no audio —
          //    the exact same bug as the original missing setStream() call, just
          //    triggered by manager recreation instead of by toggleMic never being wired up.
          //    [FIX-WEBRTC-PROCESSED-AUDIO] Use micDestRef (post compressor/gain), not
          //    the raw micStreamRef, so re-negotiated peers keep the same processed
          //    audio quality instead of silently dropping back to an unprocessed track.
          //    [FIX-MIC-RECOVERY-ON-RECONNECT] Skip this entirely if the mic was just
          //    detected as dead above — micDestRef.current is null at this point anyway
          //    (recoverDeadMicIfNeeded already tore it down), and the pending
          //    "wp:restartMic" rebuild will call setStream() on this same manager once
          //    a fresh mic stream exists.
          if (!micWasDead && micEnabledRef.current && micDestRef.current) {
            // [FIX-P2] void — this runs inside a socket event handler (sync context).
            // The Promise resolves asynchronously; we don't need to wait for it here.
            void newManager.setStream(micDestRef.current.stream);
          }

          // 2. Re-initiate offers to existing online peers. webrtcInitiatedRef is
          //    set to true once on the FIRST membersUpdate and never reset, so
          //    without this, peers are never re-offered after recreation — for any
          //    peer pair where this side isn't the "lower ID" initiator, the WebRTC
          //    connection would never be rebuilt at all post-reconnect (it would
          //    silently fall back to Socket.IO audio only, and screen share/video
          //    would stay broken indefinitely).
          const myId = session?.memberId ?? 0;
          const peers = membersRef.current.filter(m => m.id !== myId && m.isOnline && myId < m.id);
          peers.forEach((m, i) => {
            setTimeout(() => {
              webrtcManagerRef.current?.initiateOffer(m.id);
            }, i * 300);
          });
        }, 500);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("online", handleOnline);

    socket.on("membersUpdate", (updated: Member[]) => {
      // Detect members who just came online (joined / reconnected)
      if (prevOnlineMembersRef.current.size > 0) {
        const newlyJoined = updated.filter(
          m => m.isOnline && m.id !== myMemberId && !prevOnlineMembersRef.current.has(m.id)
        );
        if (newlyJoined.length > 0 && notifSoundEnabledRef.current && (!panelOpenRef.current || activeTabRef.current !== "members")) {
          if (chatToastTimerRef.current) clearTimeout(chatToastTimerRef.current);
          const label = newlyJoined.length === 1
            ? newlyJoined[0].name
            : `${newlyJoined.length} أعضاء`;
          setChatToast({ name: label, text: "انضم للغرفة 👋", tab: "members" });
          chatToastTimerRef.current = setTimeout(() => setChatToast(null), 4000);
        }
      }
      prevOnlineMembersRef.current = new Set(updated.filter(m => m.isOnline).map(m => m.id));
      setMembers(updated);
      // [FIX-IOS-PREEXIST] On iOS/Android, <audio> elements need an explicit .play()
      // after a user gesture. peerMicEnabled only fires when a peer TOGGLES their
      // mic — if someone was already speaking when we joined, we miss that event
      // and their WebRTC audio never starts. Pre-unlock ALL online peers on every
      // membersUpdate — preUnlockAudio just calls audio.play().catch() which is
      // safe and a no-op when no track is attached yet.
      updated.forEach(m => {
        if (m.id !== myMemberId && m.isOnline) {
          webrtcManagerRef.current?.preUnlockAudio(m.id);
        }
      });
      // On first membersUpdate, all users establish WebRTC connections so anyone can share.
      // Lower-ID-initiates rule avoids simultaneous offer collisions between peers.
      // Deferred via setTimeout to avoid blocking the main thread on Android during ICE gathering.
      if (!webrtcInitiatedRef.current && webrtcManagerRef.current) {
        // Only mark as initiated when the manager is actually ready.
        // (The manager is created in a separate useEffect; don't set the flag
        // if it hasn't initialised yet, so we retry on the next membersUpdate.)
        webrtcInitiatedRef.current = true;
        const myId = session?.memberId ?? 0;
        const peers = updated.filter(m => m.id !== myId && m.isOnline && myId < m.id);
        peers.forEach((m, i) => {
          setTimeout(() => {
            webrtcManagerRef.current?.initiateOffer(m.id);
          }, i * 300);
        });
      }
    });

    // Delta update: server sends this instead of full membersUpdate on every join (O(n) fix).
    socket.on("memberJoined", (newMember: Member) => {
      if (newMember.id === myMemberId) return;
      setMembers(prev => {
        const without = prev.filter(m => m.id !== newMember.id);
        return [...without, newMember];
      });
      if (prevOnlineMembersRef.current.size > 0 && !prevOnlineMembersRef.current.has(newMember.id)) {
        if (notifSoundEnabledRef.current && (!panelOpenRef.current || activeTabRef.current !== "members")) {
          if (chatToastTimerRef.current) clearTimeout(chatToastTimerRef.current);
          setChatToast({ name: newMember.name, text: "انضم للغرفة 👋", tab: "members" });
          chatToastTimerRef.current = setTimeout(() => setChatToast(null), 4000);
        }
        prevOnlineMembersRef.current = new Set([...prevOnlineMembersRef.current, newMember.id]);
      }
    });

    // When a new member joins, the lower-ID side initiates the WebRTC connection.
    socket.on("peerJoined", ({ memberId }: { memberId: number }) => {
      const myId = session?.memberId ?? 0;
      if (myId < memberId) {
        webrtcManagerRef.current?.initiateOffer(memberId);
      }
    });

    // ── Unified sync event ────────────────────────────────────────────────────
    // Replaces: videoControl / videoSync / serverHeartbeat / videoHeartbeat
    // Server sends this on every host action (play/pause/seek) and on requestSync.
    // position = video seconds at positionAt (server ms timestamp).
    // Client computes expected position = position + (serverNow - positionAt)/1000
    socket.on("syncState", ({
      isPlaying: ip,
      position,
      positionAt,
      seqNo,
      playAt,
      isDriftCorrection,
    }: {
      isPlaying: boolean;
      position: number;
      positionAt: number;
      seqNo: number;
      playAt?: number;
      isDriftCorrection?: boolean;
    }) => {
      if (seqNo < lastSyncSeqRef.current) return; // stale — a newer state already applied
      lastSyncSeqRef.current = seqNo;

      // Cancel any previously scheduled play — this newer syncState supersedes it
      if (scheduledPlayTimeoutRef.current) {
        clearTimeout(scheduledPlayTimeoutRef.current);
        scheduledPlayTimeoutRef.current = null;
      }
      // Cancel any pending bufferCheck pre-seek — syncState owns the seek from here
      if (bufferCheckTimerRef.current) {
        clearTimeout(bufferCheckTimerRef.current);
        bufferCheckTimerRef.current = null;
      }

      const serverNow = Date.now() + serverClockOffsetRef.current;
      const transit = Math.min(5, Math.max(0, (serverNow - positionAt) / 1000));
      const targetTime = ip ? position + transit : position;

      pendingVideoSyncRef.current = { targetTime, shouldPlay: ip, storedAt: Date.now() };

      if (tapToPlayRef.current && !ip) {
        tapToPlayRef.current = false;
        setTapToPlay(false);
      }

      // Privileged users: skip the entire sync (including playAt scheduling) if they
      // just issued a local action. Without this, the server's echo enters the playAt
      // branch and schedules a syncToTarget 1.9s later — which seeks/freezes the host's
      // own video even though they already applied the action locally.
      if (isPrivileged && Date.now() < suppressSyncUntilRef.current) return;

      // Buffer-aware scheduled play: server includes a future `playAt` on play events
      // so all clients can pre-seek and buffer before actually starting.
      if (ip && playAt && playAt > serverNow + 50) {
        const msUntilPlay = playAt - serverNow;
        // Stagger pre-seeks: random 0–800 ms jitter spreads 500 clients' HLS segment
        // requests over time instead of hitting the server all at once (thundering herd).
        // msUntilPlay is ~3 s so all seeks finish well before playAt fires.
        const preFetchJitter = Math.random() * Math.min(800, Math.max(0, msUntilPlay - 600));
        const v = videoRef.current;
        if (!(v as HTMLVideoElement & { webkitDisplayingFullscreen?: boolean }).webkitDisplayingFullscreen && v && v.readyState >= 2 && Math.abs(v.currentTime - position) > 0.5) {
          setTimeout(() => {
            const vv = videoRef.current;
            if (!vv || vv.readyState < 2) return;
            if (Math.abs(vv.currentTime - position) > 0.5) {
              isRemoteControlRef.current = true;
              vv.currentTime = position;
              setTimeout(() => { isRemoteControlRef.current = false; }, 300);
            }
          }, preFetchJitter);
        }
        scheduledPlayTimeoutRef.current = setTimeout(() => {
          scheduledPlayTimeoutRef.current = null;
          // Correct target when the play fires:
          //   position  = video seconds at positionAt (server timestamp)
          //   transit   = seconds elapsed between positionAt and syncState receipt
          //   msUntilPlay/1000 = seconds elapsed while waiting for this timeout
          // Total elapsed from positionAt = transit + msUntilPlay/1000
          // Previous code: (Date.now() - (Date.now() - msUntilPlay)) / 1000 = msUntilPlay/1000
          // which doubled the offset → seeked 1-3s ahead of the correct position.
          const liveTarget = position + transit + msUntilPlay / 1000;
          const currentDrift2 = Math.abs((videoRef.current?.currentTime ?? -9999) - liveTarget);
          const forceSync2 = isIOSDevice ? currentDrift2 > 1.5 : true;
          syncToTarget(liveTarget, true, forceSync2);
        }, msUntilPlay);
        return;
      }

      // Native iOS fullscreen: update pendingVideoSyncRef so the force-play/force-pause
      // handlers always see the latest server state, then proceed to syncToTarget.
      // syncToTarget will enforce play/pause but skip position seeks so the native
      // seek bar is not disturbed.
      const vNow = videoRef.current;
      if ((vNow as HTMLVideoElement & { webkitDisplayingFullscreen?: boolean })?.webkitDisplayingFullscreen) {
        pendingVideoSyncRef.current = { targetTime, shouldPlay: ip, storedAt: Date.now() };
      }

      const currentDrift = Math.abs((videoRef.current?.currentTime ?? -9999) - targetTime);
      // isDriftCorrection (periodic 5s sync): apply gently — only seek if drift > 0.8s.
      // Regular syncState (play/pause/seek): always hard-seek to stay in sync.
      // iOS: avoid hard seeks for small drifts regardless — every seek fetches HLS segments.
      // FIX-SYNC-2: drift threshold 0.8s → 0.3s
      // Old: periodic 5s sync only corrected if guest was >0.8s off → guests silently
      // drifted up to 0.8s from host with NO correction ever firing (0.8s is very noticeable).
      const forceSync = isDriftCorrection
        ? currentDrift > 0.3
        : (isIOSDevice ? currentDrift > 1.5 : true);
      syncToTarget(targetTime, ip, forceSync);
    });

    // ── Buffer Check ─────────────────────────────────────────────────────────
    // Server emits this ~1 s before a play command so clients can pre-seek
    // to the target position and begin buffering early. Responding with
    // bufferReady lets the server know this client is preparing.
    socket.on("bufferCheck", ({ position }: { position: number }) => {
      // iOS native HLS (both fullscreen and normal) owns the buffer pipeline.
      // Pre-seeking here interrupts iOS's internal segment fetcher and causes
      // a stall. Skip the seek entirely on iOS — just acknowledge and let
      // the native player handle buffering on its own schedule.
      if (isIOSDevice) { socket.emit("bufferReady"); return; }
      // Non-iOS: don't fight the native iOS fullscreen player either (safety guard).
      if ((videoRef.current as HTMLVideoElement & { webkitDisplayingFullscreen?: boolean })?.webkitDisplayingFullscreen) { socket.emit("bufferReady"); return; }
      // Cancel any previous pending pre-seek — only the latest bufferCheck matters.
      // Rapid forward+backward scrubbing previously stacked multiple jitter timers,
      // each doing a video.currentTime= assign → HLS buffer corrupted → freeze.
      if (bufferCheckTimerRef.current) {
        clearTimeout(bufferCheckTimerRef.current);
        bufferCheckTimerRef.current = null;
      }
      // Thundering-herd jitter: stagger pre-seeks across 0–200 ms.
      // Reduced from 600 ms: server-side debounce already guarantees only ONE
      // bufferCheck fires per seek sequence, so shorter jitter is safe and ensures
      // pre-seeks finish well before syncState's 400 ms playAt window.
      const jitterMs = Math.random() * 200;
      bufferCheckTimerRef.current = setTimeout(() => {
        bufferCheckTimerRef.current = null;
        const v = videoRef.current;
        if (v && v.readyState >= 2) {
          const drift = Math.abs(v.currentTime - position);
          if (drift > 0.5) {
            isRemoteControlRef.current = true;
            v.currentTime = position;
            setTimeout(() => { isRemoteControlRef.current = false; }, 500);
          }
        }
      }, jitterMs);
      socket.emit("bufferReady");
    });

    socket.on("videoReady", ({ hlsPath }: { hlsPath: string }) => {
      // Reset sync state so stale sequence numbers from the old video
      // don't suppress sync events for the new one.
      lastSyncSeqRef.current = -1;
      pendingVideoSyncRef.current = null;
      canPlaySyncedRef.current = false;
      isSyncActiveRef.current = false;
      setIsPlaying(false);
      setCurrentTime(0);
      setDuration(0);
      setVideoHlsPath(hlsPath);
      setUploadProgress(null);
      refetchVideoStatus();
      // Only the client that initiated the upload emits uploadEnded.
      // videoReady is broadcast to ALL clients — if every client emits uploadEnded,
      // the server calls roomTimelines.delete + stopPeriodicSync once per connected
      // client, wiping out the room timeline and killing sync for everyone.
      if (isUploadingRef.current) {
        isUploadingRef.current = false;
        socket.emit("uploadEnded");
      }
    });
    socket.on("uploadProgress", ({ progress }: { progress: number }) => setUploadProgress(progress));
    // videoError: ffmpeg processing failed. Emit uploadEnded so the server clears
    // roomUploading and guests receive uploadUnlocked. Without this the room stays
    // permanently locked whenever a video fails to transcode.
    socket.on("videoError", ({ message }: { message: string }) => {
      setUploadProgress(null);
      setUploadSpeed(null);
      setUploadRemaining(null);
      // Same guard as videoReady — only the uploader unlocks the room.
      if (isUploadingRef.current) {
        isUploadingRef.current = false;
        socket.emit("uploadEnded");
      }
      alert(`Video processing failed: ${message}`);
    });
    // Upload lock — prevents multiple simultaneous uploads across all clients
    socket.on("uploadLocked", () => {
      setUploadProgress(prev => prev !== null ? prev : 0);
    });
    socket.on("uploadUnlocked", () => {
      setUploadProgress(null);
    });
    socket.on("uploadAlreadyInProgress", () => {
      alert("Another upload is already in progress. Please wait.");
    });
    socket.on("speakingUpdate", (updates: { memberId: number; volume: number }[]) => {
      setSpeakingState(prev => {
        const next = { ...prev };
        for (const u of updates) next[u.memberId] = u.volume;
        return next;
      });
    });
    socket.on("contentCleared", () => {
      setVideoHlsPath(null); setUploadProgress(null); setHyperbeamEmbed(null); setHyperbeamAdminToken(null);
      const v = videoRef.current;
      if (v) { v.pause(); v.src = ""; }
      if (hlsRef.current) { (hlsRef.current as { destroy: () => void }).destroy(); hlsRef.current = null; }
    });
    socket.on("kicked", () => { setKicked(true); setTimeout(() => setLocation("/"), 3000); });
    socket.on("banned", () => { setBanned(true); setTimeout(() => setLocation("/"), 3000); });
    let roomClosedHandled = false;
    socket.on("roomClosed", () => {
      // Guard against duplicate fires (e.g. receiving roomClosed from both the
      // debounced membersUpdate broadcast and a direct socket emit on edge cases).
      if (roomClosedHandled) return;
      roomClosedHandled = true;
      clearSession(code);
      try { sessionStorage.removeItem(`welcome_shown_${code}`); } catch { /* ignore */ }
      disconnectSocket();
      setLocation("/");
    });
    let sessionErrorRetries = 0;
    socket.on("error", ({ message }: { message: string }) => {
      if (message === "Room not found" || message === "Invalid session") {
        // Under server load, DB queries can fail transiently — retry up to 2 times
        // before giving up and navigating away. Prevents false "room not found" kicks.
        if (sessionErrorRetries < 2) {
          sessionErrorRetries++;
          setTimeout(() => {
            if (socketRef.current?.connected) {
              socket.emit("joinRoom", { roomCode: code, sessionToken });
            }
          }, 1500 * sessionErrorRetries);
          return;
        }
        clearSession(code);
        try { sessionStorage.removeItem(`welcome_shown_${code}`); } catch { /* ignore */ }
        disconnectSocket();
        setLocation("/");
      }
    });
    socket.on("pendingApproval", () => setPendingApproval(true));
    socket.on("joinApproved", () => {
      setPendingApproval(false);
      setTapToPlay(false);
      refetchVideoStatus();
      // Floating toast + OS notification — بس لو الجرس مش مكتوم
      if (notifSoundEnabledRef.current) {
        if (chatToastTimerRef.current) clearTimeout(chatToastTimerRef.current);
        setChatToast({ name: "تم قبول طلبك ✅", text: "أهلاً بيك في الروم!", tab: "joinApproved" });
        chatToastTimerRef.current = setTimeout(() => setChatToast(null), 5000);
        if (document.hidden) showBrowserNotif("✅ تم القبول", "تم قبول طلب دخولك للروم، تفضل!");
      }
      // Show welcome toast after approval — only once per session
      if (!welcomeShownRef.current) {
        welcomeShownRef.current = true;
        sessionStorage.setItem(`welcome_shown_${code}`, "1");
        setShowWelcome(true);
        setWelcomeLeaving(false);
        playWelcomeSound();
        setTimeout(() => setWelcomeLeaving(true), 2800);
        setTimeout(() => setShowWelcome(false), 3400);
      }
      // Poll requestSync several times after approval to ensure sync is received
      // even if first response is missed or video hasn't loaded yet
      [800, 2000, 4000, 7000, 11000].forEach(delay => {
        setTimeout(() => {
          if (socketRef.current?.connected) socket.emit("requestSync");
        }, delay);
      });
    });
    socket.on("joinRejected", () => {
      setPendingApproval(false);
      // Floating toast + OS notification — بس لو الجرس مش مكتوم
      if (notifSoundEnabledRef.current) {
        if (chatToastTimerRef.current) clearTimeout(chatToastTimerRef.current);
        setChatToast({ name: "تم رفض طلبك ❌", text: "للأسف لم يتم قبولك في الروم", tab: "joinRejected" });
        chatToastTimerRef.current = setTimeout(() => setChatToast(null), 5000);
        if (document.hidden) showBrowserNotif("❌ تم الرفض", "للأسف تم رفض طلب دخولك للروم");
      }
      setJoinRejected(true);
    });
    socket.on("joinRequest", (req: JoinRequest) => {
      setJoinRequests(prev => [...prev.filter(r => r.memberId !== req.memberId), req]);
      playNotifSound("request");
      // Floating toast + OS notification — بس لو الجرس مش مكتوم
      if (notifSoundEnabledRef.current) {
        if (chatToastTimerRef.current) clearTimeout(chatToastTimerRef.current);
        setChatToast({ name: req.name, text: "يطلب الدخول للروم 🔔", tab: "joinRequest", memberId: req.memberId });
        chatToastTimerRef.current = setTimeout(() => setChatToast(null), 6000);
        if (document.hidden) showBrowserNotif("🔔 طلب دخول", `${req.name} يطلب الدخول للروم`);
      }
    });
    socket.on("joinRequestHandled", ({ memberId }: { memberId: number }) => {
      setJoinRequests(prev => prev.filter(r => r.memberId !== memberId));
    });
    socket.on("roleUpdated", ({ role }: { role: string }) => {
      setMyRole(role);
      const s = getSession(code);
      if (s) saveSession(code, s.sessionToken, role, s.name, s.memberId);
    });
    socket.on("peerMicEnabled", ({ memberId }: { memberId: number }) => {
      // Resume audio player on any user interaction (required for iOS autoplay policy)
      if (audioPlayerRef.current?.state === "suspended") audioPlayerRef.current.resume().catch(() => {});
      // [FIX-MIC-REOPEN] When a peer re-enables their mic, resume ALL WebRTC
      // audio elements. On iOS/Android, <audio> elements can enter a paused state
      // after being muted (track=null) and don't auto-resume when a track returns —
      // the volume indicator shows signal but no sound is heard.
      webrtcManagerRef.current?.resumeAllAudio();
      // Force reset next-play-time for this member so first chunk plays immediately
      nextAudioTimeRef.current.delete(memberId);
      // [FIX-1-JITTER-QUEUE] Reset the jitter heap so stale chunks from the
      // previous mic session are not replayed when the member re-enables.
      jitterQueuesRef.current.get(memberId)?.clear();
    });
    socket.on("peerMicDisabled", ({ memberId }: { memberId: number }) => {
      nextAudioTimeRef.current.delete(memberId);
      lastAudioSeqRef.current.delete(memberId);
      jitterCushionRef.current.delete(memberId);
      // [FIX-1-JITTER-QUEUE] Stop the drain loop and clear the heap for this speaker.
      const drainTimer = jitterDrainTimersRef.current.get(memberId);
      if (drainTimer) { clearInterval(drainTimer); jitterDrainTimersRef.current.delete(memberId); }
      jitterQueuesRef.current.get(memberId)?.clear();
      jitterQueuesRef.current.delete(memberId);
      // [FIX-3] Disconnect and discard persistent compressor when mic is disabled.
      // Next time the speaker enables mic a fresh compressor is created.
      speakerCompressorsRef.current.get(memberId)?.disconnect();
      speakerCompressorsRef.current.delete(memberId);
      setSpeakingState(prev => ({ ...prev, [memberId]: 0 }));
    });
    socket.on("audioChunk", ({ fromMemberId, sr, buf, seq, audioTime }: { fromMemberId: number; sr: number; buf: ArrayBuffer; seq?: number; audioTime?: number }) => {
      const ctx = audioPlayerRef.current;
      if (!ctx) return;
      if (fromMemberId === myMemberId) return;
      // [FIX-MULTIROOM] If we have a live WebRTC P2P connection with this sender,
      // their audio is already arriving via the WebRTC audio element — ignore the
      // Socket.IO copy to prevent double-audio. Peers without WebRTC will NOT match
      // this check and will correctly receive via the jitter buffer below.
      if (webrtcManagerRef.current?.hasConnectedPeer(fromMemberId)) return;
      if (ctx.state === "suspended") ctx.resume().catch(() => {});

      // [FIX-SEQ] Discard out-of-order packets. seq is optional for older server
      // versions — when present we only drop TRUE duplicates / extreme reorders
      // (seq <= lastSeq - 3). Mild reordering (e.g. seq = lastSeq + 1 arriving
      // after seq = lastSeq + 2) is handled correctly by the MinHeap below.
      const resolvedSeq = seq ?? Date.now(); // fallback: wall-clock as tiebreaker
      if (seq !== undefined) {
        const lastSeq = lastAudioSeqRef.current.get(fromMemberId) ?? -1;
        if (seq <= lastSeq - 3) return; // extreme reorder / duplicate — drop silently
      }

      try {
        const int16 = new Int16Array(buf);
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32767;
        const audioBuf = ctx.createBuffer(1, float32.length, sr);
        audioBuf.getChannelData(0).set(float32);

        // ── [FIX-1-JITTER-QUEUE] Push into MinHeap; drain loop schedules playback ──
        // Previously chunks were scheduled immediately on arrival. When a TCP burst
        // delivered 3-4 chunks at once they were all scheduled at ~(now+cushion),
        // overlapping each other → audible glitches. The MinHeap ensures seq-ordered
        // drain regardless of arrival order.
        let heap = jitterQueuesRef.current.get(fromMemberId);
        if (!heap) {
          heap = new SeqMinHeap();
          jitterQueuesRef.current.set(fromMemberId, heap);
        }
        heap.push({ seq: resolvedSeq, audioBuf, audioTime });

        // Ensure a drain loop is running for this speaker.
        if (!jitterDrainTimersRef.current.has(fromMemberId)) {
          // ── Per-speaker persistent compressor ─────────────────────────────
          // [FIX-CLICK] Create ONCE per speaker; keeps gain-reduction history
          // across chunks → no abrupt jumps → no inter-chunk clicks.
          let compressor = speakerCompressorsRef.current.get(fromMemberId);
          if (!compressor) {
            compressor = ctx.createDynamicsCompressor();
            compressor.threshold.value = -24;
            compressor.knee.value = 10;
            compressor.ratio.value = 3;
            compressor.attack.value = 0.003;
            compressor.release.value = 0.25;
            compressor.connect(ctx.destination);
            speakerCompressorsRef.current.set(fromMemberId, compressor);
          }

          // Drain loop: runs every 20 ms, schedules the next chunk from the heap
          // when it is within a 300ms lookahead window of the audio clock.
          // 20ms is small enough to schedule before the chunk's deadline and
          // large enough to avoid waking the event loop too aggressively.
          const LOOKAHEAD_S = 0.3; // schedule chunks up to 300ms ahead
          const FADE_S = 0.003;    // 3ms fade-in only — no fade-out (see below)

          // [FIX-DRAIN-GAP] Grace counter: keep the drain loop alive for up to
          // 150ms of empty heap (7 × 20ms ticks) before stopping. Without this,
          // any momentary pause in speech (even 1 TCP packet gap) stops the loop
          // and the next chunk restarts it with a forced now+cushion delay, creating
          // an audible ~60ms gap at the start of every resumed utterance.
          let emptyTicks = 0;
          const MAX_EMPTY_TICKS = 7; // 7 × 20ms = 140ms grace

          const drainTimer = setInterval(() => {
            const heap = jitterQueuesRef.current.get(fromMemberId);
            const comp = speakerCompressorsRef.current.get(fromMemberId);
            const audioCtx = audioPlayerRef.current;
            if (!heap || !comp || !audioCtx) return;
            if (audioCtx.state === "suspended") return;

            const now = audioCtx.currentTime;
            const jitterMap = jitterCushionRef.current;
            const prevCushion = jitterMap.get(fromMemberId) ?? 0.06;

            // Drain all chunks that should be scheduled within the lookahead window.
            while (heap.size > 0) {
              const chunk = heap.peek()!;
              const CHUNK_DUR = chunk.audioBuf.duration;

              // [FIX-2-AUDIOTIME] Compute adaptive cushion using the worklet's
              // audioTime to avoid main-thread Date.now() drift under CPU load.
              const prev = nextAudioTimeRef.current.get(fromMemberId) ?? 0;
              const arrivalGap = prev > 0 ? Math.max(0, prev - now) : 0;
              const newCushion = arrivalGap > CHUNK_DUR * 1.5
                ? Math.min(prevCushion + 0.02, 0.3)   // bursty → grow up to 300ms
                : Math.max(prevCushion - 0.005, 0.04); // smooth → decay to 40ms
              jitterMap.set(fromMemberId, newCushion);

              // Compute ideal start time for the next chunk.
              const maxDrift = CHUNK_DUR + newCushion;
              const startAt = (prev > now + maxDrift)
                ? now + newCushion
                : Math.max(now + newCushion, prev);

              // Only schedule chunks that fall within the lookahead window.
              if (startAt > now + LOOKAHEAD_S) break;

              // Consume from heap and update seq tracking.
              heap.pop();
              if (seq !== undefined) {
                const lastSeq = lastAudioSeqRef.current.get(fromMemberId) ?? -1;
                if (chunk.seq > lastSeq) lastAudioSeqRef.current.set(fromMemberId, chunk.seq);
              }

              const endAt = startAt + chunk.audioBuf.duration;

              // Schedule playback through the persistent compressor.
              const src = audioCtx.createBufferSource();
              src.buffer = chunk.audioBuf;
              const fadeGain = audioCtx.createGain();
              src.connect(fadeGain);
              fadeGain.connect(comp);
              // [FIX-LEAK] Disconnect fadeGain after playback ends — prevents
              // zombie GainNodes accumulating on the compressor over long calls.
              src.addEventListener("ended", () => {
                try { fadeGain.disconnect(); } catch { /* ignore */ }
              }, { once: true });

              // [FIX-FADE-DIP] Fade-in ONLY — no fade-out.
              // The old approach faded gain to 0 at endAt and the next chunk faded
              // in from 0 at the same instant → amplitude dip to 0 at every 85ms
              // boundary, audible as a 12Hz tremolo / robotic flutter in continuous
              // speech. Fix: ramp in from 0 on start, then hold at 1.0 for the full
              // buffer duration. The AudioBufferSourceNode stops automatically when
              // the buffer finishes (= endAt), so no explicit src.stop() is needed.
              // With no fade-out, consecutive chunk boundaries are seamless.
              fadeGain.gain.setValueAtTime(0, startAt);
              fadeGain.gain.linearRampToValueAtTime(1.0, startAt + FADE_S);

              src.start(startAt);
              // No src.stop() — buffer plays to natural end (= endAt implicitly).
              nextAudioTimeRef.current.set(fromMemberId, endAt);
            }

            // [FIX-DRAIN-GAP] Grace-period stop: only stop after MAX_EMPTY_TICKS
            // consecutive empty-heap ticks. A single empty tick (heap momentarily
            // drained between two network packets) no longer kills the loop,
            // preventing the now+cushion restart-gap on the next chunk.
            if (heap.size === 0) {
              emptyTicks++;
              if (emptyTicks >= MAX_EMPTY_TICKS) {
                clearInterval(drainTimer);
                jitterDrainTimersRef.current.delete(fromMemberId);
              }
            } else {
              emptyTicks = 0;
            }
          }, 20);

          jitterDrainTimersRef.current.set(fromMemberId, drainTimer);
        }
      } catch { /* ignore decode errors */ }
    });
    socket.on("modeChange", ({ mode: m }: { mode: "video" | "browser" | "screenshare" | "movies" }) => {
      if (m === "movies") { setCineState(DEFAULT_CINE_STATE); setCineDirectUrl(""); setCineSubtitleUrl(""); }
      setMode(m);
    });
    socket.on("moviesFilter", ({ type, category }: { type: "movie" | "tv"; category: "popular" | "top_rated" }) => {
      setCineState(prev => ({ ...prev, contentType: type, category, searchQuery: "", selectedItem: null, season: 1, episode: 1, view: "browse" }));
    });
    socket.on("moviesSearch", ({ query }: { query: string }) => {
      setCineState(prev => ({ ...prev, searchQuery: query, selectedItem: null, view: "browse" }));
    });
    socket.on("moviesSelect", ({ item }: { item: CineState["selectedItem"] }) => {
      setCineState(prev => ({ ...prev, selectedItem: item, view: item ? "player" : "browse", season: 1, episode: 1 }));
      setCineDirectUrl("");
      setCineSubtitleUrl("");
    });
    socket.on("moviesSeason", ({ season }: { season: number }) => {
      setCineState(prev => ({ ...prev, season, episode: 1 }));
      setCineDirectUrl("");
      setCineSubtitleUrl("");
    });
    socket.on("moviesEpisode", ({ episode }: { episode: number }) => {
      setCineState(prev => ({ ...prev, episode }));
      setCineDirectUrl("");
      setCineSubtitleUrl("");
    });
    socket.on("moviesSync", (state: CineState & { directUrl?: string; subtitleUrl?: string }) => {
      setCineState(state);
      if (typeof state.directUrl === "string") setCineDirectUrl(state.directUrl);
      if (typeof state.subtitleUrl === "string") setCineSubtitleUrl(state.subtitleUrl);
    });
    socket.on("moviesDirectUrl", ({ directUrl, subtitleUrl }: { directUrl: string; subtitleUrl?: string }) => {
      setCineDirectUrl(directUrl);
      if (typeof subtitleUrl === "string") setCineSubtitleUrl(subtitleUrl);
    });
    socket.on("hyperbeamSession", ({ embedUrl }: { embedUrl: string }) => {
      setHyperbeamEmbed(embedUrl);
    });
    socket.on("hyperbeamEnded", () => {
      // FIX-FULLSCREEN: اخرج من fullscreen دايماً لما الـ session تنتهي —
      // سواء كان الـ host قفلها من الكمبيوتر والـ guest على الهاتف في fullscreen،
      // أو أي حالة تانية. مش هيضر لو مش في fullscreen.
      if (document.fullscreenElement) {
        // non-iOS: fullscreen حقيقي عبر Browser API
        document.exitFullscreen().catch(() => {});
      }
      // iOS + أي حالة: reset الـ state الوهمي دايماً
      setIsBrowserFullscreen(false);
      setBrowserWidened(false);
      setHyperbeamEmbed(null);
      setHyperbeamAdminToken(null);
    });
    socket.on("screenShareStarted", () => {
      setMode("screenshare");
      // If the WebRTC track already arrived before this socket event (race condition),
      // grab it immediately so the video element gets the stream right away.
      const existing = webrtcManagerRef.current?.getAnyRemoteVideoStream();
      if (existing) setRemoteScreenStream(existing);
    });
    socket.on("screenShareStopped", () => {
      setRemoteScreenStream(null);
    });
    socket.on("webrtcSignal", ({ fromMemberId, signal }: { fromMemberId: number; signal: WebRTCSignal }) => {
      webrtcManagerRef.current?.handleIncoming(fromMemberId, signal);
    });
    socket.on("webrtcInitiateOffer", ({ targetMemberId }: { targetMemberId: number }) => {
      webrtcManagerRef.current?.initiateOffer(targetMemberId);
    });
    socket.on("chatHistory", (history: ChatMessage[]) => {
      setChatMessages(history);
      // chatHistory is the last event the server sends after a SUCCESSFUL joinRoom.
      // Resetting the error-retry counter here (not on connect) ensures transient
      // "Invalid session" errors from one reconnect cycle don't accumulate and
      // cause a premature room exit on a later cycle, while still allowing
      // legitimate kicks (room deleted → joinRoom keeps failing → no chatHistory
      // → counter reaches max → exit) to work correctly.
      sessionErrorRetries = 0;
      // Show welcome only on first real entry (chatHistory is sent only after successful join, not during pendingApproval)
      if (!welcomeShownRef.current) {
        welcomeShownRef.current = true;
        sessionStorage.setItem(`welcome_shown_${code}`, "1");
        setShowWelcome(true);
        setWelcomeLeaving(false);
        playWelcomeSound();
        setTimeout(() => setWelcomeLeaving(true), 2800);
        setTimeout(() => setShowWelcome(false), 3400);
      }
    });
    socket.on("chatMessage", (entry: ChatMessage) => {
      setChatMessages(prev => [...prev, entry]);
      if (entry.memberId !== myMemberId) {
        // Only mark as unread if the user isn't already looking at the chat tab
        if (!panelOpenRef.current || activeTabRef.current !== "chat") {
          setUnreadCount(prev => prev + 1);
        }
        playNotifSound("message");
        // Show floating toast + OS notification when panel is closed or not on chat tab
        if (notifSoundEnabledRef.current && (!panelOpenRef.current || activeTabRef.current !== "chat")) {
          if (chatToastTimerRef.current) clearTimeout(chatToastTimerRef.current);
          const preview = entry.imageData ? "📷 صورة" : (entry.message ?? "").slice(0, 60);
          setChatToast({ name: entry.name, text: preview, tab: "chat" });
          chatToastTimerRef.current = setTimeout(() => setChatToast(null), 4500);
          // إشعار OS — بس لو الـ tab مخفي فعلاً (التطبيق في الخلفية أو الشاشة مقفولة)
          if (document.hidden) showBrowserNotif(`💬 ${entry.name}`, preview);
        }
      }
    });
    socket.on("messageReaction", ({ messageId, reactions }: { messageId: string; reactions: Record<string, number[]> }) => {
      setChatMessages(prev => prev.map(m => (m.id === messageId ? { ...m, reactions } : m)));
    });
    // Batch rapid memberRemoved events (e.g. 20 users closing at once) into a single
    // React state update instead of 20 separate setMembers calls. Without batching,
    // Android Chrome can freeze and reload the tab when it receives a flood of DOM updates.
    let pendingRemovals: number[] = [];
    let removalsTimer: ReturnType<typeof setTimeout> | null = null;
    socket.on("memberRemoved", ({ memberId }: { memberId: number }) => {
      pendingRemovals.push(memberId);
      if (removalsTimer) clearTimeout(removalsTimer);
      removalsTimer = setTimeout(() => {
        removalsTimer = null;
        const batch = pendingRemovals.splice(0);
        setMembers(prev => prev.filter(m => !batch.includes(m.id)));
        setSpeakingState(prev => {
          const n = { ...prev };
          for (const id of batch) delete n[id];
          return n;
        });
        // [FIX-COMPRESSOR-LEAK] A member who disconnects abruptly (browser crash,
        // network drop, tab killed) never sends "micDisabled" → peerMicDisabled
        // never fires → their DynamicsCompressorNode stays connected inside
        // speakerCompressorsRef indefinitely. Over a long session with many
        // join/leave cycles this accumulates zombie nodes that hold references
        // to the AudioContext internals and waste memory. Clean up all audio state
        // here, mirroring exactly what peerMicDisabled does, so the next time
        // this member joins and enables mic a fresh compressor is created.
        for (const id of batch) {
          nextAudioTimeRef.current.delete(id);
          lastAudioSeqRef.current.delete(id);
          jitterCushionRef.current.delete(id);
          // [FIX-1-JITTER-QUEUE] + [FIX-3] Clean up heap and drain timer for
          // members who left abruptly without sending "micDisabled".
          const dt = jitterDrainTimersRef.current.get(id);
          if (dt) { clearInterval(dt); jitterDrainTimersRef.current.delete(id); }
          jitterQueuesRef.current.get(id)?.clear();
          jitterQueuesRef.current.delete(id);
          speakerCompressorsRef.current.get(id)?.disconnect();
          speakerCompressorsRef.current.delete(id);
          webrtcManagerRef.current?.removePeer(id);
        }
      }, 100); // 100 ms debounce — batches mass-exit cascade into one update
    });
    socket.on("forceMuted", () => {
      stopMic();
    });
    // MOD #10: listen for access control changes from server
    socket.on("accessControlChanged", ({ enabled }: { enabled: boolean }) => {
      setAccessControlEnabled(enabled);
    });

    return () => {
      // Cancel any pending liveness probe so it can't fire after unmount.
      if (livenessTimer) { clearTimeout(livenessTimer); livenessTimer = null; }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("online", handleOnline);
      silentKeepAliveRef.current?.stop();
      silentKeepAliveRef.current = null;
      if (scheduledPlayTimeoutRef.current) {
        clearTimeout(scheduledPlayTimeoutRef.current);
        scheduledPlayTimeoutRef.current = null;
      }
      disconnectSocket();
      // [FIX-REFRESH-MIC] Capture mic state BEFORE stopMic() clears it.
      // stopMic() removes localStorage `wp_mic_${code}` as part of its teardown,
      // but on a page refresh the component unmounts and React cleanup runs —
      // clearing the flag just before the new page loads. Re-save it here so the
      // auto-restart effect (which reads localStorage on mount) can revive the mic.
      const micWasLiveOnUnmount = micEnabledRef.current;
      stopMic();
      if (micWasLiveOnUnmount) {
        try { localStorage.setItem(`wp_mic_${code}`, "1"); } catch { /* ignore */ }
      }
      if (audioPlayerRef.current?.state !== "closed") audioPlayerRef.current?.close().catch(() => {});
      audioPlayerRef.current = null;
      nextAudioTimeRef.current.clear();
      lastAudioSeqRef.current.clear();
      jitterCushionRef.current.clear();
      // [FIX-1-JITTER-QUEUE] Stop all drain loops and clear heaps on room exit.
      jitterDrainTimersRef.current.forEach(t => clearInterval(t));
      jitterDrainTimersRef.current.clear();
      jitterQueuesRef.current.forEach(h => h.clear());
      jitterQueuesRef.current.clear();
      // [FIX-3] Discard all persistent speaker compressors on room exit.
      speakerCompressorsRef.current.forEach(c => { try { c.disconnect(); } catch { /* already closed */ } });
      speakerCompressorsRef.current.clear();
    };
  }, [code, sessionToken]);

  useEffect(() => {
    if (videoStatus?.status === "ready" && videoStatus.hlsPath) setVideoHlsPath(videoStatus.hlsPath);
  }, [videoStatus]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoHlsPath) return;
    const loadHls = async () => {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = videoHlsPath;
        // iOS requires an explicit load() call after setting src to start buffering.
        // Without this the first canplay event may never fire, causing a black screen.
        video.load();
      } else {
        const HlsModule = await import("hls.js");
        const Hls = HlsModule.default;
        if (Hls.isSupported()) {
          if (hlsRef.current) (hlsRef.current as { destroy: () => void }).destroy();
          const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: false,
            // Large buffer = less stalling: pre-load 120s ahead so seeks into
            // already-buffered regions never hit the network at all.
            maxBufferLength: 120,
            maxBufferSize: 200 * 1000 * 1000,
            backBufferLength: 60,
            maxBufferHole: 1.0,
            highBufferWatchdogPeriod: 3,
            startFragPrefetch: true,
            fragLoadingMaxRetry: 6,
            fragLoadingRetryDelay: 500,
          });
          hlsRef.current = hls;
          hls.loadSource(videoHlsPath);
          hls.attachMedia(video);

          // ── HLS error handler ──────────────────────────────────────────────
          // Without this, fatal HLS errors (e.g. from rapid seeking corrupting
          // the buffer) destroy the instance silently and the video freezes or
          // the page appears to "reload" as React re-mounts the component.
          let mediaRecovered = false;
          hls.on(Hls.Events.ERROR, (_evt: unknown, data: {
            fatal: boolean;
            type: string;
            details: string;
          }) => {
            if (!data.fatal) return; // non-fatal: HLS handles internally

            if (data.type === "mediaError" && !mediaRecovered) {
              // First fatal media error: attempt built-in recovery once
              mediaRecovered = true;
              hls.recoverMediaError();
              canPlaySyncedRef.current = false;
              setTimeout(() => socketRef.current?.emit("requestSync"), 800);
            } else {
              // Either second media error or network error: full rebuild
              // Destroy the broken instance and create a fresh one so the
              // video resumes from the last known position without a page reload.
              const savedTime = video.currentTime;
              const wasPlaying = !video.paused;
              hls.destroy();
              hlsRef.current = null;

              const newHls = new Hls({
                enableWorker: true,
                lowLatencyMode: false,
                maxBufferLength: 120,
                maxBufferSize: 200 * 1000 * 1000,
                backBufferLength: 60,
                maxBufferHole: 1.0,
                highBufferWatchdogPeriod: 3,
                startFragPrefetch: true,
                fragLoadingMaxRetry: 6,
                fragLoadingRetryDelay: 500,
              });
              hlsRef.current = newHls;
              newHls.loadSource(videoHlsPath);
              newHls.attachMedia(video);
              newHls.once(Hls.Events.MANIFEST_PARSED, () => {
                video.currentTime = savedTime;
                canPlaySyncedRef.current = false;
                if (wasPlaying) {
                  video.play().catch(() => {});
                }
                setTimeout(() => socketRef.current?.emit("requestSync"), 800);
              });
            }
          });
        }
      }
    };
    loadHls();
    return () => {
      if (hlsRef.current) { (hlsRef.current as { destroy: () => void }).destroy(); hlsRef.current = null; }
    };
  }, [videoHlsPath, pendingApproval]);

  useEffect(() => {
    const onFsChange = () => {
      const fs = !!(document.fullscreenElement || (document as unknown as { webkitFullscreenElement: Element }).webkitFullscreenElement);
      setIsFullscreen(fs);
    };
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
    };
  }, []);

  // Attach native iOS fullscreen events AFTER the video element mounts (videoHlsPath triggers mount).
  // We can't do this in the effect above ([] deps) because the <video> is conditionally rendered
  // and videoRef.current is null until videoHlsPath is set.
  // We rely on webkitDisplayingFullscreen (polled live) for guard checks — these events are only
  // needed for the polling interval and requestSync-on-exit side effects.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onBegin = () => {
      setIsFullscreen(true);
      // Poll currentTime every 250ms so the external blue bar stays in sync
      // with the native iOS player while the user is in fullscreen.
      if (iosFullscreenPollingRef.current) clearInterval(iosFullscreenPollingRef.current);
      iosFullscreenPollingRef.current = setInterval(() => {
        const v = videoRef.current;
        if (v) setCurrentTime(v.currentTime);
      }, 250);
    };

    const onEnd = () => {
      setIsFullscreen(false);
      // Stop polling and snap the external bar to the exact exit position.
      if (iosFullscreenPollingRef.current) {
        clearInterval(iosFullscreenPollingRef.current);
        iosFullscreenPollingRef.current = null;
      }
      const v = videoRef.current;
      if (v) setCurrentTime(v.currentTime);
      // Re-sync so guests (who can't broadcast seeks) return to server position,
      // and the host catches up if the server timeline advanced during fullscreen.
      socketRef.current?.emit("requestSync");
    };

    video.addEventListener("webkitbeginfullscreen", onBegin);
    video.addEventListener("webkitendfullscreen", onEnd);
    return () => {
      video.removeEventListener("webkitbeginfullscreen", onBegin);
      video.removeEventListener("webkitendfullscreen", onEnd);
      if (iosFullscreenPollingRef.current) {
        clearInterval(iosFullscreenPollingRef.current);
        iosFullscreenPollingRef.current = null;
      }
    };
  }, [videoHlsPath]);

  useEffect(() => {
    if (hyperbeamEmbed) {
      setBrowserControlsVisible(true);
      if (browserControlsTimerRef.current) clearTimeout(browserControlsTimerRef.current);
      browserControlsTimerRef.current = setTimeout(() => setBrowserControlsVisible(false), 3000);
    }
    return () => { if (browserControlsTimerRef.current) clearTimeout(browserControlsTimerRef.current); };
  }, [hyperbeamEmbed]);

  // Hyperbeam JS SDK — mount/destroy session when embed URL changes
  // FIX: أضفنا `mode` للـ deps عشان لما المستخدم يرجع لتاب Browser بعد ما كان
  // في تاب تاني (video مثلاً)، الـ container بيفضل في الـ DOM (مش بيتحذف) لكن
  // الـ SDK لازم يتعمله re-mount على الـ node الجديدة.
  // FIX-DESKTOP-FULLSCREEN: بنستخدم iosBrowserFullscreen بدل isBrowserFullscreen في الـ deps:
  //   - على iOS:     iosBrowserFullscreen === isBrowserFullscreen → يتعمل re-mount لتبديل الـ container
  //   - على desktop: iosBrowserFullscreen === null دايماً → الـ effect مش بيشتغل لما fullscreen يتغير
  //                  فالـ SDK يفضل موجود والـ native fullscreen يملا الشاشة بدون انقطاع.
  useEffect(() => {
    if (!hyperbeamEmbed) {
      hbInstanceRef.current?.destroy?.();
      hbInstanceRef.current = null;
      // Clear any leftover iframe/canvas injected by the SDK so no black screen remains
      if (hbContainerRef.current) hbContainerRef.current.innerHTML = "";
      if (hbIOSContainerRef.current) hbIOSContainerRef.current.innerHTML = "";
      return;
    }
    // لو مش في browser mode، متعملش mount — الـ container موجود في DOM بس مخبي بـ CSS
    if (mode !== "browser") return;
    const container = (isBrowserFullscreen && isIOSDevice)
      ? hbIOSContainerRef.current
      : hbContainerRef.current;
    if (!container) return;
    let cancelled = false;
    Hyperbeam(container, hyperbeamEmbed).then((hb: { destroy?: () => void }) => {
      if (!cancelled) hbInstanceRef.current = hb;
    });
    return () => {
      cancelled = true;
      hbInstanceRef.current?.destroy?.();
      hbInstanceRef.current = null;
    };
  }, [hyperbeamEmbed, iosBrowserFullscreen, isIOSDevice, mode]);

  useEffect(() => {
    const onFsChange = () => {
      const fsEl = document.fullscreenElement || (document as unknown as { webkitFullscreenElement: Element | null }).webkitFullscreenElement;
      const active = !!fsEl;
      setIsBrowserFullscreen(active);
      isBrowserFullscreenRef.current = active;
      if (!active) setBrowserWidened(false);
    };
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
    };
  }, []);

  // FIX-FULLSCREEN: sync الـ ref مع الـ state دايماً —
  // iOS بيعمل fullscreen وهمي بدون document.fullscreenElement فـ onFsChange مش بتشتغل.
  // الـ useEffect ده بيضمن إن الـ ref دايماً صح حتى لو الـ state اتغير بطريقة تانية.
  useEffect(() => {
    isBrowserFullscreenRef.current = isBrowserFullscreen;
  }, [isBrowserFullscreen]);

  useEffect(() => {
    const mq = window.matchMedia("(orientation: landscape)");
    const handler = (e: MediaQueryListEvent) => {
      setIsLandscape(e.matches);
      if (!e.matches) setBrowserWidened(false);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // Widen: Hyperbeam uses Shadow DOM — access shadowRoot to measure canvas visual width,
  // then apply scaleX to the container (outside shadow) to fill screen width, height unchanged.
  useEffect(() => {
    const container = (isBrowserFullscreen && isIOSDevice)
      ? hbIOSContainerRef.current
      : hbContainerRef.current;

    if (!container) return;

    if (!browserWidened) {
      container.style.removeProperty("transform");
      container.style.removeProperty("transform-origin");
      return;
    }

    let timer: ReturnType<typeof setTimeout>;

    const tryApply = () => {
      // Hyperbeam attaches a Shadow DOM — must use shadowRoot to reach its canvas
      const shadow = container.shadowRoot;
      const el = shadow?.querySelector<HTMLElement>("canvas, iframe, video");

      if (!el) {
        // Not ready yet — retry
        timer = setTimeout(tryApply, 100);
        return;
      }

      const containerW = container.offsetWidth;
      // getBoundingClientRect reflects visual size after Hyperbeam's own scale transform
      const visualW = el.getBoundingClientRect().width;

      if (visualW > 0 && visualW < containerW - 1) {
        // Stretch container so Hyperbeam content fills full width; height stays the same
        const sx = containerW / visualW;
        container.style.setProperty("transform", `scaleX(${sx})`);
        container.style.setProperty("transform-origin", "center center");
      }
      // If visualW >= containerW, already fills width — nothing to do
    };

    // Give Hyperbeam ~400ms to mount and apply its initial scale inside the shadow DOM
    timer = setTimeout(tryApply, 400);

    return () => {
      clearTimeout(timer);
      container.style.removeProperty("transform");
      container.style.removeProperty("transform-origin");
    };
  }, [browserWidened, isBrowserFullscreen, isIOSDevice, hyperbeamEmbed]);


  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    if (isPlayingRef.current) {
      controlsTimerRef.current = setTimeout(() => setControlsVisible(false), 3000);
    }
  }, []);

  const showBrowserControls = useCallback(() => {
    setBrowserControlsVisible(true);
    if (browserControlsTimerRef.current) clearTimeout(browserControlsTimerRef.current);
    browserControlsTimerRef.current = setTimeout(() => setBrowserControlsVisible(false), 3000);
  }, []);

  const emitVideoControl = useCallback((action: "play" | "pause" | "seek", time: number) => {
    socketRef.current?.emit("videoControl", { action, currentTime: time });
  }, []);

  // Safe play: stores the promise so safePause can wait for it.
  const safePlay = useCallback((v: HTMLVideoElement): Promise<void> => {
    const p = v.play().catch(() => {});
    playPromiseRef.current = p;
    return p;
  }, []);

  // Safe pause: waits for any pending play() to settle first, then pauses.
  // Prevents "play() interrupted by pause()" AbortErrors.
  const safePause = useCallback(async (v: HTMLVideoElement): Promise<void> => {
    if (playPromiseRef.current) {
      await playPromiseRef.current.catch(() => {});
      playPromiseRef.current = null;
    }
    if (!v.paused) v.pause();
  }, []);

  const handlePlayPause = useCallback(() => {
    if (!isPrivileged) return;
    const v = videoRef.current;
    if (!v) return;
    isLocalControlRef.current = true;
    suppressSyncUntilRef.current = Date.now() + 1200; // FIX-SYNC-3: 2500ms → 1200ms
    setTimeout(() => { isLocalControlRef.current = false; }, 200);
    if (v.paused) { safePlay(v); emitVideoControl("play", v.currentTime); }
    else { safePause(v); emitVideoControl("pause", v.currentTime); }
    showControls();
  }, [isPrivileged, emitVideoControl, showControls]);

  /** Mark a local-initiated seek; clear after the seeked event fires or after a fallback timeout. */
  const beginLocalSeek = useCallback(() => {
    if (localControlTimeoutRef.current) clearTimeout(localControlTimeoutRef.current);
    isLocalControlRef.current = true;
    // FIX-SYNC-3: suppress window 2500ms → 1200ms (less aggressive, host stays in sync)
    suppressSyncUntilRef.current = Date.now() + 1200;
    // Fallback: iOS seeks can take 3-4s to fetch segments — clear guard if seeked never fires.
    localControlTimeoutRef.current = setTimeout(() => {
      isLocalControlRef.current = false;
      localControlTimeoutRef.current = null;
    }, isIOSDevice ? 5000 : 400);
  }, [isIOSDevice]);

  const handleSkip = useCallback((seconds: number) => {
    if (!isPrivileged) return;
    const v = videoRef.current;
    if (!v) return;
    const newTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + seconds));
    beginLocalSeek();
    v.currentTime = newTime;
    emitVideoControl("seek", newTime);
    showControls();
  }, [isPrivileged, beginLocalSeek, emitVideoControl, showControls]);

  const handleSeekBar = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (!isPrivileged) return;
    const v = videoRef.current;
    if (!v) return;
    const newTime = (parseFloat(e.target.value) / 1000) * (v.duration || 0);
    beginLocalSeek();
    v.currentTime = newTime;
    emitVideoControl("seek", newTime);
  }, [isPrivileged, beginLocalSeek, emitVideoControl]);

  const handleFullscreen = useCallback(() => {
    const container = videoContainerRef.current;
    const video = videoRef.current;
    if (!container) return;
    if (isFullscreen) {
      const doc = document as Document & { webkitExitFullscreen?: () => void };
      if (document.exitFullscreen) document.exitFullscreen();
      else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen();
      else {
        const iosVideo = video as (HTMLVideoElement & { webkitExitFullscreen?: () => void }) | null;
        if (iosVideo?.webkitExitFullscreen) iosVideo.webkitExitFullscreen();
        else setIsFullscreen(false);
      }
      return;
    }
    if (video) {
      const iosVideo = video as HTMLVideoElement & { webkitSupportsFullscreen?: boolean; webkitEnterFullscreen?: () => void };
      if (iosVideo.webkitSupportsFullscreen && iosVideo.webkitEnterFullscreen) {
        iosVideo.webkitEnterFullscreen(); return;
      }
    }
    const el = container as HTMLElement & { webkitRequestFullscreen?: () => void };
    if (el.requestFullscreen) el.requestFullscreen().catch(() => setIsFullscreen(true));
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    else setIsFullscreen(true);
  }, [isFullscreen]);

  const showIOSFullscreenControls = useCallback(() => {
    setIOSFullscreenControlsVisible(true);
    if (iosFullscreenTimerRef.current) clearTimeout(iosFullscreenTimerRef.current);
    iosFullscreenTimerRef.current = setTimeout(() => setIOSFullscreenControlsVisible(false), 3000);
  }, []);

  // Screen Share iOS fullscreen helpers — نفس نهج Hyperbeam بالظبط
  const showSSIOSControls = useCallback(() => {
    setSSIOSControlsVisible(true);
    if (ssIOSTimerRef.current) clearTimeout(ssIOSTimerRef.current);
    ssIOSTimerRef.current = setTimeout(() => setSSIOSControlsVisible(false), 3000);
  }, []);

  const openSSIOSFullscreen = useCallback(() => {
    setIsSSIOSFullscreen(true);
    setSSIOSControlsVisible(true);
    if (ssIOSTimerRef.current) clearTimeout(ssIOSTimerRef.current);
    ssIOSTimerRef.current = setTimeout(() => setSSIOSControlsVisible(false), 3000);
  }, []);

  const closeSSIOSFullscreen = useCallback(() => {
    setIsSSIOSFullscreen(false);
    if (ssIOSTimerRef.current) clearTimeout(ssIOSTimerRef.current);
  }, []);

  // اعتراض webkitbeginfullscreen على فيديو الـ screen share —
  // لما iOS يحاول يدخل fullscreen الـ native، نخرجه فوراً ونعرض overlay-نا
  useEffect(() => {
    const video = screenVideoRef.current;
    if (!video || !isIOSDevice) return;
    const onBeginFS = () => {
      const v = video as HTMLVideoElement & { webkitExitFullscreen?: () => void };
      if (v.webkitExitFullscreen) v.webkitExitFullscreen();
      openSSIOSFullscreen();
    };
    video.addEventListener("webkitbeginfullscreen", onBeginFS);
    return () => video.removeEventListener("webkitbeginfullscreen", onBeginFS);
  }, [isIOSDevice, openSSIOSFullscreen]);

  // مزامنة الـ srcObject مع فيديو الـ iOS overlay عند فتحه
  useEffect(() => {
    const iosVideo = screenVideoIOSRef.current;
    if (!iosVideo || !isSSIOSFullscreen) return;
    const stream = screenStreamRef.current ?? remoteScreenStream;
    if (stream) {
      iosVideo.srcObject = stream;
      iosVideo.play().catch(() => {});
    }
    return () => { iosVideo.srcObject = null; };
  }, [isSSIOSFullscreen, remoteScreenStream]);

  // handle maximize button — على iOS نفتح overlay-نا، على غيره handleFullscreen العادي
  const handleScreenShareFullscreen = useCallback(() => {
    if (isIOSDevice) {
      if (isSSIOSFullscreen) closeSSIOSFullscreen();
      else openSSIOSFullscreen();
      return;
    }
    handleFullscreen();
  }, [isIOSDevice, isSSIOSFullscreen, openSSIOSFullscreen, closeSSIOSFullscreen, handleFullscreen]);

  const handleBrowserFullscreen = useCallback(() => {
    if (isBrowserFullscreen) {
      if (isIOSDevice) {
        setIsBrowserFullscreen(false);
        if (iosFullscreenTimerRef.current) clearTimeout(iosFullscreenTimerRef.current);
      } else if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => setIsBrowserFullscreen(false));
      } else {
        setIsBrowserFullscreen(false);
      }
    } else {
      if (isIOSDevice) {
        setIsBrowserFullscreen(true);
        if (iosFullscreenTimerRef.current) clearTimeout(iosFullscreenTimerRef.current);
        iosFullscreenTimerRef.current = setTimeout(() => setIOSFullscreenControlsVisible(false), 3000);
        return;
      }
      const el = browserContainerRef.current as HTMLElement & { webkitRequestFullscreen?: () => void };
      if (!el) { setIsBrowserFullscreen(true); return; }
      if (el.requestFullscreen) {
        el.requestFullscreen().catch(() => setIsBrowserFullscreen(true));
      } else if (el.webkitRequestFullscreen) {
        el.webkitRequestFullscreen();
      } else {
        setIsBrowserFullscreen(true);
      }
    }
  }, [isBrowserFullscreen, isIOSDevice]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === "Space") { e.preventDefault(); handlePlayPause(); }
      else if (e.code === "ArrowRight") handleSkip(10);
      else if (e.code === "ArrowLeft") handleSkip(-10);
      else if (e.code === "KeyF") handleFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handlePlayPause, handleSkip, handleFullscreen]);

  const handleVideoPlay = () => {
    setIsPlaying(true); isPlayingRef.current = true;
    // Keep OS media system in sync → lock screen "play" indicator + iOS audio session
    if ("mediaSession" in navigator) {
      try { navigator.mediaSession.playbackState = "playing"; } catch { /* ignore */ }
      const v = videoRef.current;
      if (v && isFinite(v.duration) && v.duration > 0 && "setPositionState" in navigator.mediaSession) {
        try {
          navigator.mediaSession.setPositionState({
            duration: v.duration,
            position: Math.min(v.currentTime, v.duration),
            playbackRate: v.playbackRate,
          });
        } catch { /* ignore */ }
      }
    }
    if (isPrivileged && !isRemoteControlRef.current && !isLocalControlRef.current) {
      emitVideoControl("play", videoRef.current?.currentTime ?? 0);
      return;
    }
    // Guest in native iOS fullscreen: force-pause ANY play attempt — even rapid taps that
    // arrive while isRemoteControlRef is still set from the previous force-pause.
    // We intentionally skip the !isRemoteControlRef guard here because:
    //   • serverWantsPlaying = true  → remote play → we don't force-pause (correct)
    //   • serverWantsPlaying = false → guest tap   → always force-pause (correct)
    // "null" pending (video just loaded) is treated as paused so guests cannot
    // play before the host has started the session.
    if (!isPrivileged) {
      const v = videoRef.current;
      const inNativeFS = (v as HTMLVideoElement & { webkitDisplayingFullscreen?: boolean })?.webkitDisplayingFullscreen;
      const serverWantsPlaying = pendingVideoSyncRef.current?.shouldPlay === true;
      if (inNativeFS && !serverWantsPlaying && v) {
        isRemoteControlRef.current = true;
        v.pause();
        setTimeout(() => { isRemoteControlRef.current = false; }, 300);
      }
    }
  };
  const handleVideoPause = () => {
    setIsPlaying(false); isPlayingRef.current = false;
    // Keep OS media system in sync → lock screen "pause" indicator
    if ("mediaSession" in navigator) {
      try { navigator.mediaSession.playbackState = "paused"; } catch { /* ignore */ }
    }
    if (isPrivileged && !isRemoteControlRef.current && !isLocalControlRef.current) {
      emitVideoControl("pause", videoRef.current?.currentTime ?? 0);
      return;
    }
    // Guest in native iOS fullscreen: if the room is playing, force-play on EVERY pause event.
    // Mirrors the force-pause guard in handleVideoPlay.
    // Safe: syncToTarget is blocked by webkitDisplayingFullscreen, so no loop is possible.
    if (!isPrivileged) {
      const v = videoRef.current;
      const inNativeFS = (v as HTMLVideoElement & { webkitDisplayingFullscreen?: boolean })?.webkitDisplayingFullscreen;
      const serverWantsPlaying = pendingVideoSyncRef.current && pendingVideoSyncRef.current.shouldPlay;
      if (inNativeFS && serverWantsPlaying && v) {
        isRemoteControlRef.current = true;
        v.play().catch(() => {});
        setTimeout(() => { isRemoteControlRef.current = false; }, 300);
      }
    }
  };
  const handleVideoSeeked = () => {
    // Guest in native iOS fullscreen: snap back to server position on ANY seek attempt,
    // whether the room is paused OR playing. Covers skip-back/skip-forward buttons and
    // scrubbing. For a playing room the snap-target is estimated from the stored sync point.
    // isRemoteControlRef prevents re-entry when we set currentTime below.
    if (!isPrivileged && !isRemoteControlRef.current) {
      const v = videoRef.current;
      const inNativeFS = (v as HTMLVideoElement & { webkitDisplayingFullscreen?: boolean })?.webkitDisplayingFullscreen;
      const pending = pendingVideoSyncRef.current;
      if (inNativeFS && v) {
        isRemoteControlRef.current = true;
        if (pending) {
          // Estimate live server position: storedAt is Date.now() when syncState was applied
          const elapsed = pending.shouldPlay ? (Date.now() - pending.storedAt) / 1000 : 0;
          v.currentTime = pending.targetTime + elapsed;
        }
        // If no pending yet (video just loaded), currentTime is left as-is — the next
        // syncState will correct it. We still set isRemoteControlRef so any in-flight seek
        // event is absorbed without broadcasting.
        setTimeout(() => { isRemoteControlRef.current = false; }, 500);
        return;
      }
    }

    if (isPrivileged) {
      const v = videoRef.current;
      const inNativeFS = !!(v as HTMLVideoElement & { webkitDisplayingFullscreen?: boolean })?.webkitDisplayingFullscreen;

      // iOS native fullscreen: the native seekbar can fire seeked while isLocalControlRef
      // is still true (e.g. user tapped skip then immediately dragged the native bar).
      // In that case the guard would block broadcasting the new position — the server keeps
      // the old time and the next heartbeat sync snaps the video back.
      // Fix: in native FS always broadcast the seek, regardless of local/remote guards,
      // and use a longer suppress window (3 s) because iOS network round-trips take longer.
      if (inNativeFS && !isRemoteControlRef.current) {
        if (v) {
          if (scheduledPlayTimeoutRef.current) {
            clearTimeout(scheduledPlayTimeoutRef.current);
            scheduledPlayTimeoutRef.current = null;
          }
          suppressSyncUntilRef.current = Date.now() + 3000;
          emitVideoControl("seek", v.currentTime);
        }
      } else if (!isRemoteControlRef.current && !isLocalControlRef.current) {
        // Non-fullscreen host seek (app seekbar / skip buttons already emit directly —
        // this branch only fires for Picture-in-Picture or other native controls).
        if (v) {
          if (scheduledPlayTimeoutRef.current) {
            clearTimeout(scheduledPlayTimeoutRef.current);
            scheduledPlayTimeoutRef.current = null;
          }
          suppressSyncUntilRef.current = Date.now() + 1200;
          emitVideoControl("seek", v.currentTime);
        }
      }
      // Clear the local-seek guard as soon as iOS finishes its async seek,
      // cancelling the fallback timeout so the guard doesn't linger unnecessarily.
      if (localControlTimeoutRef.current) {
        clearTimeout(localControlTimeoutRef.current);
        localControlTimeoutRef.current = null;
      }
      isLocalControlRef.current = false;
    } else {
      // Only request a fresh sync for user-initiated seeks — NOT for remote-controlled
      // ones triggered by syncToTarget. Emitting requestSync after every remote seek
      // creates a ping-pong loop on iOS: seek → requestSync → videoSync → seek → …
      if (!isRemoteControlRef.current) {
        socketRef.current?.emit("requestSync");
      }
    }
    seekingRef.current = false;
  };
  const handleVideoTimeUpdate = () => { const v = videoRef.current; if (v) setCurrentTime(v.currentTime); };

  const handleVideoError = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.error?.code === 4) { // MEDIA_ERR_SRC_NOT_SUPPORTED — buffer/chunk race
      const hls = hlsRef.current as { recoverMediaError?: () => void } | null;
      if (hls?.recoverMediaError) {
        // HLS.js active: use built-in recovery (keeps MSE attachment intact).
        // Wait 800 ms for HLS to finish re-attaching before requesting sync so
        // syncToTarget finds readyState >= 2 and actually seeks + plays instead
        // of just storing a pending sync that never gets applied.
        hls.recoverMediaError();
        setTimeout(() => {
          canPlaySyncedRef.current = false;
          socketRef.current?.emit("requestSync");
        }, 800);
      } else {
        // Native HLS (iOS Safari) — safe to reset src directly
        const savedTime = v.currentTime;
        const savedSrc = v.src;
        v.src = "";
        v.load();
        v.src = savedSrc;
        v.currentTime = savedTime;
        if (!v.paused) v.play().catch(() => {});
        setTimeout(() => socketRef.current?.emit("requestSync"), 800);
      }
    }
  }, []);

  const [isSyncing, setIsSyncing] = useState(false);
  // Stall-recovery: if isSyncing stays true for > 5 s something went wrong
  // (e.g. the video was seeked so many times the HLS buffer is corrupted).
  // Force-reset the sync lock and emit requestSync to restart the flow cleanly.
  useEffect(() => {
    if (!isSyncing) return;
    const tid = setTimeout(() => {
      isSyncActiveRef.current = false;
      setIsSyncing(false);
      socketRef.current?.emit("requestSync");
    }, 5000);
    return () => clearTimeout(tid);
  }, [isSyncing]);

  // Resolves after a seek completes or is confirmed a no-op (80 ms grace, 2 s hard fallback)
  const waitForSeeked = (v: HTMLVideoElement): Promise<void> =>
    new Promise(resolve => {
      let done = false;
      const finish = () => { if (done) return; done = true; v.removeEventListener("seeked", finish); clearTimeout(hard); resolve(); };
      v.addEventListener("seeked", finish, { once: true });
      const hard = setTimeout(finish, 2000);
      setTimeout(() => { if (!v.seeking) finish(); }, 80);
    });

  // ─── Single sync entry point ────────────────────────────────────────────────
  // Soft correction (playbackRate) for non-iOS small drifts — avoids rebuffering.
  // Hard seek only when drift is large or on iOS (where playbackRate causes stutter).
  // Sequence: soft → or → [pause if needed] → seek → waitForSeeked → play/pause
  const syncToTarget = useCallback(async (
    targetTime: number,
    shouldPlay: boolean,
    force: boolean,
  ) => {
    const v = videoRef.current;
    if (!v || v.readyState < 2) {
      pendingVideoSyncRef.current = { targetTime, shouldPlay, storedAt: Date.now() };
      // Reset the canplay guard so handleVideoCanPlay will re-apply this sync
      // once the browser can resume (stall recovery). Without this reset the guard
      // blocks handleVideoCanPlay and the pending sync sits until the next heartbeat.
      canPlaySyncedRef.current = false;
      // Reconnect recovery: nudge the video to targetTime so the HLS player
      // starts fetching the required segment. Without this seek, a video
      // suspended by the OS (e.g. screen lock while playing) never fires canplay
      // and the pending sync sits forever — user is stuck at the pre-disconnect position.
      // Guard: only nudge when shouldPlay=true. Nudging a PAUSED video with
      // readyState<2 (common on iOS after brief suspension) causes a black screen
      // because the seek forces a segment fetch the player isn't ready for.
      if (v && v.src && !v.seeking && shouldPlay) {
        isRemoteControlRef.current = true;
        try { v.currentTime = targetTime; } catch { /* ignore — video not ready */ }
        setTimeout(() => { isRemoteControlRef.current = false; }, 300);
      }
      return;
    }
    // Native iOS fullscreen: the system player owns currentTime for small drifts (< 3s) so
    // the native seek bar is not disturbed by periodic micro-corrections.
    // However, host-initiated seeks produce large drifts (> 3s) and must be applied
    // immediately. Play/pause mismatches are always enforced.
    if ((v as HTMLVideoElement & { webkitDisplayingFullscreen?: boolean }).webkitDisplayingFullscreen) {
      pendingVideoSyncRef.current = { targetTime, shouldPlay, storedAt: Date.now() };
      const playMismatch = shouldPlay ? v.paused : !v.paused;
      const absDrift = Math.abs(v.currentTime - targetTime);
      // Large drift = host seek (periodic loops are blocked from calling syncToTarget in fullscreen).
      const needsSeek = absDrift > 3.0;

      if (needsSeek) {
        // Seeking in native fullscreen is only safe when the target is already buffered.
        // Seeking to an unbuffered position forces iOS to re-fetch the HLS playlist which
        // corrupts the duration display (e.g. 39-min video shows -1:30:20 remaining).
        // When not buffered: exit native fullscreen — webkitendfullscreen fires requestSync
        // which applies the correct position cleanly outside fullscreen.
        let inBufferedRange = false;
        for (let i = 0; i < v.buffered.length; i++) {
          if (targetTime >= v.buffered.start(i) && targetTime <= v.buffered.end(i)) {
            inBufferedRange = true;
            break;
          }
        }
        if (inBufferedRange) {
          isRemoteControlRef.current = true;
          v.currentTime = targetTime;
          if (playMismatch) {
            if (shouldPlay) { safePlay(v); } else { safePause(v); }
          }
          setTimeout(() => { isRemoteControlRef.current = false; }, 500);
        } else {
          // Seek directly in fullscreen even if target is unbuffered.
          // Wait for the `seeked` event before playing — iOS HLS needs 1-3s to
          // fetch the new segment. On iOS, `seeked` fires before the HLS segment
          // is buffered so playing immediately still causes a freeze. Instead we
          // wait for `canplay` (readyState >= 3) which means the browser has
          // enough data to actually start playback. A 5s fallback handles slow
          // networks or cases where canplay never fires (e.g. network timeout).
          isRemoteControlRef.current = true;
          await safePause(v);

          let playTriggered = false;
          const tryPlay = () => {
            if (playTriggered) return;
            playTriggered = true;
            v.removeEventListener("canplay", onCanPlay);
            clearTimeout(canPlayFallback);
            if (shouldPlay) { safePlay(v); } else { safePause(v); }
            setTimeout(() => { isRemoteControlRef.current = false; }, 300);
          };

          const onCanPlay = () => tryPlay();

          const canPlayFallback = setTimeout(() => tryPlay(), 5000);

          v.addEventListener("canplay", onCanPlay);
          v.currentTime = targetTime;
        }
      } else if (playMismatch) {
        isRemoteControlRef.current = true;
        if (shouldPlay) { safePlay(v); } else { safePause(v); }
        setTimeout(() => { isRemoteControlRef.current = false; }, 300);
      }
      return;
    }
    if (isSyncActiveRef.current) return;

    const drift = v.currentTime - targetTime;
    const absDrift = Math.abs(drift);
    const playMismatch = shouldPlay ? v.paused : !v.paused;

    if (!force && absDrift < 0.15 && !playMismatch) return;

    // ── Soft correction: delegated entirely to the micro-loop ──────────────────
    // Soft drift — delegate entirely to the continuous micro-loop.
    // The micro-loop runs every 200 ms and adjusts playbackRate smoothly.
    // Setting a competing rate here (with a separate setTimeout to reset it)
    // fights the micro-loop and causes playbackRate oscillation on iOS → stutter.
    const softCeiling = 3.0;
    if (!force && !playMismatch && absDrift >= 0.15 && absDrift < softCeiling) {
      // Refresh the reference so the micro-loop targets the latest server time
      pendingVideoSyncRef.current = { targetTime, shouldPlay, storedAt: Date.now() };
      return;
    }

    isSyncActiveRef.current = true;
    isRemoteControlRef.current = true;
    setIsSyncing(true);

    const pendingAtStart = pendingVideoSyncRef.current;

    try {
      v.playbackRate = 1;

      // Special case: resuming from pause where lag-compensation pushes target ≤2s ahead.
      // On iOS native HLS a seek on a paused video forces segment re-fetching → stutter.
      const isResumingFromPause = shouldPlay && v.paused;
      // iOS: only hard-seek for large drifts (> 3s). Small drifts are handled by
      // the micro-correction loop via playbackRate — far smoother than a segment fetch.
      const seekThreshold = isIOSDevice ? 3.0 : 0.5;
      const needsSeek = absDrift >= seekThreshold && !(isResumingFromPause && absDrift < 2.0);
      if (needsSeek) {
        if (!v.paused) { await safePause(v); }

        // Buffered-range-aware seek: on iOS, if the target time is not yet buffered,
        // seek to the nearest buffered position within 8s before the target instead.
        // This avoids a long black screen while iOS fetches the remote HLS segment.
        let seekTarget = targetTime;
        if (isIOSDevice && v.buffered.length > 0) {
          let isBuffered = false;
          let bestBufferedEnd = -1;
          for (let i = 0; i < v.buffered.length; i++) {
            if (targetTime >= v.buffered.start(i) && targetTime <= v.buffered.end(i)) {
              isBuffered = true; break;
            }
            // Track closest buffered end that's before (or near) the target
            const end = v.buffered.end(i);
            if (end <= targetTime + 1 && end > bestBufferedEnd) bestBufferedEnd = end;
          }
          if (!isBuffered && bestBufferedEnd > 0 && targetTime - bestBufferedEnd < 8) {
            // Seek to just before the buffered end — avoids stall, then drift corrects naturally
            seekTarget = Math.max(0, bestBufferedEnd - 0.2);
          }
        }

        v.currentTime = seekTarget;
        await waitForSeeked(v);
      }
      if (shouldPlay && v.paused) {
        try {
          await safePlay(v);
          setIsPlaying(true); isPlayingRef.current = true;
          tapToPlayRef.current = false; setTapToPlay(false);
        } catch {
          pendingPlayTimeRef.current = targetTime;
          tapToPlayRef.current = true; setTapToPlay(true);
        }
      } else if (!shouldPlay && !v.paused) {
        await safePause(v);
        setIsPlaying(false); isPlayingRef.current = false;
      }
      if (pendingVideoSyncRef.current === pendingAtStart) {
        pendingVideoSyncRef.current = null;
      }
    } finally {
      v.playbackRate = 1;
      isSyncActiveRef.current = false;
      setIsSyncing(false);
      setTimeout(() => {
        isRemoteControlRef.current = false;
        const queued = pendingVideoSyncRef.current;
        if (queued) {
          const elapsed = queued.shouldPlay ? (Date.now() - queued.storedAt) / 1000 : 0;
          syncToTarget(Math.max(0, queued.targetTime + elapsed), queued.shouldPlay, false);
        }
      }, 300);
    }
  }, [isIOSDevice, safePlay, safePause]);

  const handleVideoLoadedMetadata = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    setDuration(v.duration);
    // readyState = 1 here — no buffer yet, iOS seek silently fails at this stage.
    // Reset guard so the upcoming canplay fires a fresh seek.
    canPlaySyncedRef.current = false;
    // Do NOT clear pendingVideoSyncRef — a videoSync may have already arrived
    // before metadata loaded (common on iOS). Keep it so canplay can apply it.
    // Only request a fresh sync if we don't have one waiting already.
    if (!pendingVideoSyncRef.current) {
      socketRef.current?.emit("requestSync");
    }
  }, []);

  const handleVideoCanPlay = useCallback(() => {
    // canplay fires on every new HLS segment on iOS — guard to run only once per load.
    // The guard is reset to false by syncToTarget when it detects a stall (readyState < 2),
    // so stall-recovery also flows through here without triggering on every normal segment.
    if (canPlaySyncedRef.current) return;
    if (pendingVideoSyncRef.current) {
      // Pending sync available — apply it now that video is ready
      canPlaySyncedRef.current = true;
      const { targetTime, shouldPlay, storedAt } = pendingVideoSyncRef.current;
      const elapsed = shouldPlay ? (Date.now() - storedAt) / 1000 : 0;
      syncToTarget(Math.max(0, targetTime + elapsed), shouldPlay, true);
    } else {
      // No pending sync yet — video is ready but sync response hasn't arrived.
      // This happens when canplay fires before the requestSync response comes back
      // (common on slow mobile connections). Request fresh sync now that we're ready.
      // Set the guard so subsequent canplay events (iOS fires one per HLS segment) don't repeat.
      canPlaySyncedRef.current = true;
      socketRef.current?.emit("requestSync");
    }
  }, [syncToTarget]);

  // Guests: request sync every 8s as a self-healing fallback (tightened from 15s)
  useEffect(() => {
    if (isPrivileged || !videoHlsPath) return;
    const id = setInterval(() => {
      if (socketRef.current?.connected) {
        socketRef.current.emit("requestSync");
      }
    }, 8_000);
    return () => clearInterval(id);
  }, [isPrivileged, videoHlsPath]);

  // Stall detector: when the video fires 'waiting' (buffering stall) AND a sync
  // is pending, request a fresh syncState after 2 s so the flow restarts cleanly.
  // 'playing' cancels the timer if the video recovers on its own first.
  useEffect(() => {
    if (!videoHlsPath) return;
    const v = videoRef.current;
    if (!v) return;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const onWaiting = () => {
      // Don't trigger stall recovery while the app is in the background.
      // In background, syncToTarget calls v.play() without a user gesture,
      // which causes the browser to mute audio (muted-autoplay policy).
      // Let handleForeground restore the sync when the user returns instead.
      if (document.hidden) return;
      if (stallTimer) return; // already counting
      stallTimer = setTimeout(() => {
        stallTimer = null;
        canPlaySyncedRef.current = false;
        socketRef.current?.emit("requestSync");
      }, 2000);
    };
    const onPlaying = () => {
      if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
    };
    v.addEventListener("waiting", onWaiting);
    v.addEventListener("playing", onPlaying);
    return () => {
      v.removeEventListener("waiting", onWaiting);
      v.removeEventListener("playing", onPlaying);
      if (stallTimer) clearTimeout(stallTimer);
    };
  }, [videoHlsPath]);

  // Guests: micro-correction loop — smooth drift fix between heartbeats.
  // iOS: playbackRate changes every 200ms stress the native HLS buffer and cause
  // constant stutter (تقطع). On iOS we run at a much slower interval (5s) with a
  // high drift threshold (3s) so the native player is left alone during normal playback.
  // Android/desktop: requestAnimationFrame loop throttled to ~150ms for tightest sync
  // without the fixed overhead of setInterval.
  useEffect(() => {
    if (isPrivileged || !videoHlsPath) return;

    const THRESHOLD = isIOSDevice ? 3.0 : 0.15;

    if (isIOSDevice) {
      // ── iOS: slow 5s interval — native HLS can't handle frequent rate changes ──
      const id = setInterval(() => {
        const v = videoRef.current;
        const pending = pendingVideoSyncRef.current;
        if (
          !v || !pending ||
          v.readyState < 3 ||
          v.paused ||
          isRemoteControlRef.current ||
          isSyncActiveRef.current ||
          tapToPlayRef.current
        ) {
          if (v && v.playbackRate !== 1 && !isSyncActiveRef.current) v.playbackRate = 1;
          return;
        }
        // Skip periodic drift corrections in native fullscreen — the system player owns
        // currentTime. Host play/pause commands are handled directly by syncToTarget
        // via the syncState socket event, so no periodic correction is needed here.
        if ((v as HTMLVideoElement & { webkitDisplayingFullscreen?: boolean })?.webkitDisplayingFullscreen) return;
        const elapsed = pending.shouldPlay ? (Date.now() - pending.storedAt) / 1000 : 0;
        const target = Math.max(0, pending.targetTime + elapsed);
        const absDrift = Math.abs(v.currentTime - target);
        // Drift reporting for iOS — mirrors the RAF loop report so the server can
        // detect and force-resync iOS clients with extreme sustained drift.
        const nowIos = Date.now();
        if (nowIos - lastDriftReportRef.current > 4000) {
          lastDriftReportRef.current = nowIos;
          socketRef.current?.volatile.emit("driftReport", { drift: v.currentTime - target, position: v.currentTime });
        }
        if (absDrift > 5.0) {
          if (v.playbackRate !== 1) v.playbackRate = 1;
          syncToTarget(target, pending.shouldPlay, false);
        } else if (absDrift > THRESHOLD) {
          syncToTarget(target, pending.shouldPlay, false);
        } else {
          if (v.playbackRate !== 1) v.playbackRate = 1;
        }
      }, 5000);
      return () => {
        clearInterval(id);
        const v = videoRef.current;
        if (v && v.playbackRate !== 1) v.playbackRate = 1;
      };
    }

    // ── Non-iOS: requestAnimationFrame loop throttled to ~150ms ──────────────
    // rAF gives sub-millisecond timing precision vs setInterval's ~4ms minimum
    // jitter, resulting in smoother drift corrections on desktop and Android.
    let rafId: number;
    let lastCheck = 0;
    const RAF_THROTTLE_MS = 150;

    const loop = (timestamp: number) => {
      if (timestamp - lastCheck >= RAF_THROTTLE_MS) {
        lastCheck = timestamp;
        const v = videoRef.current;
        const pending = pendingVideoSyncRef.current;
        if (
          !v || !pending ||
          v.readyState < 3 ||
          v.paused ||
          isRemoteControlRef.current ||
          isSyncActiveRef.current ||
          tapToPlayRef.current
        ) {
          if (v && v.playbackRate !== 1 && !isSyncActiveRef.current) v.playbackRate = 1;
        } else {
          const elapsed = pending.shouldPlay ? (Date.now() - pending.storedAt) / 1000 : 0;
          const target = Math.max(0, pending.targetTime + elapsed);
          const drift = v.currentTime - target;
          const absDrift = Math.abs(drift);

          // Drift report to server every 3s — server monitors lag and
          // force-resyncs any client with extreme drift (>8s).
          const nowMs = Date.now();
          if (nowMs - lastDriftReportRef.current > 3000) {
            lastDriftReportRef.current = nowMs;
            socketRef.current?.volatile.emit("driftReport", { drift, position: v.currentTime });
          }

          if (absDrift > 4.0) {
            if (v.playbackRate !== 1) v.playbackRate = 1;
            syncToTarget(target, pending.shouldPlay, true);
          } else if (absDrift > THRESHOLD) {
            // Adaptive playbackRate:
            //   < 0.5s drift → ±3%: gentle correction, minimises audio pitch change
            //   ≥ 0.5s drift → ±8%: fast convergence for noticeable lag
            const rate = drift > 0
              ? (absDrift < 0.5 ? 0.97 : 0.92)
              : (absDrift < 0.5 ? 1.03 : 1.08);
            if (v.playbackRate !== rate) v.playbackRate = rate;
          } else {
            if (v.playbackRate !== 1) v.playbackRate = 1;
          }
        }
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rafId);
      const v = videoRef.current;
      if (v && v.playbackRate !== 1) v.playbackRate = 1;
    };
  }, [isPrivileged, videoHlsPath, isIOSDevice, syncToTarget]);

  // Periodic clock re-sync every 30s to maintain accuracy
  useEffect(() => {
    if (!isConnected) return;
    const doClockSync = () => {
      const t0 = Date.now();
      socketRef.current?.emit("clockSync", { t0 });
      socketRef.current?.once("clockSyncAck", ({ t0: echo, t1 }: { t0: number; t1: number }) => {
        const t2 = Date.now();
        const rtt = t2 - echo;
        const offset = t1 - echo - rtt / 2;
        const samples = clockSyncSamplesRef.current;
        samples.push(offset);
        if (samples.length > 10) samples.shift();
        const sorted = [...samples].sort((a, b) => a - b);
        serverClockOffsetRef.current = sorted[Math.floor(sorted.length / 2)];
        // FIX-CLOCK-DRIFT-ALERT: if clock offset > 500ms after calibration,
        // force a requestSync so the server re-sends a fresh syncState with
        // corrected playAt timing (prevents guests from playing at wrong time).
        if (Math.abs(serverClockOffsetRef.current) > 500 && samples.length >= 3) {
          socketRef.current?.emit("requestSync");
        }
      });
    };
    const id = setInterval(doClockSync, 30_000);
    return () => clearInterval(id);
  }, [isConnected]);

  const stopMic = useCallback(() => {
    // [FIX-REF-SYNC] Set the ref to false synchronously BEFORE any async work.
    // stopMic() calls setMicEnabled(false) which is a React state update — the
    // corresponding useEffect that syncs micEnabledRef only runs after the next
    // render. If finishTeardown() fires (60ms later) before that render, the ref
    // still reads true and the setStream(null) guard is skipped, leaving a dead
    // track attached to every WebRTC peer connection. Setting it here closes the gap.
    micEnabledRef.current = false;
    if (micIntervalRef.current) { clearInterval(micIntervalRef.current); micIntervalRef.current = null; }
    micStreamRef.current?.getTracks().forEach(t => t.stop());
    micStreamRef.current = null;

    const worklet = workletNodeRef.current;
    const sampleRateAtStop = audioContextRef.current?.sampleRate ?? 48000;
    const hadConnectedPeers = !!webrtcManagerRef.current?.hasConnectedPeers();

    // [FIX-RACE-TOGGLE] Capture all audio-graph node refs NOW (synchronously),
    // before any async delay. If the user reopens the mic within the 60ms flush
    // window, toggleMic() will overwrite every ref (micDestRef, micGainRef, etc.)
    // with the NEW session's nodes. Without this capture, finishTeardown would
    // then destroy the brand-new session instead of the old one — leaving the
    // user with micEnabled=true but no audio reaching peers.
    const capturedAnalyser   = analyserRef.current;
    const capturedMicDest    = micDestRef.current;
    const capturedMicGain    = micGainRef.current;
    const capturedMicComp    = micCompressorRef.current;
    const capturedMicSource  = micSourceRef.current;

    // [FIX-CLEANUP] Explicitly disconnect all mic graph nodes before closing the
    // AudioContext. Skipping this step causes memory leaks on some Android browsers
    // because the nodes hold references to the (now-closed) context's internals.
    const finishTeardown = () => {
      // [FIX-SOCKET-FALLBACK] Clear the socket chunk drain timer attached to the worklet node.
      const drainTimer = (worklet as unknown as { _drainTimer?: ReturnType<typeof setInterval> })?._drainTimer;
      if (drainTimer !== undefined) clearInterval(drainTimer);
      try { worklet?.port.close(); } catch { /* ignore */ }
      try { worklet?.disconnect(); } catch { /* ignore */ }
      if (workletNodeRef.current === worklet) workletNodeRef.current = null;
      try { capturedAnalyser?.disconnect(); } catch { /* ignore */ }
      if (analyserRef.current === capturedAnalyser) analyserRef.current = null;
      // [FIX-WEBRTC-PROCESSED-AUDIO] Explicitly remove the audio track from every
      // WebRTC sender AND stop the destination node's track. Previously the only
      // thing silencing the WebRTC side was the raw getUserMedia track ending
      // (which happened to also be the track attached to the sender); now that
      // WebRTC is fed by a separate MediaStreamDestination track, both must be
      // torn down explicitly. This also closes most of the gap where a mute
      // ("forceMuted") only stopped the local capture but never told WebRTC
      // peer connections to drop the track immediately.
      //
      // [FIX-RACE-TOGGLE] Guard: only null WebRTC stream if the mic is still OFF.
      // If the user reopened the mic before this timer fired, the new
      // setStream(micDest.stream) call in toggleMic is already active — calling
      // setStream(null) here would silence that freshly-started session.
      // [FIX-P2] void the promise — finishTeardown is a sync callback inside a
      // setTimeout; awaiting would not help since we're not in an async function.
      if (!micEnabledRef.current) {
        void webrtcManagerRef.current?.setStream(null);
      }
      capturedMicDest?.stream.getTracks().forEach(t => t.stop());
      try { capturedMicDest?.disconnect(); } catch { /* ignore */ }
      if (micDestRef.current === capturedMicDest) micDestRef.current = null;
      try { capturedMicGain?.disconnect(); } catch { /* ignore */ }
      if (micGainRef.current === capturedMicGain) micGainRef.current = null;
      try { capturedMicComp?.disconnect(); } catch { /* ignore */ }
      if (micCompressorRef.current === capturedMicComp) micCompressorRef.current = null;
      try { capturedMicSource?.disconnect(); } catch { /* ignore */ }
      if (micSourceRef.current === capturedMicSource) micSourceRef.current = null;
      // [FIX-CTX-REUSE] Do NOT close audioContextRef here — it now points to the
      // shared audioPlayerRef context which must stay alive for playback and future
      // mic toggles. Only clear the ref so toggleMic knows no mic graph is active.
      if (!micEnabledRef.current) audioContextRef.current = null;
    };

    if (worklet) {
      // [FIX-FLUSH-RACE] Previously we posted "flush" then immediately called
      // port.close()/disconnect() in the very next line, with no wait. The
      // worklet processes "flush" on the audio thread and posts its response
      // back asynchronously — closing the port right away could destroy it
      // before that final ~170ms chunk ever arrived, silently dropping the
      // last syllable of speech. Now we briefly hold a one-shot listener:
      // if the flushed chunk arrives in time, we forward it immediately
      // (the drain queue/timer is being torn down right after, so we can't
      // rely on it); otherwise we time out after 60ms and tear down anyway
      // so stopping the mic never feels sluggish.
      const prevHandler = worklet.port.onmessage;
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout>;
      const onFlushResponse = (e: MessageEvent<{ int16: Int16Array; seq: number }>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        worklet.port.onmessage = prevHandler;
        // [FIX-MULTIROOM-FLUSH] Always emit the final flush chunk via Socket.IO,
        // even when WebRTC peers are connected. The drain loop (every 83ms) was
        // already updated by [FIX-MULTIROOM] to remove the hadConnectedPeers guard
        // so non-WebRTC peers in 3+ member rooms receive audio. The flush path
        // must use the same rule — otherwise the last partial speech buffer (the
        // last syllable before the user presses mute) is silently dropped for any
        // peer on the Socket.IO fallback path whenever WebRTC peers exist.
        // Receiver-side filtering (hasConnectedPeer) correctly ignores the copy
        // for peers who already have the audio via WebRTC.
        socketRef.current?.emit("audioChunk", {
          sr: sampleRateAtStop,
          buf: e.data.int16.buffer,
          seq: e.data.seq,
        });
        finishTeardown();
      };
      worklet.port.onmessage = onFlushResponse;
      timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        worklet.port.onmessage = prevHandler;
        finishTeardown();
      }, 60);
      try {
        worklet.port.postMessage({ type: "flush" });
      } catch {
        clearTimeout(timeoutId);
        settled = true;
        finishTeardown();
      }
    } else {
      finishTeardown();
    }

    setMicEnabled(false);
    setSpeakingState(prev => ({ ...prev, [myMemberId]: 0 }));
    socketRef.current?.emit("micDisabled");
    // [FIX-MIC-PERSIST] لما المستخدم يوقف المايك يدوياً، نمسح الـ flag
    try { localStorage.removeItem(`wp_mic_${code}`); } catch { /* ignore */ }
  }, [myMemberId]);


  const toggleMic = async () => {
    if (micEnabled) { stopMic(); return; }
    const myMember = membersRef.current.find(m => m.id === myMemberId);
    if (myMember?.isMuted) return;
    // [FIX-RACE-TOGGLE-ENABLE] Reserve the "mic is on" slot synchronously BEFORE
    // any await. Without this, a rapid off→on toggle within the 60ms flush window
    // leaves micEnabledRef.current = false while async work (addModule: 50-200ms)
    // is still in flight. When finishTeardown() fires at t=60ms, it sees the ref
    // as false and calls setStream(null) — silencing the brand-new mic session
    // AFTER setStream(micDest.stream) was already called. The UI's analyser keeps
    // running (driven by the local RMS interval) so the volume bar appears active
    // for all participants, but no audio actually reaches any peer — the exact
    // symptom reported: "مؤشر الصوت شغّال بس الكل مش بيسمع".
    micEnabledRef.current = true;
    try {
      // [FIX-MIC-FALLBACK] Use the shared getMicStream() helper (3-tier constraint
      // fallback: full constraints → relaxed → audio:true). Previously this called
      // getUserMedia directly with ONE fixed constraint set, so any device/browser
      // that rejected sampleRate/sampleSize (some Android WebViews) failed entirely
      // and showed a misleading "Microphone access denied" even though the
      // permission itself was fine.
      const stream = await getMicStream();
      micStreamRef.current = stream;
      socketRef.current?.emit("micEnabled");

      // [FIX-CTX-REUSE] Reuse the shared audioPlayerRef AudioContext for mic capture
      // instead of creating a new one each time the mic is toggled.
      // Android caps simultaneous AudioContexts at ~6 — toggle 6 times and the app
      // silently breaks. We share the already-running playback context; if it's closed
      // or missing we create ONE new context and keep it alive for future toggles.
      // Note: stopMic() must NO LONGER close audioContextRef — only the room teardown
      // (component unmount) should close the shared playback context.
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      let ctx = audioPlayerRef.current;
      if (!ctx || ctx.state === "closed") {
        // NOTE: No latencyHint — keeps iOS background audio permission intact.
        ctx = new AudioCtx({ sampleRate: 48000 });
        audioPlayerRef.current = ctx;
      }
      if (ctx.state === "suspended") { try { await ctx.resume(); } catch { /* ignore */ } }
      audioContextRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      micSourceRef.current = source;

      // ── Signal chain: source → compressor → makeup gain → analyser/worklet/WebRTC ──
      // [FIX-CHAIN] OLD order was: source → gain(1.5) → compressor → analyser/worklet
      //   Problem: feeding gain BEFORE the compressor means loud transients (>-20dBFS)
      //   hit the compressor 1.5× hotter. The 3ms attack can't catch fast consonants
      //   ("p", "t", "k") → brief pre-compression clipping → distortion/clicks.
      // NEW order: source → compressor → makeup gain
      //   Compressor sees the raw mic level, tames peaks, THEN we apply gentle makeup
      //   gain to restore perceived loudness. This is the standard dynamics chain.

      // ── Dynamics compressor: tame peaks BEFORE any gain ───────────────────
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -24; // start compressing at -24 dBFS (more headroom)
      compressor.knee.value = 8;        // smooth transition into compression
      compressor.ratio.value = 4;       // 4:1 — effective for voice
      compressor.attack.value = 0.002;  // 2ms — faster, catches consonant transients
      compressor.release.value = 0.15;  // 150ms — natural decay
      micCompressorRef.current = compressor;

      // ── Makeup gain: restore loudness post-compression (subtle boost) ──────
      // Applied AFTER compression — this is safe because the compressor has
      // already tamed any peaks. 1.3× (≈ +2.3dB) is gentler than the old 1.5×.
      const micGain = ctx.createGain();
      micGain.gain.value = 1.3;
      micGainRef.current = micGain;

      // ── Analyser for RMS volume meter (post-compression, pre-gain) ──────────
      // Placed after compressor so the meter shows compressed levels —
      // more representative of what the receiver actually hears.
      // [FIX-GC] fftSize=512 is enough for time-domain RMS — we never read
      // frequency bins here. Smaller fftSize → smaller Float32Array allocation
      // → less GC pressure in the 200ms polling interval.
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyserRef.current = analyser;

      // ── Connect: source → compressor → gain → analyser ───────────────────
      source.connect(compressor);
      compressor.connect(micGain);
      micGain.connect(analyser);

      // [FIX-WEBRTC-PROCESSED-AUDIO] Feed the PROCESSED (compressor + makeup gain)
      // signal into WebRTC instead of the raw getUserMedia track. Previously
      // webrtcManagerRef.setStream(stream) was called with the raw stream — the
      // compressor/gain chain above only ever reached the volume meter and the
      // Socket.IO fallback worklet below, so on a healthy connection (WebRTC,
      // the common case) peers heard completely unprocessed audio with no AGC
      // (browser AGC is deliberately off — see getMicStream) and no replacement
      // gain control, while the WEAK-network fallback path got the nicer,
      // boosted signal. That's backwards: the common case should get the
      // processed audio, not the fallback. createMediaStreamDestination() lets
      // a Web Audio graph hand a real MediaStreamTrack to WebRTC.
      const micDest = ctx.createMediaStreamDestination();
      micGain.connect(micDest);
      micDestRef.current = micDest;

      // ── PCM capture via AudioWorklet ──────────────────────────────────────
      // Worklet runs in a dedicated audio thread — isolated from React/network.
      // The worklet posts { int16: Int16Array, seq: number, audioTime: number }.
      //
      // [FIX-WORKLET-CACHE] Only call addModule() when the context hasn't loaded
      // it yet. addModule() is idempotent on repeat calls, but the browser still
      // fires a network/cache fetch every time — adding 50-200ms of silence before
      // the worklet node can be created. Since we share one AudioContext for the
      // room lifetime (FIX-CTX-REUSE), we only need to register the module once.
      if (workletModuleLoadedForCtxRef.current !== ctx) {
        await ctx.audioWorklet.addModule("/audio-processor.js");
        workletModuleLoadedForCtxRef.current = ctx;
      }
      const workletNode = new AudioWorkletNode(ctx, "mic-processor");
      // Connect from the gain node (post-compression) so the worklet captures
      // the same signal level that the analyser and WebRTC destination see.
      micGain.connect(workletNode);

      // [FIX-4-ORDERING] Connect the worklet to the graph BEFORE awaiting
      // setStream. Previously setStream was awaited first, then the worklet was
      // connected. On iOS Safari, replaceTrack() can take 50-200ms; during that
      // window the worklet was not yet in the graph, silently dropping the first
      // 1-2 chunks (the opening consonant of the first word was lost).
      // Connecting the worklet first ensures capture starts immediately —
      // chunks are queued in socketChunkQueue and sent once the mic is live.
      // setStream is still awaited so WebRTC track replacement is confirmed
      // before we proceed, but now it runs concurrently with early capture.
      await webrtcManagerRef.current?.setStream(micDest.stream);

      // [FIX-SOCKET-FALLBACK] Socket.IO is TCP-based — under congestion it queues
      // chunks and delivers them in a burst. Receiving 5 chunks at once overwhelms
      // the jitter buffer (it resets to now+cushion for each), producing a fast burst
      // of audio followed by silence. Fix: enqueue outgoing chunks with timestamps;
      // a throttled drain loop sends ≤6/sec (server cap is 10/sec) and discards
      // chunks older than 500ms so stale audio from a TCP stall is silently dropped.
      // [FIX-AUDIOTIME-FWD] audioTime from the worklet's audio-rendering clock is
      // more accurate than Date.now() for jitter-buffer scheduling on the receiver.
      // Previously it was received here but immediately discarded — never forwarded.
      type ChunkQueueItem = { int16: Int16Array; seq: number; ts: number; audioTime?: number };
      const socketChunkQueue: ChunkQueueItem[] = [];
      // [FIX-LATENCY] Chunks are ~85ms (4096 samples at 48kHz) → ~12 chunks/sec.
      // Drain at ~12/sec (83ms interval) to keep pace with production rate.
      // Server cap is 15/sec so no chunks are dropped server-side.
      // [FIX-WEAK-NET] SOCKET_MAX_AGE_MS raised 300ms → 500ms → 800ms.
      // On genuinely weak connections (3G, congested Wi-Fi, high-latency VPN),
      // a chunk can be legitimately delayed 300-400ms in the TCP send buffer before
      // the kernel flushes it — not due to stall, just slow path RTT. At 500ms we
      // were still silently discarding valid audio on lossy mobile connections.
      // 800ms gives real-world slow links enough headroom while still dropping
      // truly stale burst backlogs from multi-second TCP stalls.
      const SOCKET_DRAIN_MS = 83; // ~12/sec — matches worklet production rate
      const SOCKET_MAX_AGE_MS = 800;
      const socketDrainTimer = setInterval(() => {
        if (!micEnabledRef.current) return;
        // [FIX-MULTIROOM] Do NOT skip Socket.IO when WebRTC peers exist.
        // In a 3+ member room, some peers may be connected via WebRTC (P2P) while
        // others are not. The old hasConnectedPeers() guard blocked Socket.IO for
        // EVERYONE as soon as ONE peer had WebRTC — meaning non-WebRTC peers went
        // permanently silent. Fix: always send via Socket.IO so the server can relay
        // to all non-WebRTC members. Peers that DO have a live WebRTC connection with
        // us will skip the Socket.IO chunk on their receiver side (hasConnectedPeer check).
        const now = Date.now();
        // Discard chunks that have been waiting too long (TCP stall backlog)
        while (socketChunkQueue.length > 0 && now - socketChunkQueue[0].ts > SOCKET_MAX_AGE_MS) {
          socketChunkQueue.shift();
        }
        const item = socketChunkQueue.shift();
        if (!item) return;
        socketRef.current?.emit("audioChunk", { sr: ctx.sampleRate, buf: item.int16.buffer, seq: item.seq, audioTime: item.audioTime });
      }, SOCKET_DRAIN_MS);
      // Attach to workletNode so stopMic can find and clear it
      (workletNode as unknown as { _drainTimer: ReturnType<typeof setInterval> })._drainTimer = socketDrainTimer;

      workletNode.port.onmessage = (e: MessageEvent<{ int16?: Int16Array; seq?: number; audioTime?: number; type?: string; threshold?: number }>) => {
        if (!micEnabledRef.current) return;
        // [FIX-5-DYNAMIC-VAD] The worklet sends a "calibrated" message once the
        // 2-second noise-floor calibration completes. Log it for debugging.
        if (e.data?.type === "calibrated") {
          if (process.env.NODE_ENV !== "production") {
            console.debug("[MicProcessor] VAD auto-calibrated threshold:", e.data.threshold?.toFixed(5));
          }
          return;
        }
        if (!e.data.int16 || e.data.seq === undefined) return;
        // [FIX-MULTIROOM] Always push to queue so Socket.IO reaches non-WebRTC peers.
        // WebRTC peers who have a live P2P connection to us will ignore our Socket.IO
        // chunks on their side (hasConnectedPeer check in audioChunk handler).
        // Push to queue; drain loop handles rate-limiting and age-based discard.
        // [FIX-AUDIOTIME-FWD] Forward audioTime so the receiver can use the
        // worklet's precise audio-rendering clock for jitter-buffer scheduling.
        socketChunkQueue.push({ int16: e.data.int16, seq: e.data.seq, ts: Date.now(), audioTime: e.data.audioTime });
      };
      workletNodeRef.current = workletNode;

      setMicEnabled(true);
      setMicError(null);
      // [FIX-MIC-PERSIST] نحفظ إن المايك كان شغّال عشان لو الصفحة اترفرشت
      // نرجعه تلقائياً بدون ما المستخدم يعمل حاجة.
      try { localStorage.setItem(`wp_mic_${code}`, "1"); } catch { /* ignore */ }

      // ── RMS volume detection — more accurate than FFT byte average ──────────
      // [FIX-SPEAKING-RATE] Was 100ms (10 events/sec) but the server rate-limits
      // "speaking" to 5/sec — half of every update was silently dropped, making
      // the speaking/volume indicator less smooth than intended. 200ms (5/sec)
      // now matches the server limit exactly.
      // [FIX-GC] Allocate the time-domain buffer ONCE outside the interval callback.
      // Previously `new Float32Array(fftSize)` ran 5× per second, generating GC
      // pressure proportional to fftSize. With fftSize=512, the buffer is 512×4=2KB
      // allocated once and reused for the room lifetime.
      const rmsBuffer = new Float32Array(analyser.fftSize);
      micIntervalRef.current = setInterval(() => {
        const an = analyserRef.current;
        if (!an) return;
        an.getFloatTimeDomainData(rmsBuffer);
        let sumSq = 0;
        for (let i = 0; i < rmsBuffer.length; i++) sumSq += rmsBuffer[i] * rmsBuffer[i];
        const rms = Math.sqrt(sumSq / rmsBuffer.length);
        const vol = Math.min(100, Math.round(rms * 400));
        socketRef.current?.emit("speaking", { volume: vol });
        setSpeakingState(prev => ({ ...prev, [myMemberId]: vol }));
      }, 200);
    } catch {
      // [FIX-REF-RESET] Reset micEnabledRef synchronously before any cleanup so
      // all guards below evaluate correctly. micEnabledRef.current was set to true
      // at the top of toggleMic() as a pre-async reservation (FIX-RACE-TOGGLE-ENABLE).
      // If any await in the try block throws, we never reach setMicEnabled(true),
      // so the ref must return to false to match the React state. Without this reset:
      //   • setStream(null) is guarded by `!micEnabledRef.current` → evaluates false
      //     → SKIPPED → WebRTC peers keep streaming from the now-dead micDest track
      //     (tracks stopped below, but senders still attached) until the next
      //     successful mic enable. Every connected peer receives dead/silent audio.
      //   • audioContextRef guard also evaluates false → skipped (safe but misleading).
      micEnabledRef.current = false;
      // [FIX-CATCH-CLEANUP] Clean up any audio graph nodes that were already set
      // up before the failure. Previously, if addModule() threw (e.g. worklet file
      // not served, network blip), WebRTC was already sending audio via the
      // micDest stream (setStream was called before addModule), the audio graph
      // nodes were live, and micStreamRef still held the getUserMedia track — all
      // leaking silently while micEnabled stayed false. Now we explicitly tear
      // everything down so the next toggle starts from a clean state.
      micStreamRef.current?.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
      // [FIX-P2] void the promise — catch block is sync-style cleanup, awaiting
      // here would delay the error feedback. setStream is async but the track switch
      // failure is not critical during teardown.
      if (!micEnabledRef.current) void webrtcManagerRef.current?.setStream(null);
      micDestRef.current?.stream.getTracks().forEach(t => t.stop());
      try { micDestRef.current?.disconnect(); } catch { /* ignore */ }
      micDestRef.current = null;
      try { micGainRef.current?.disconnect(); } catch { /* ignore */ }
      micGainRef.current = null;
      try { micCompressorRef.current?.disconnect(); } catch { /* ignore */ }
      micCompressorRef.current = null;
      try { micSourceRef.current?.disconnect(); } catch { /* ignore */ }
      micSourceRef.current = null;
      try { analyserRef.current?.disconnect(); } catch { /* ignore */ }
      analyserRef.current = null;
      if (!micEnabledRef.current) audioContextRef.current = null;
      setMicError("Microphone access denied");
    }
  };

  // FIX-RESTART: استخدام ref بدل الـ function مباشرة عشان نتجنب stale closure.
  // كان الكود القديم بيمسك نسخة قديمة من toggleMic (من أول render) فكان restart
  // بيشغّل الميك حتى لو كان شغّال بالفعل، أو بيفشل بصمت.
  const toggleMicRef = useRef(toggleMic);
  useEffect(() => { toggleMicRef.current = toggleMic; });

  // Auto-restart mic after returning from iOS background
  useEffect(() => {
    const handler = () => { toggleMicRef.current(); };
    document.addEventListener("wp:restartMic", handler);
    return () => document.removeEventListener("wp:restartMic", handler);
  }, []);

  // [FIX-MIC-PERSIST] لو المستخدم كان المايك شغّال وعمل refresh أو رجع للصفحة،
  // نشغّل المايك تلقائياً بعد ما يكون join الغرفة (بعد 1.5 ثانية عشان يتأكد
  // إن الـ socket جاهز والـ session اتأكدت).
  useEffect(() => {
    if (!myMemberId) return;
    try {
      const wasOn = localStorage.getItem(`wp_mic_${code}`);
      if (wasOn === "1") {
        setTimeout(() => {
          if (!micEnabledRef.current) {
            document.dispatchEvent(new CustomEvent("wp:restartMic"));
          }
        }, 1500);
      }
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myMemberId]);

  const cancelUpload = () => {
    if (uploadXhrRef.current) { uploadXhrRef.current.abort(); uploadXhrRef.current = null; }
    setUploadProgress(null);
    setUploadSpeed(null);
    setUploadRemaining(null);
    isUploadingRef.current = false;
    socketRef.current?.emit("uploadEnded");
  };

  const handleUpload = async (file: File) => {
    if (!isPrivileged || !file) return;
    if (uploadProgress !== null) return;
    isUploadingRef.current = true;
    socketRef.current?.emit("uploadStarted");
    const formData = new FormData();
    formData.append("video", file);
    setUploadProgress(0);
    setUploadSpeed(null);
    setUploadRemaining(null);
    uploadStartRef.current = Date.now();
    uploadFileSize.current = file.size;
    const xhr = new XMLHttpRequest();
    uploadXhrRef.current = xhr;
    xhr.open("POST", `/api/rooms/${code}/video`);
    xhr.setRequestHeader("x-session-token", sessionToken);
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      setUploadProgress(Math.round((e.loaded / e.total) * 50));
      const elapsed = (Date.now() - uploadStartRef.current) / 1000;
      if (elapsed > 0.5) {
        const speedBps = e.loaded / elapsed;
        setUploadSpeed(speedBps);
        setUploadRemaining((e.total - e.loaded) / speedBps);
      }
    };
    xhr.onload = () => {
      uploadXhrRef.current = null;
      setUploadSpeed(null);
      setUploadRemaining(null);
      // Fallback for iOS: socket may have missed the videoReady event while the page
      // was backgrounded during upload/encoding. Poll videoStatus every 3s for up to
      // 90s so the UI unblocks even without receiving the socket event.
      let pollAttempts = 0;
      const pollForReady = () => {
        pollAttempts++;
        refetchVideoStatus();
        if (pollAttempts < 30) setTimeout(pollForReady, 3000);
      };
      setTimeout(pollForReady, 2000);
    };
    xhr.onerror = () => { uploadXhrRef.current = null; setUploadProgress(null); setUploadSpeed(null); setUploadRemaining(null); isUploadingRef.current = false; socketRef.current?.emit("uploadEnded"); };
    xhr.onabort = () => { uploadXhrRef.current = null; };
    xhr.send(formData);
  };

  const startBrowserSession = async () => {
    setStartingBrowser(true);
    try {
      const res = await fetch(`/api/rooms/${code}/hyperbeam`, {
        method: "POST",
        headers: { "x-session-token": sessionToken },
      });
      const data = await res.json() as { embedUrl?: string; adminToken?: string; error?: string };
      if (!res.ok) { console.error("Failed to start browser session:", data.error); return; }
      setHyperbeamEmbed(data.embedUrl ?? null);
      setHyperbeamAdminToken(data.adminToken ?? null);
      socketRef.current?.emit("hyperbeamReady", { embedUrl: data.embedUrl });
    } catch (e) { console.error("Failed to start browser session", e); }
    finally { setStartingBrowser(false); }
  };

  const terminateBrowserSession = () => {
    // FIX-RECONNECT: أبعت الـ socket event أولاً قبل أي state changes —
    // تدمير الـ Hyperbeam component بيسبب re-render ثقيل قد يقاطع الـ socket،
    // فلازم الـ server يعرف بالإنهاء قبل ما يحصل أي disconnect.
    socketRef.current?.emit("hyperbeamEnded");

    // Fire-and-forget: tell server to clean up Hyperbeam session in background
    fetch(`/api/rooms/${code}/hyperbeam`, {
      method: "DELETE",
      headers: { "x-session-token": sessionToken },
    }).catch(() => {});

    // FIX-FULLSCREEN: اخرج من fullscreen بعد ما بعثنا الـ socket event
    if (isBrowserFullscreenRef.current) {
      if (isIOSDevice) {
        setIsBrowserFullscreen(false);
        isBrowserFullscreenRef.current = false;
        if (iosFullscreenTimerRef.current) clearTimeout(iosFullscreenTimerRef.current);
      } else if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else {
        setIsBrowserFullscreen(false);
        isBrowserFullscreenRef.current = false;
      }
      setBrowserWidened(false);
    }

    // Clear UI state آخر حاجة — بعد Socket و API
    setHyperbeamEmbed(null);
    setHyperbeamAdminToken(null);
  };

  const copyCode = () => {
    navigator.clipboard.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  // MOD #6: invite link now points to /invite/:code + shows copy feedback
  const copyInviteLink = () => {
    navigator.clipboard.writeText(`${window.location.origin}/invite/${code}`).catch(() => {});
    setCopiedInvite(true);
    setTimeout(() => setCopiedInvite(false), 2000);
  };

  const handleCineNavigate = useCallback((next: CineState) => {
    if (!isPrivileged) return;
    const prev = cineStateRef.current;
    setCineState(next);
    const s = socketRef.current;
    if (!s) return;
    // Only ONE socket event per navigation to avoid conflicting updates on guests
    if (next.selectedItem?.id !== prev.selectedItem?.id) {
      setCineDirectUrl("");
      setCineSubtitleUrl("");
      s.emit("moviesSelect", { item: next.selectedItem });
    } else if (next.season !== prev.season) {
      setCineDirectUrl("");
      setCineSubtitleUrl("");
      s.emit("moviesSeason", { season: next.season });
    } else if (next.episode !== prev.episode) {
      setCineDirectUrl("");
      setCineSubtitleUrl("");
      s.emit("moviesEpisode", { episode: next.episode });
    } else if (next.contentType !== prev.contentType || next.category !== prev.category) {
      s.emit("moviesFilter", { type: next.contentType, category: next.category });
    } else if (next.searchQuery !== prev.searchQuery) {
      if (next.searchQuery) s.emit("moviesSearch", { query: next.searchQuery });
      else s.emit("moviesFilter", { type: next.contentType, category: next.category });
    }
  }, [isPrivileged]);

  const handleCineDirectUrlChange = useCallback((url: string) => {
    if (!isPrivileged) return;
    setCineDirectUrl(url);
    setCineSubtitleUrl("");
    socketRef.current?.emit("moviesDirectUrl", { directUrl: url, subtitleUrl: "" });
  }, [isPrivileged]);

  const handleCineSubtitleChange = useCallback((url: string) => {
    if (!isPrivileged) return;
    setCineSubtitleUrl(url);
    socketRef.current?.emit("moviesDirectUrl", { directUrl: cineDirectUrl, subtitleUrl: url });
  }, [isPrivileged, cineDirectUrl]);

  const changeMode = (newMode: "video" | "browser" | "screenshare" | "movies") => {
    if (newMode !== "screenshare" && screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(t => t.stop());
      screenStreamRef.current = null;
      webrtcManagerRef.current?.stopScreenShare();
      setIsScreenSharing(false);
      socketRef.current?.emit("screenShareStopped");
    }
    if (newMode === "movies") { setCineState(DEFAULT_CINE_STATE); setCineDirectUrl(""); setCineSubtitleUrl(""); }
    setMode(newMode);
    socketRef.current?.emit("changeMode", { mode: newMode });
  };

  const kickMember = (memberId: number) => socketRef.current?.emit("kickMember", { memberId });
  const banMember = (memberId: number) => socketRef.current?.emit("banMember", { memberId });
  const muteMember = (memberId: number, isMuted: boolean) => socketRef.current?.emit("muteMember", { memberId, isMuted });
  const promoteMember = (memberId: number, role: string) => socketRef.current?.emit("promoteMember", { memberId, role });
  const approveJoin = (memberId: number) => {
    socketRef.current?.emit("approveJoin", { memberId });
    setJoinRequests(prev => prev.filter(r => r.memberId !== memberId));
  };
  const rejectJoin = (memberId: number) => {
    socketRef.current?.emit("rejectJoin", { memberId });
    setJoinRequests(prev => prev.filter(r => r.memberId !== memberId));
  };

  const sendChatMessage = () => {
    const msg = chatInput.trim();
    if (!msg) return;
    // Fix: client-side length guard (السيرفر بيتحقق كمان لكن ده defense-in-depth)
    if (msg.length > 500) return;
    socketRef.current?.emit("chatMessage", {
      message: msg,
      ...(replyingTo ? { replyTo: { memberId: replyingTo.memberId, name: replyingTo.name, message: replyingTo.message } } : {}),
    });
    setChatInput("");
    setReplyingTo(null);
  };

  const REACTION_EMOJIS = ["❤️", "😂", "👍", "😮", "😢", "🔥"];
  const toggleReaction = (messageId: string, emoji: string) => {
    socketRef.current?.emit("reactToMessage", { messageId, emoji });
    setReactionPickerFor(null);
  };

  const sendStickerMessage = (sticker: string) => {
    setShowStickerPanel(false);
    socketRef.current?.emit("chatMessage", {
      message: `__sticker__${sticker}`,
      ...(replyingTo ? { replyTo: { memberId: replyingTo.memberId, name: replyingTo.name, message: replyingTo.message } } : {}),
    });
    setReplyingTo(null);
  };

  const sendImageMessage = (file: File) => {
    const MAX_DIM = 600;
    const MAX_BYTES = 750000; // ~600KB base64 budget
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement("canvas");
      let { width, height } = img;
      if (width > MAX_DIM || height > MAX_DIM) {
        const ratio = Math.min(MAX_DIM / width, MAX_DIM / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d")!.drawImage(img, 0, 0, width, height);
      // Try progressively lower quality until under budget
      let quality = 0.85;
      let dataUrl = canvas.toDataURL("image/jpeg", quality);
      while (dataUrl.length > MAX_BYTES && quality > 0.3) {
        quality -= 0.1;
        dataUrl = canvas.toDataURL("image/jpeg", quality);
      }
      if (dataUrl.length > MAX_BYTES) return; // still too large — abort
      socketRef.current?.emit("chatMessage", {
        message: "",
        imageData: dataUrl,
        ...(replyingTo ? { replyTo: { memberId: replyingTo.memberId, name: replyingTo.name, message: replyingTo.message } } : {}),
      });
      setReplyingTo(null);
    };
    img.src = url;
  };

  // ─── Screen Share functions ────────────────────────────────────────
  // Initialise WebRTCManager once on mount
  useEffect(() => {
    const manager = new WebRTCManager(
      (targetMemberId, signal) => {
        socketRef.current?.emit("webrtcSignal", { targetMemberId, signal });
      },
      (_memberId, stream) => {
        if (stream) {
          setRemoteScreenStream(stream);
        } else {
          setRemoteScreenStream(null);
          setMode("video");
        }
      },
    );
    webrtcManagerRef.current = manager;
    return () => {
      manager.destroy();
      webrtcManagerRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Attach the correct stream to the screen video element
  useEffect(() => {
    const el = screenVideoRef.current;
    if (!el) return;

    // Ensure iOS-required attributes are always present
    el.setAttribute("playsinline", "");
    el.setAttribute("webkit-playsinline", "");
    el.muted = true;

    const tryPlay = () => {
      el.play().then(() => {
        setIosNeedsTap(false);
      }).catch(() => {
        // iOS blocks autoplay on WebRTC srcObject — show tap-to-play overlay
        if (isIOSDevice) setIosNeedsTap(true);
      });
    };

    if (isScreenSharing && screenStreamRef.current) {
      // Host: attach local capture stream (muted in the element to avoid echo)
      el.srcObject = screenStreamRef.current;
      tryPlay();
    } else if (remoteScreenStream) {
      // Guest: attach incoming WebRTC stream
      // On iOS, setting srcObject on a new stream requires a short tick first
      setIosNeedsTap(false);
      el.srcObject = null;
      requestAnimationFrame(() => {
        el.srcObject = remoteScreenStream;
        tryPlay();
      });
    } else {
      el.srcObject = null;
      setIosNeedsTap(false);
    }
  }, [isScreenSharing, remoteScreenStream, mode, isIOSDevice]);

  // iOS: after attaching a remote stream, poll for actual video frames.
  // play() resolves even when the WebRTC track is muted (delivers no frames),
  // leaving the screen black. We check both videoWidth AND readyState to
  // detect this case, then force a full re-attach to reset Safari's decoder.
  useEffect(() => {
    if (!isIOSDevice || !remoteScreenStream || isScreenSharing) return;
    const el = screenVideoRef.current;
    if (!el) return;

    const isReceivingFrames = (v: HTMLVideoElement) =>
      v.videoWidth > 0 && v.readyState >= 2;

    const reattach = () => {
      const v = screenVideoRef.current;
      if (!v || v.srcObject !== remoteScreenStream) return;
      if (isReceivingFrames(v)) return; // frames are arriving — nothing to do
      v.srcObject = null;
      requestAnimationFrame(() => {
        if (!screenVideoRef.current) return;
        screenVideoRef.current.srcObject = remoteScreenStream;
        screenVideoRef.current.load();
        screenVideoRef.current.play().catch(() => setIosNeedsTap(true));
      });
    };

    // Check at 800 ms, 2 s, 4 s, 8 s, and 15 s after the stream is attached
    const t1 = setTimeout(reattach, 800);
    const t2 = setTimeout(reattach, 2000);
    const t3 = setTimeout(reattach, 4000);
    const t4 = setTimeout(reattach, 8000);
    const t5 = setTimeout(reattach, 15000);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearTimeout(t4); clearTimeout(t5); };
  }, [remoteScreenStream, isScreenSharing, isIOSDevice]);

  const startScreenShare = useCallback(async () => {
    setScreenShareError(null);

    // ── Desktop/Android: use getDisplayMedia ─────────────────────────────────
    const supportsDisplayMedia =
      typeof navigator.mediaDevices?.getDisplayMedia === "function";
    if (!supportsDisplayMedia) {
      setScreenShareError(
        "Screen sharing is not supported in this browser. Please use Chrome, Firefox, Edge, or Safari 15.4+.",
      );
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 2560, max: 3840 },
          height: { ideal: 1440, max: 2160 },
          frameRate: { ideal: 30, max: 60 },
          // @ts-expect-error — non-standard but supported in Chrome/Edge for text sharpness
          cursor: "always",
          displaySurface: "monitor",
        },
        // Request system audio — browser will offer a checkbox to the user.
        // Gracefully ignored on platforms that don't support it (Android, Firefox, Safari).
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: 48000,
        },
        // Prevent Chrome from offering the current tab as a capture option,
        // which avoids the camera Permissions-Policy violation warning.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        selfBrowserSurface: "exclude" as any,
      });

      screenStreamRef.current = stream;
      setIsScreenSharing(true);

      if (webrtcManagerRef.current) {
        await webrtcManagerRef.current.startScreenShare(stream);
      }

      socketRef.current?.emit("screenShareStarted");
      changeMode("screenshare");

      // Handle when user stops via browser's native "Stop sharing" button
      const track = stream.getVideoTracks()[0];
      if (track) {
        track.onended = () => { stopScreenShare(); };
      }
    } catch (err) {
      if (err instanceof Error && err.name !== "NotAllowedError") {
        setScreenShareError("Could not start screen share. Please try again.");
      }
      // NotAllowedError = user cancelled — silently ignore
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPrivileged]);

  const stopScreenShare = useCallback(() => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(t => t.stop());
      screenStreamRef.current = null;
    }
    webrtcManagerRef.current?.stopScreenShare();
    setIsScreenSharing(false);
    socketRef.current?.emit("screenShareStopped");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getRoleBadge = (role: string) => {
    if (role === "host") return <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-yellow-500/15 text-yellow-400 font-medium"><Crown className="w-3 h-3" />Host</span>;
    if (role === "admin") return <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-400 font-medium"><Shield className="w-3 h-3" />Admin</span>;
    return <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400 font-medium"><User className="w-3 h-3" />Guest</span>;
  };

  const getRoleRing = (role: string) => {
    if (role === "host") return "ring-2 ring-yellow-500";
    if (role === "admin") return "ring-2 ring-purple-500";
    return "ring-2 ring-blue-500";
  };

  // ── Network Quality Helpers ──────────────────────────────────────────────
  // يرجع ألوان زرار المايك وأيقونة المؤشر بناءً على جودة الشبكة
  const getNetworkQualityMicClass = (quality: NetworkQuality) => {
    if (quality === "poor")
      return "bg-red-500/10 border-red-500/40 text-red-400 shadow-[0_0_10px_rgba(239,68,68,0.3)]";
    if (quality === "fair")
      return "bg-yellow-500/10 border-yellow-500/40 text-yellow-400 shadow-[0_0_10px_rgba(234,179,8,0.3)]";
    // good أو none → أخضر (الأصلي)
    return "bg-green-500/10 border-green-500/30 text-green-400 shadow-[0_0_10px_rgba(34,197,94,0.3)]";
  };

  const getNetworkQualityBarClass = (quality: NetworkQuality) => {
    if (quality === "poor") return "bg-red-400";
    if (quality === "fair") return "bg-yellow-400";
    return "bg-green-400";
  };

  const getNetworkQualityDotClass = (quality: NetworkQuality) => {
    if (quality === "poor") return "bg-red-500";
    if (quality === "fair") return "bg-yellow-400";
    return "bg-green-500";
  };

  const getNetworkQualityLabel = (quality: NetworkQuality) => {
    if (quality === "poor") return "إشارة ضعيفة";
    if (quality === "fair") return "إشارة متوسطة";
    if (quality === "good") return "إشارة ممتازة";
    return "Mic On";
  };

  const getRoleCardBorder = (role: string) => {
    if (role === "host") return "border border-yellow-500/40";
    if (role === "admin") return "border border-purple-500/40";
    return "border border-blue-500/25";
  };

  const progressPercent = duration > 0 ? (currentTime / duration) * 1000 : 0;
  const roleOrder: Record<string, number> = { host: 0, admin: 1, guest: 2 };
  const onlineMembers = members
    .filter(m => m.isOnline)
    .sort((a, b) => (roleOrder[a.role] ?? 3) - (roleOrder[b.role] ?? 3));
  const onlineCount = onlineMembers.length;
  // Show unread count on the panel button whenever panel is closed OR user is not on chat tab.
  // This ensures silent (muted) messages still show a badge on the Users button.
  const panelBadge = joinRequests.length + (!panelOpen || activeTab !== "chat" ? unreadCount : 0);

  if (kicked) return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="text-center"><WifiOff className="w-12 h-12 text-destructive mx-auto mb-4" /><h2 className="text-xl font-bold">You were removed</h2><p className="text-muted-foreground mt-2">Redirecting...</p></div>
    </div>
  );
  if (banned) return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="text-center"><Ban className="w-12 h-12 text-destructive mx-auto mb-4" /><h2 className="text-xl font-bold">You have been banned</h2><p className="text-muted-foreground mt-2">Redirecting...</p></div>
    </div>
  );
  if (joinRejected) return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="text-center p-6">
        <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mx-auto mb-4"><Ban className="w-8 h-8 text-destructive" /></div>
        <h2 className="text-xl font-bold mb-2">Entry Denied</h2>
        <p className="text-muted-foreground text-sm mb-4">The host rejected your request</p>
        <button onClick={() => setLocation("/")} className="px-4 py-2 bg-primary text-white rounded-lg text-sm">Back to Home</button>
      </div>
    </div>
  );
  if (pendingApproval) return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="text-center p-6">
        <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4"><Loader2 className="w-8 h-8 text-primary animate-spin" /></div>
        <h2 className="text-xl font-bold mb-2">Waiting for Approval</h2>
        <p className="text-muted-foreground text-sm">The host needs to approve your re-entry</p>
      </div>
    </div>
  );

  const safeOpenImage = (url: string | undefined) => {
    // Fix: قبول data:image/ فقط — http:// ممكن يُستخدم لـ open-redirect / tracking
    // https:// مقبولة للصور الخارجية الموثوقة
    if (!url) return;
    if (url.startsWith("data:image/") || url.startsWith("https://")) {
      window.open(url);
    }
  };

  return (
    <>
    {/* ── Welcome screen ──────────────────────────────────────────────────── */}
    {showWelcome && (
      <div style={{
        position: "fixed", inset: 0, zIndex: 99998,
        display: "flex", alignItems: "flex-end", justifyContent: "center",
        paddingBottom: 48,
        pointerEvents: "none",
      }}>
        <style>{`
          @keyframes wlc-up   { from { opacity:0; transform:translateY(24px) scale(0.95); } to { opacity:1; transform:translateY(0) scale(1); } }
          @keyframes wlc-drain { from { width:100%; } to { width:0%; } }
        `}</style>
        <div style={{
          background: "rgba(18,12,30,0.96)",
          backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)",
          border: "1px solid rgba(168,85,247,0.25)",
          borderRadius: 20,
          padding: "20px 28px 16px",
          minWidth: 260, maxWidth: 320, width: "88%",
          boxShadow: "0 8px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(168,85,247,0.08)",
          display: "flex", flexDirection: "column" as const, gap: 0,
          opacity: welcomeLeaving ? 0 : 1,
          transform: welcomeLeaving ? "translateY(12px) scale(0.97)" : "translateY(0) scale(1)",
          transition: "opacity 0.5s ease, transform 0.5s ease",
          animation: "wlc-up 0.45s cubic-bezier(0.34,1.56,0.64,1) forwards",
        }}>
          {/* Top row: icon + texts */}
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14 }}>
            <div style={{
              width: 44, height: 44, borderRadius: 13, flexShrink: 0,
              background: "rgba(168,85,247,0.15)",
              border: "1px solid rgba(168,85,247,0.25)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              {myRole === "host"
                ? <Crown style={{ width: 22, height: 22, color: "#c084fc" }} />
                : <Film  style={{ width: 22, height: 22, color: "#a78bfa" }} />}
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#f0ebff", lineHeight: 1.3 }}>
                {myRole === "host" ? "Room Created, " : "Welcome, "}
                <span style={{
                  background: "linear-gradient(90deg,#c084fc,#818cf8)",
                  WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
                }}>{myName}</span>
              </div>
              <div style={{ fontSize: 12, color: "rgba(196,181,253,0.45)", marginTop: 2 }}>
                {roomData?.name ?? code}
              </div>
            </div>
          </div>
          {/* Progress bar */}
          <div style={{ height: 2, background: "rgba(168,85,247,0.12)", borderRadius: 2, overflow: "hidden" }}>
            <div style={{
              height: "100%", borderRadius: 2,
              background: "linear-gradient(90deg,#a855f7,#6366f1)",
              animation: "wlc-drain 3.4s linear forwards",
            }} />
          </div>
        </div>
      </div>
    )}

    {/* ── Floating notification toast ──────────────────────────────────────
         Appears near the panel button when a chat message or member join
         arrives while the panel is closed. Tap to open the relevant tab.   */}
    {chatToast && (
      <div
        className="fixed z-[100000] flex items-start gap-3 w-[260px] sm:w-[300px] bg-background/98 border border-border rounded-2xl px-3 py-3 shadow-2xl cursor-pointer select-none"
        style={{
          top: headerH > 0 ? headerH : 60, right: 12,
          backdropFilter: "blur(16px)",
          animation: toastSwipe.x === 0 && toastSwipe.y === 0 ? "toast-slide-in 0.25s cubic-bezier(0.34,1.56,0.64,1)" : undefined,
          transform: `translate(${toastSwipe.x}px, ${toastSwipe.y}px)`,
          opacity: 1 - Math.max(Math.abs(toastSwipe.x) / 160, Math.abs(toastSwipe.y) / 120),
          transition: toastSwipe.x === 0 && toastSwipe.y === 0 ? "transform 0.25s ease, opacity 0.25s ease" : "none",
        }}
        onClick={() => {
          if (Math.abs(toastSwipe.x) > 5 || Math.abs(toastSwipe.y) > 5) return; // was a swipe not a tap
          if (chatToastTimerRef.current) clearTimeout(chatToastTimerRef.current);
          setChatToast(null);
          setToastSwipe({ x: 0, y: 0 });
          // joinApproved / joinRejected هما إشعارات معلوماتية فقط — مش بيفتحوا بانيل
          if (chatToast.tab === "joinApproved" || chatToast.tab === "joinRejected") return;
          // joinRequest بيفتح تاب الأعضاء عشان الهوست يقبل الطلب
          setPanelOpen(true);
          setActiveTab(chatToast.tab === "joinRequest" ? "members" : chatToast.tab as "chat" | "members" | "bans");
        }}
        onTouchStart={e => {
          toastTouchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }}
        onTouchMove={e => {
          const dx = e.touches[0].clientX - toastTouchRef.current.x;
          const dy = e.touches[0].clientY - toastTouchRef.current.y;
          setToastSwipe({ x: dx, y: dy });
        }}
        onTouchEnd={() => {
          const { x, y } = toastSwipe;
          if (Math.abs(x) > 80 || Math.abs(y) > 60) {
            if (chatToastTimerRef.current) clearTimeout(chatToastTimerRef.current);
            setChatToast(null);
          }
          setToastSwipe({ x: 0, y: 0 });
        }}
      >
        <style>{`@keyframes toast-slide-in { from { opacity:0; transform:translateY(-10px) scale(0.92); } to { opacity:1; transform:translateY(0) scale(1); } }`}</style>
        <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
          chatToast.tab === "chat"        ? "bg-primary/15"        :
          chatToast.tab === "joinApproved" ? "bg-emerald-500/15"   :
          chatToast.tab === "joinRejected" ? "bg-red-500/15"       :
          chatToast.tab === "joinRequest"  ? "bg-amber-500/15"     :
          "bg-emerald-500/15"
        }`}>
          {chatToast.tab === "chat"         ? <MessageSquare className="w-5 h-5 text-primary" />            :
           chatToast.tab === "joinApproved" ? <Check          className="w-5 h-5 text-emerald-500" />       :
           chatToast.tab === "joinRejected" ? <X              className="w-5 h-5 text-red-500" />            :
           chatToast.tab === "joinRequest"  ? <UserCheck      className="w-5 h-5 text-amber-500" />         :
           <Users className="w-5 h-5 text-emerald-500" />}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-base font-bold text-foreground truncate leading-tight">{chatToast.name}</p>
          <p className="text-base text-muted-foreground truncate mt-0.5 leading-snug">{chatToast.text}</p>
          {/* أزرار قبول/رفض مباشرة على الإشعار لطلبات الدخول */}
          {chatToast.tab === "joinRequest" && chatToast.memberId != null && isPrivileged && (
            <div className="flex gap-2 mt-2" onClick={e => e.stopPropagation()}>
              <button
                className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 text-sm font-semibold hover:bg-emerald-500/35 active:scale-95 transition-all"
                onClick={e => {
                  e.stopPropagation();
                  approveJoin(chatToast.memberId!);
                  if (chatToastTimerRef.current) clearTimeout(chatToastTimerRef.current);
                  setChatToast(null);
                }}
              >
                <Check className="w-3.5 h-3.5" /> قبول
              </button>
              <button
                className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg bg-red-500/20 border border-red-500/40 text-red-400 text-sm font-semibold hover:bg-red-500/35 active:scale-95 transition-all"
                onClick={e => {
                  e.stopPropagation();
                  rejectJoin(chatToast.memberId!);
                  if (chatToastTimerRef.current) clearTimeout(chatToastTimerRef.current);
                  setChatToast(null);
                }}
              >
                <X className="w-3.5 h-3.5" /> رفض
              </button>
            </div>
          )}
        </div>
        <button
          className="shrink-0 text-muted-foreground hover:text-foreground -mt-0.5 ml-1 p-1 rounded-full hover:bg-muted transition-colors"
          onClick={e => {
            e.stopPropagation();
            if (chatToastTimerRef.current) clearTimeout(chatToastTimerRef.current);
            setChatToast(null);
            setToastSwipe({ x: 0, y: 0 });
          }}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    )}

    {/* iOS Screen Share fullscreen overlay — نفس نهج Hyperbeam بالظبط */}
    {isSSIOSFullscreen && isIOSDevice && mode === "screenshare" && (
      <div
        className="fixed inset-0 z-[99999] bg-black"
        onTouchStart={showSSIOSControls}
        onMouseMove={showSSIOSControls}
      >
        {/* فيديو مستقل يشارك نفس الـ stream مع الفيديو الأصلي */}
        <video
          ref={screenVideoIOSRef}
          autoPlay
          playsInline
          muted
          controls={false}
          disablePictureInPicture
          {...{ "webkit-playsinline": "true", "x-webkit-airplay": "deny", "disableremoteplayback": "" } as Record<string, string>}
          className="w-full h-full object-contain"
          style={{ pointerEvents: "none" }}
        />
        {/* Controls — تظهر عند اللمس وتختفي بعد 3 ثواني */}
        <div className={`absolute inset-0 pointer-events-none transition-opacity duration-300 ${ssIOSControlsVisible ? "opacity-100" : "opacity-0"}`}>
          <button
            onClick={closeSSIOSFullscreen}
            className="absolute bottom-10 right-5 w-12 h-12 rounded-full bg-black/60 backdrop-blur-md border border-white/20 flex items-center justify-center pointer-events-auto active:scale-90 transition-all"
          >
            <Minimize className="w-5 h-5 text-white" />
          </button>
        </div>
      </div>
    )}

    {/* iOS full browser fullscreen overlay */}
    {isBrowserFullscreen && isIOSDevice && mode === "browser" && hyperbeamEmbed && (
      <div
        className="fixed inset-0 z-[99999] bg-black overflow-hidden"
        onTouchStart={showIOSFullscreenControls}
        onMouseMove={showIOSFullscreenControls}
      >
        <div
          ref={hbIOSContainerRef}
          style={{
            border: "none",
            display: "block",
            pointerEvents: isPrivileged ? "auto" : "none",
            width: "100%",
            height: "100%",
          }}
        />
        <div
          className={`absolute inset-0 pointer-events-none transition-opacity duration-300 ${iosFullscreenControlsVisible ? "opacity-100" : "opacity-0"}`}
        >
          {/* Widen button — mobile landscape fullscreen only */}
          {isMobileDevice && isLandscape && (
            <button
              onClick={() => setBrowserWidened(w => !w)}
              className="absolute bottom-10 right-20 w-12 h-12 rounded-full bg-black/60 backdrop-blur-md border border-white/20 flex items-center justify-center pointer-events-auto active:scale-90 transition-all"
              title={browserWidened ? "Reset width" : "Widen to full screen"}
            >
              <span className="flex items-center gap-0.5">
                <ArrowLeft className="w-4 h-4 text-white" />
                <ArrowRight className="w-4 h-4 text-white" />
              </span>
            </button>
          )}
          <button
            onClick={handleBrowserFullscreen}
            className="absolute bottom-10 right-5 w-12 h-12 rounded-full bg-black/60 backdrop-blur-md border border-white/20 flex items-center justify-center pointer-events-auto active:scale-90 transition-all"
          >
            <Minimize className="w-5 h-5 text-white" />
          </button>
        </div>
      </div>
    )}
    <div className="bg-background flex flex-col overflow-hidden" style={{ height: "100%" }}>
      {/* Top bar — 2-row layout */}
      <div ref={headerRef} className="border-b border-border bg-card/50 backdrop-blur-sm flex-shrink-0" style={{ paddingTop: "env(safe-area-inset-top)" }}>
        {/* Row 1: room name + lock (left) | mode switcher (right, desktop only) */}
        <div className="flex items-center gap-2.5 px-3 pt-3.5 pb-2">
          {/* Left: icon + room name + lock */}
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <Film className="w-5 h-5 text-primary flex-shrink-0" />
            <span className="font-bold text-foreground text-base truncate max-w-[110px] sm:max-w-none">{roomData?.name ?? code}</span>
            {!isConnected && <WifiOff className="w-4 h-4 text-destructive flex-shrink-0" />}
            {myRole === "host" && (
              <div className="flex items-center gap-1.5 flex-shrink-0">
                {/* Close Room — slightly bigger */}
                <button
                  onClick={() => { if (confirm("Close the room for everyone?")) socketRef.current?.emit("closeRoom"); }}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-full border text-sm font-semibold transition-all duration-200 active:scale-95 bg-destructive/15 border-destructive/40 text-destructive hover:bg-destructive/25"
                  title="End room for everyone"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>End Room</span>
                </button>
                {/* Private / Public toggle — optimistic update */}
                <button
                  onClick={() => {
                    const newVal = !(isPrivateLocal ?? roomData?.isPrivate ?? false);
                    setIsPrivateLocal(newVal);
                    setPrivacyMutation.mutate({ code, data: { isPrivate: newVal } }, {
                      onError: () => setIsPrivateLocal(null),
                    });
                  }}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-sm font-semibold transition-all duration-300 active:scale-95 flex-shrink-0 ${
                    (isPrivateLocal ?? roomData?.isPrivate)
                      ? "bg-red-500/20 border-red-400/50 text-red-300 shadow-[0_0_8px_rgba(239,68,68,0.3)]"
                      : "bg-sky-500/15 border-sky-400/40 text-sky-300 shadow-[0_0_8px_rgba(56,189,248,0.2)]"
                  }`}
                  title={(isPrivateLocal ?? roomData?.isPrivate) ? "Private — click to make Public" : "Public — click to make Private"}
                >
                  {(isPrivateLocal ?? roomData?.isPrivate) ? <Lock className="w-3.5 h-3.5" /> : <Globe className="w-3.5 h-3.5" />}
                  <span>{(isPrivateLocal ?? roomData?.isPrivate) ? "Private" : "Public"}</span>
                </button>
                {/* Open / Locked (access control) — unchanged */}
                <button
                  onClick={() => {
                    const locking = !accessControlEnabled;
                    socketRef.current?.emit("setAccessControl", { enabled: locking });
                  }}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-sm font-semibold transition-all duration-300 active:scale-95 flex-shrink-0 ${
                    accessControlEnabled
                      ? "bg-red-500/20 border-red-400/50 text-red-300 shadow-[0_0_8px_rgba(239,68,68,0.3)]"
                      : "bg-green-500/15 border-green-400/40 text-green-300 shadow-[0_0_8px_rgba(34,197,94,0.2)]"
                  }`}
                  title={accessControlEnabled ? "Locked" : "Open"}
                >
                  <Lock className={`w-3.5 h-3.5 transition-transform duration-300 ${accessControlEnabled ? "rotate-0" : "-rotate-12"}`} />
                  <span>{accessControlEnabled ? "Locked" : "Open"}</span>
                </button>
              </div>
            )}
          </div>
          {/* Right: mode switcher — hidden on mobile, shown inline from sm: up */}
          {isPrivileged ? (
            <div className="hidden sm:flex items-center gap-1 bg-muted/70 rounded-lg p-1 shadow-inner flex-shrink-0">
              <button
                onClick={() => changeMode("video")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-semibold transition-all duration-200 ${mode === "video" ? "bg-violet-500 text-white shadow-sm shadow-violet-500/30" : "text-muted-foreground hover:text-foreground"}`}
              >
                <Film className="w-3.5 h-3.5" />Video
              </button>
              <button
                onClick={() => changeMode("browser")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-semibold transition-all duration-200 ${mode === "browser" ? "bg-sky-500 text-white shadow-sm shadow-sky-500/30" : "text-muted-foreground hover:text-foreground"}`}
              >
                <Globe className="w-3.5 h-3.5" />Browser
              </button>
              <button
                onClick={() => changeMode("screenshare")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-semibold transition-all duration-200 ${mode === "screenshare" ? "bg-emerald-500 text-white shadow-sm shadow-emerald-500/30" : "text-muted-foreground hover:text-foreground"}`}
              >
                <Monitor className="w-3.5 h-3.5" />Share
              </button>
              <button
                onClick={() => changeMode("movies")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-semibold transition-all duration-200 ${mode === "movies" ? "bg-orange-500 text-white shadow-sm shadow-orange-500/30" : "text-muted-foreground hover:text-foreground"}`}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="17" y1="7" x2="22" y2="7"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="2" y1="17" x2="7" y2="17"/></svg>
                Movies
              </button>
            </div>
          ) : (
            <div className={`hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold border flex-shrink-0 ${
                mode === "video" ? "bg-violet-500/20 border-violet-500/40 text-violet-300 shadow-sm shadow-violet-500/20"
                : mode === "browser" ? "bg-sky-500/20 border-sky-500/40 text-sky-300 shadow-sm shadow-sky-500/20"
                : mode === "movies" ? "bg-orange-500/20 border-orange-500/40 text-orange-300 shadow-sm shadow-orange-500/20"
                : "bg-emerald-500/20 border-emerald-500/40 text-emerald-300 shadow-sm shadow-emerald-500/20"
              }`}>
              {mode === "video" ? <><Film className="w-3.5 h-3.5" /><span>Video</span></>
                : mode === "browser" ? <><Globe className="w-3.5 h-3.5" /><span>Browser</span></>
                : mode === "movies" ? <><svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="17" y1="7" x2="22" y2="7"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="2" y1="17" x2="7" y2="17"/></svg><span>Movies</span></>
                : <><Monitor className="w-3.5 h-3.5" /><span>Screen Share</span></>}
            </div>
          )}
        </div>

        {/* Row 1b: mode switcher — own full-width row on mobile only (< sm) */}
        {isPrivileged ? (
          <div className="flex sm:hidden items-stretch gap-1 bg-muted/40 rounded-xl p-1 shadow-inner mx-3 mb-3 h-11">
            <button
              onClick={() => changeMode("video")}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg text-sm font-bold transition-all duration-200 ${mode === "video" ? "bg-violet-500 text-white shadow-md shadow-violet-500/40" : "text-muted-foreground active:bg-muted"}`}
            >
              <Film className="w-5 h-5 flex-shrink-0" /><span className="truncate">Video</span>
            </button>
            <button
              onClick={() => changeMode("browser")}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg text-sm font-bold transition-all duration-200 ${mode === "browser" ? "bg-sky-500 text-white shadow-md shadow-sky-500/40" : "text-muted-foreground active:bg-muted"}`}
            >
              <Globe className="w-5 h-5 flex-shrink-0" /><span className="truncate">Browser</span>
            </button>
            <button
              onClick={() => changeMode("screenshare")}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg text-sm font-bold transition-all duration-200 ${mode === "screenshare" ? "bg-emerald-500 text-white shadow-md shadow-emerald-500/40" : "text-muted-foreground active:bg-muted"}`}
            >
              <Monitor className="w-5 h-5 flex-shrink-0" /><span className="truncate">Share</span>
            </button>
            <button
              onClick={() => changeMode("movies")}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg text-sm font-bold transition-all duration-200 ${mode === "movies" ? "bg-orange-500 text-white shadow-md shadow-orange-500/40" : "text-muted-foreground active:bg-muted"}`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="17" y1="7" x2="22" y2="7"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="2" y1="17" x2="7" y2="17"/></svg>
              <span className="truncate">Movies</span>
            </button>
          </div>
        ) : (
          <div className={`flex sm:hidden items-center justify-center gap-1.5 px-3 mx-3 mb-3 h-11 rounded-xl text-base font-bold border ${
            mode === "video" ? "bg-violet-500/25 border-violet-500/50 text-violet-200 shadow-md shadow-violet-500/20"
            : mode === "browser" ? "bg-sky-500/25 border-sky-500/50 text-sky-200 shadow-md shadow-sky-500/20"
            : mode === "movies" ? "bg-orange-500/25 border-orange-500/50 text-orange-200 shadow-md shadow-orange-500/20"
            : "bg-emerald-500/25 border-emerald-500/50 text-emerald-200 shadow-md shadow-emerald-500/20"
          }`}>
            {mode === "video" ? <><Film className="w-5 h-5" /><span>Video</span></>
              : mode === "browser" ? <><Globe className="w-5 h-5" /><span>Browser</span></>
              : mode === "movies" ? <><svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="17" y1="7" x2="22" y2="7"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="2" y1="17" x2="7" y2="17"/></svg><span>Movies</span></>
              : <><Monitor className="w-5 h-5" /><span>Screen Share</span></>}
          </div>
        )}

        {/* Row 2: action buttons — fixed single row, no wrap/no scroll, same height as the mode switcher above (h-11) */}
        <div className="px-3 pt-1.5 pb-3">
        <div className="flex items-stretch gap-1.5 sm:gap-2 h-11 sm:h-auto">
          <div className="flex items-center justify-center gap-1.5 px-2 sm:px-3 sm:py-2.5 rounded-lg bg-muted border border-border flex-1 sm:flex-initial min-w-0">
            <code className="text-sm sm:text-base font-mono font-bold text-foreground truncate">{code}</code>
            <button
              onClick={copyCode}
              className="text-muted-foreground hover:text-foreground active:scale-90 transition-all duration-150 ease-out flex-shrink-0"
            >
              {copied ? <Check className="w-4 h-4 sm:w-5 sm:h-5 text-green-400" /> : <Copy className="w-4 h-4 sm:w-5 sm:h-5" />}
            </button>
          </div>

          <button
            onClick={copyInviteLink}
            className={`flex items-center justify-center gap-1.5 px-2 sm:px-3 sm:py-2.5 rounded-lg border text-sm sm:text-base font-semibold transition-all duration-200 ease-out active:scale-90 select-none flex-1 sm:flex-initial min-w-0 ${
              copiedInvite
                ? "bg-green-500/15 border-green-400/40 text-green-300 shadow-[0_0_8px_rgba(34,197,94,0.25)]"
                : "bg-muted border-border text-muted-foreground hover:text-foreground hover:border-primary/30"
            }`}
          >
            {copiedInvite ? <Check className="w-4 h-4 sm:w-5 sm:h-5 text-green-400 flex-shrink-0" /> : <Link className="w-4 h-4 sm:w-5 sm:h-5 flex-shrink-0" />}
            <span className="hidden sm:inline">{copiedInvite ? "Copied!" : "Invite"}</span>
          </button>

          {/* Contextual session-ending actions: shown inline only from sm: up — on mobile they live in Row 2b above */}
          {isPrivileged && mode === "browser" && hyperbeamEmbed && (
            <button
              onClick={terminateBrowserSession}
              className="hidden sm:flex items-center justify-center gap-1.5 px-2 sm:px-3 sm:py-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-sm sm:text-base text-red-400 hover:bg-red-500/20 active:scale-90 transition-all duration-200 ease-out select-none flex-shrink-0"
            >
              <X className="w-4 h-4 sm:w-5 sm:h-5" /><span className="hidden sm:inline">End Session</span>
            </button>
          )}

          {isPrivileged && mode === "video" && videoHlsPath && (
            <button
              onClick={() => socketRef.current?.emit("clearContent")}
              className="hidden sm:flex items-center justify-center gap-1.5 px-2 sm:px-3 sm:py-2.5 rounded-lg bg-orange-500/10 border border-orange-500/20 text-sm sm:text-base text-orange-400 hover:bg-orange-500/20 active:scale-90 transition-all duration-200 ease-out select-none flex-shrink-0"
            >
              <X className="w-4 h-4 sm:w-5 sm:h-5" /><span className="hidden sm:inline">End Video</span>
            </button>
          )}

          {isPrivileged && isScreenSharing && (
            <button
              onClick={stopScreenShare}
              className="hidden sm:flex items-center justify-center gap-1.5 px-2 sm:px-3 sm:py-2.5 rounded-lg bg-orange-500/10 border border-orange-500/20 text-sm sm:text-base text-orange-400 hover:bg-orange-500/20 active:scale-90 transition-all duration-200 ease-out select-none flex-shrink-0"
            >
              <MonitorOff className="w-4 h-4 sm:w-5 sm:h-5" /><span className="hidden sm:inline">Stop Sharing</span>
            </button>
          )}

          <button
            onClick={() => { disconnectSocket(); setLocation("/"); }}
            className="flex items-center justify-center gap-1.5 px-2 sm:px-3 sm:py-2.5 rounded-lg bg-destructive/10 border border-destructive/20 text-sm sm:text-base text-destructive hover:bg-destructive/20 active:scale-90 transition-all duration-200 ease-out select-none flex-1 sm:flex-initial min-w-0"
          >
            <LogOut className="w-4 h-4 sm:w-5 sm:h-5 flex-shrink-0" /><span className="hidden sm:inline">Leave</span>
          </button>

          {(() => {
            const isMutedByHost = members.find(m => m.id === myMemberId)?.isMuted ?? false;
            return (
              <button
                onClick={toggleMic}
                disabled={isMutedByHost && !micEnabled}
                className={`relative flex items-center justify-center gap-1.5 px-2 sm:px-3 sm:py-2.5 rounded-lg border text-sm sm:text-base font-medium transition-all duration-200 ease-out select-none flex-1 sm:flex-initial min-w-0 ${
                  isMutedByHost && !micEnabled
                    ? "bg-muted/40 border-destructive/30 text-destructive/50 cursor-not-allowed opacity-60"
                    : micEnabled
                    ? getNetworkQualityMicClass(networkQuality)
                    : "bg-muted border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground/40 active:scale-90"
                } ${micEnabled ? "active:scale-90" : ""}`}
                title={
                  isMutedByHost && !micEnabled
                    ? "Muted by host"
                    : micEnabled
                    ? getNetworkQualityLabel(networkQuality)
                    : "Mic Off"
                }
              >
                {micEnabled ? <Mic className="w-4 h-4 sm:w-5 sm:h-5 flex-shrink-0" /> : <MicOff className="w-4 h-4 sm:w-5 sm:h-5 flex-shrink-0" />}
                {micEnabled && (
                  <>
                    <div className="flex items-end gap-0.5 h-4 ml-0.5 flex-shrink-0">
                      {[0.4, 0.7, 1, 0.7, 0.4].map((mult, i) => {
                        const vol = speakingState[myMemberId] ?? 0;
                        return <div key={i} className={`w-0.5 rounded-full transition-all duration-100 ${getNetworkQualityBarClass(networkQuality)}`} style={{ height: `${Math.max(2, Math.min(16, vol * mult * 0.16))}px` }} />;
                      })}
                    </div>
                    {/* نقطة مؤشر جودة الشبكة في أعلى يمين الزرار */}
                    {networkQuality !== "none" && (
                      <span
                        className={`absolute top-1 right-1 w-2 h-2 rounded-full ${getNetworkQualityDotClass(networkQuality)} ${networkQuality === "poor" ? "animate-pulse" : ""}`}
                        aria-label={getNetworkQualityLabel(networkQuality)}
                      />
                    )}
                  </>
                )}
              </button>
            );
          })()}

          <button
            onClick={() => {
              const next = !notifSoundEnabled;
              setNotifSoundEnabled(next);
              // Re-enabling: this click IS a user gesture — use it to fix a stuck AudioContext.
              // This is the permanent fix: no more manual mute→unmute to restore sound.
              if (next) {
                const ctx = audioPlayerRef.current;
                if (!ctx || ctx.state === "closed") {
                  try {
                    const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
                    if (AudioCtxClass) {
                      audioPlayerRef.current = new AudioCtxClass();
                    }
                  } catch { /* ignore */ }
                } else if (ctx.state === "suspended") {
                  ctx.resume().catch(() => {});
                }
              }
            }}
            className={`relative flex items-center justify-center gap-1.5 px-2 sm:px-3 sm:py-2.5 rounded-lg border text-sm sm:text-base font-medium transition-all duration-200 ease-out active:scale-90 select-none flex-1 sm:flex-initial min-w-0 ${
              bellPulse
                ? "bg-primary/20 border-primary/50 text-primary scale-110 shadow-[0_0_14px_rgba(139,92,246,0.5)]"
                : notifSoundEnabled
                ? "bg-muted border-border text-muted-foreground hover:text-foreground hover:border-primary/30"
                : "bg-destructive/10 border-destructive/20 text-destructive"
            }`}
            title={notifSoundEnabled ? "Mute notifications" : "Unmute notifications"}
          >
            {notifSoundEnabled
              ? <Bell className={`w-4 h-4 sm:w-5 sm:h-5 transition-transform duration-150 flex-shrink-0 ${bellPulse ? "animate-bounce" : ""}`} />
              : <BellOff className="w-4 h-4 sm:w-5 sm:h-5 flex-shrink-0" />}
            {bellPulse && notifSoundEnabled && (
              <span className="absolute inset-0 rounded-lg ring-2 ring-primary/60 animate-ping pointer-events-none" />
            )}
          </button>

          <button
            onClick={() => {
              setPanelOpen(o => {
                if (!o && unreadCount > 0) setActiveTab("chat");
                return !o;
              });
            }}
            className={`relative flex items-center justify-center gap-1.5 px-2 sm:px-3 sm:py-2.5 rounded-lg border text-sm sm:text-base font-semibold transition-all duration-200 ease-out active:scale-90 select-none flex-1 sm:flex-initial min-w-0 sm:ml-auto ${
              panelOpen
                ? "bg-primary text-white border-primary shadow-[0_0_12px_rgba(var(--primary),0.35)]"
                : "bg-muted border-border text-muted-foreground hover:text-foreground hover:border-primary/30"
            }`}
          >
            <Users className="w-4 h-4 sm:w-5 sm:h-5 flex-shrink-0" />
            <span className="tabular-nums">{onlineCount}</span>
            {panelBadge > 0 && (
              <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-amber-500 text-white text-[10px] flex items-center justify-center font-bold animate-pulse">{panelBadge}</span>
            )}
          </button>
        </div>
        </div>

        {/* Row 2b: End Session / End Video / Stop Sharing — full-width prominent button below the action bar, mobile only */}
        {((isPrivileged && mode === "browser" && hyperbeamEmbed) ||
          (isPrivileged && mode === "video" && videoHlsPath) ||
          (isPrivileged && isScreenSharing)) && (
          <div className="flex sm:hidden flex-col gap-2 px-3 pb-3">
            {isPrivileged && mode === "browser" && hyperbeamEmbed && (
              <button
                onClick={terminateBrowserSession}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-base font-semibold text-red-400 hover:bg-red-500/20 active:scale-95 transition-all duration-200 ease-out select-none"
              >
                <X className="w-5 h-5 flex-shrink-0" />
                <span>End Session</span>
              </button>
            )}
            {isPrivileged && mode === "video" && videoHlsPath && (
              <button
                onClick={() => socketRef.current?.emit("clearContent")}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-orange-500/10 border border-orange-500/20 text-base font-semibold text-orange-400 hover:bg-orange-500/20 active:scale-95 transition-all duration-200 ease-out select-none"
              >
                <X className="w-5 h-5 flex-shrink-0" />
                <span>End Video</span>
              </button>
            )}
            {isPrivileged && isScreenSharing && (
              <button
                onClick={stopScreenShare}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-orange-500/10 border border-orange-500/20 text-base font-semibold text-orange-400 hover:bg-orange-500/20 active:scale-95 transition-all duration-200 ease-out select-none"
              >
                <MonitorOff className="w-5 h-5 flex-shrink-0" />
                <span>Stop Sharing</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Main area */}
      <div className="flex flex-1 overflow-hidden relative">
        <div className="flex-1 flex flex-col overflow-hidden">

          {/* VIDEO MODE */}
          <div
            ref={videoContainerRef}
            className={`relative flex items-center justify-center bg-[#050508] overflow-hidden ${mode === "browser" || mode === "movies" ? "hidden" : isFullscreen ? "fixed inset-0 z-[9999]" : "flex-1"}`}
            onMouseMove={showControls}
            onTouchStart={showControls}
          >
            {/* Video element always mounted when content exists — keeps HLS alive during mode switches.
                Hidden (not removed) when not in video mode so HLS keeps fetching segments. */}
            {videoHlsPath && (
              <video
                ref={videoRef}
                className="w-full h-full object-contain"
                style={{ display: mode === "video" ? undefined : "none" }}
                controls={false}
                playsInline
                preload="auto"
                {...{ "webkit-playsinline": "true", "x-webkit-airplay": "deny" } as Record<string, string>}
                onPlay={handleVideoPlay}
                onPause={handleVideoPause}
                onSeeked={handleVideoSeeked}
                onTimeUpdate={handleVideoTimeUpdate}
                onLoadedMetadata={handleVideoLoadedMetadata}
                onCanPlay={handleVideoCanPlay}
                onError={handleVideoError}
                onWaiting={() => {
                  // Video is buffering — immediately restore normal playback rate so
                  // the buffer can refill at full speed. Elevated rates (e.g. 1.05x)
                  // while buffering extend the stall unnecessarily.
                  const v = videoRef.current;
                  if (v && v.playbackRate !== 1) v.playbackRate = 1;
                }}
                onClick={isPrivileged && mode === "video" ? handlePlayPause : undefined}
                data-testid="video-player"
              />
            )}
            {mode === "video" && videoHlsPath ? (
              <>
                {tapToPlay && mode === "video" && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/60 cursor-pointer z-20" onClick={async () => {
                    const v = videoRef.current;
                    if (v) {
                      // Clear tapToPlay first so heartbeats don't re-trigger during seek/play
                      tapToPlayRef.current = false;
                      setTapToPlay(false);

                      // Prefer the freshest time from heartbeat-updated pendingVideoSyncRef.
                      // Fall back to pendingPlayTimeRef (set when tapToPlay was first triggered).
                      const pending = pendingVideoSyncRef.current;
                      const seekTime = pending
                        ? Math.max(0, pending.shouldPlay
                            ? pending.targetTime + (Date.now() - pending.storedAt) / 1000
                            : pending.targetTime)
                        : Math.max(0, pendingPlayTimeRef.current);

                      if (Math.abs(v.currentTime - seekTime) > 0.3) {
                        v.currentTime = seekTime;
                        // Wait for iOS to finish seeking before calling play()
                        await waitForSeeked(v);
                      }
                      try { await v.play(); setIsPlaying(true); isPlayingRef.current = true; } catch {
                        // If play still fails (e.g. iOS killed context), restore tapToPlay
                        tapToPlayRef.current = true;
                        setTapToPlay(true);
                      }
                    }
                  }}>
                    <div className="text-center">
                      <div className="w-20 h-20 rounded-full bg-white/10 border-2 border-white/20 flex items-center justify-center mx-auto mb-3">
                        <Play className="w-10 h-10 text-white fill-white ml-1" />
                      </div>
                      <p className="text-white text-sm font-medium">Tap to resume</p>
                    </div>
                  </div>
                )}
                {isSyncing && !tapToPlay && mode === "video" && (
                  <div className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-black/70 backdrop-blur-sm z-30 pointer-events-none">
                    <RefreshCw className="w-3 h-3 text-white animate-spin" />
                    <span className="text-white text-xs font-medium">Syncing...</span>
                  </div>
                )}
                <div className={`absolute inset-0 flex flex-col justify-end transition-opacity duration-300 ${controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"}`}>
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent pointer-events-none" />
                  <div className="relative z-10 px-4 pb-4 pt-2 space-y-2">
                    {isPrivileged && mode === "video" && (
                      <div className="flex items-center gap-2">
                        <span className="text-white/70 text-xs tabular-nums w-10 text-right flex-shrink-0">{formatTime(currentTime)}</span>
                        <input
                          type="range" min={0} max={1000} step={1}
                          value={progressPercent}
                          onChange={handleSeekBar}
                          onMouseDown={() => { seekingRef.current = true; }}
                          disabled={duration === 0}
                          className="flex-1 h-1 appearance-none cursor-pointer rounded-full"
                          style={{ background: `linear-gradient(to right, rgb(139 92 246) ${progressPercent / 10}%, rgba(255,255,255,0.2) ${progressPercent / 10}%)`, outline: "none" }}
                        />
                        <span className="text-white/70 text-xs tabular-nums w-10 flex-shrink-0">{formatTime(duration)}</span>
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      {isPrivileged && (
                        <>
                          <button onClick={() => handleSkip(-10)} className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/25 flex items-center justify-center transition-all active:scale-95">
                            <SkipBack className="w-4 h-4 text-white fill-white" />
                          </button>
                          <button onClick={handlePlayPause} className="w-10 h-10 rounded-full bg-white/20 hover:bg-white/35 flex items-center justify-center transition-all active:scale-95">
                            {isPlaying ? <Pause className="w-5 h-5 text-white fill-white" /> : <Play className="w-5 h-5 text-white fill-white ml-0.5" />}
                          </button>
                          <button onClick={() => handleSkip(10)} className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/25 flex items-center justify-center transition-all active:scale-95">
                            <SkipForward className="w-4 h-4 text-white fill-white" />
                          </button>
                        </>
                      )}
                      <div className="flex-1" />
                      <button onClick={handleFullscreen} className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/25 flex items-center justify-center transition-all active:scale-95">
                        {isFullscreen ? <Minimize className="w-4 h-4 text-white" /> : <Maximize className="w-4 h-4 text-white" />}
                      </button>
                    </div>
                  </div>
                </div>
              </>
            ) : mode === "screenshare" ? (
              /* Screen Share view */
              <div
                className="flex flex-col items-center justify-center w-full h-full relative"
                onMouseMove={showControls}
                onTouchStart={showControls}
              >
                {/* Screen video element — used by both host (local preview) and guests (remote) */}
                <div className={`w-full h-full ${isScreenSharing || remoteScreenStream ? "block" : "hidden"}`}>
                  <video
                    ref={screenVideoRef}
                    autoPlay
                    playsInline
                    muted
                    controls={false}
                    disablePictureInPicture
                    disableRemotePlayback
                    {...{ "webkit-playsinline": "true", "x-webkit-airplay": "deny" } as Record<string, string>}
                    className="w-full h-full object-contain"
                    style={{ WebkitUserSelect: "none" }}
                    onCanPlay={(e) => {
                      const v = e.currentTarget;
                      if (v.paused) {
                        v.play().then(() => setIosNeedsTap(false)).catch(() => {
                          if (isIOSDevice) setIosNeedsTap(true);
                        });
                      }
                    }}
                  />
                </div>

                {/* iOS tap-to-play overlay — shown when autoplay is blocked (black screen fix) */}
                {iosNeedsTap && (isScreenSharing || remoteScreenStream) && (
                  <div
                    className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 z-20 cursor-pointer"
                    onClick={() => {
                      const el = screenVideoRef.current;
                      if (!el) return;
                      // iOS Safari: play() قد ينجح لكن الشاشة تبقى سودا
                      // لأن الـ decoder لم يُهيَّأ صح — نعيد attach الـ stream بالكامل
                      const stream = el.srcObject as MediaStream | null;
                      el.srcObject = null;
                      requestAnimationFrame(() => {
                        if (!screenVideoRef.current) return;
                        screenVideoRef.current.srcObject = stream;
                        screenVideoRef.current.load();
                        screenVideoRef.current.play()
                          .then(() => setIosNeedsTap(false))
                          .catch(() => {});
                      });
                    }}
                  >
                    <div className="w-16 h-16 rounded-full bg-white/15 flex items-center justify-center mb-3">
                      <Play className="w-8 h-8 text-white ml-1" />
                    </div>
                    <p className="text-white text-sm font-medium">اضغط للمشاهدة</p>
                  </div>
                )}

                {/* Empty state */}
                {!isScreenSharing && !remoteScreenStream && (
                  <div className="text-center p-8">
                    <Monitor className="w-16 h-16 text-muted-foreground/30 mx-auto mb-4" />
                    {isPrivileged ? (
                      <div>
                        <p className="text-muted-foreground/60 text-sm mb-4">Share your screen with everyone in the room</p>
                        {screenShareError && (
                          <p className="text-destructive/80 text-xs mb-3 max-w-xs mx-auto">{screenShareError}</p>
                        )}
                        {isIOSDevice ? (
                          <div className="flex flex-col items-center gap-3">
                            <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-500/10 border border-amber-500/25">
                              <Monitor className="w-4 h-4 text-amber-400 shrink-0" />
                              <p className="text-amber-400/90 text-xs text-right leading-relaxed">
                                مشاركة الشاشة غير متاحة من متصفح iPhone —<br />
                                استخدم جهاز Desktop أو Android للمشاركة
                              </p>
                            </div>
                            <p className="text-muted-foreground/50 text-xs">يمكنك مشاهدة مشاركة شاشة الآخرين بشكل طبيعي</p>
                          </div>
                        ) : (
                          <button
                            onClick={startScreenShare}
                            className="flex items-center gap-2.5 px-7 py-3.5 rounded-xl bg-emerald-500 text-white text-base font-bold hover:bg-emerald-600 active:scale-95 transition-all mx-auto shadow-lg shadow-emerald-500/30"
                          >
                            <Monitor className="w-5 h-5" />مشاركة شاشة
                          </button>
                        )}
                      </div>
                    ) : (
                      <p className="text-muted-foreground/60 text-sm">Waiting for host to share their screen…</p>
                    )}
                  </div>
                )}

                {/* Live indicator when sharing */}
                {isScreenSharing && (
                  <div className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/70 backdrop-blur-sm z-30 pointer-events-none">
                    <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                    <span className="text-white text-xs font-medium">Sharing your screen</span>
                  </div>
                )}

                {/* Controls overlay — fullscreen only */}
                {(isScreenSharing || remoteScreenStream) && (
                  <div className={`absolute inset-0 flex flex-col justify-end transition-opacity duration-300 ${controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"}`}>
                    <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent pointer-events-none" />
                    <div className="relative z-10 px-4 pb-4 pt-2 flex justify-end">
                      <button
                        onClick={handleScreenShareFullscreen}
                        className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/25 flex items-center justify-center transition-all active:scale-95"
                      >
                        {(isFullscreen || isSSIOSFullscreen) ? <Minimize className="w-4 h-4 text-white" /> : <Maximize className="w-4 h-4 text-white" />}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center p-8">
                <Film className="w-16 h-16 text-muted-foreground/30 mx-auto mb-4" />
                {uploadProgress !== null ? (
                  <div className="w-64">
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-sm text-muted-foreground">{uploadProgress < 50 ? "Uploading..." : "Processing video..."}</p>
                      {uploadProgress < 50 && uploadXhrRef.current !== null && (
                        <button onClick={cancelUpload} className="p-1 rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors" title="Cancel">
                          <X className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                      <div className="h-full bg-primary rounded-full transition-all duration-300" style={{ width: `${uploadProgress}%` }} />
                    </div>
                    <div className="flex items-center justify-between mt-2">
                      <p className="text-xs text-muted-foreground">{uploadProgress}%</p>
                      {uploadSpeed !== null && uploadRemaining !== null && uploadProgress < 50 && (
                        <p className="text-xs text-muted-foreground">
                          {uploadSpeed >= 1048576 ? `${(uploadSpeed / 1048576).toFixed(1)} MB/s` : `${(uploadSpeed / 1024).toFixed(0)} KB/s`}
                          {" · "}{uploadRemaining < 60 ? `${Math.ceil(uploadRemaining)}s` : `${Math.ceil(uploadRemaining / 60)}m`} left
                        </p>
                      )}
                    </div>
                  </div>
                ) : (
                  <div>
                    <p className="text-muted-foreground/60 text-sm mb-4">{isPrivileged ? "Upload a video to start watching" : "Waiting for host to upload a video"}</p>
                    {isPrivileged && (
                      <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-2.5 px-7 py-3.5 rounded-xl bg-violet-500 text-white text-base font-bold hover:bg-violet-600 active:scale-95 transition-all shadow-lg shadow-violet-500/30 mx-auto">
                        <Upload className="w-5 h-5" />Upload Video
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}


          </div>

          {/* BROWSER MODE */}
          {/* FIX: بدل {mode === "browser" && ...} استخدمنا display:none عشان الـ container
              يفضل في الـ DOM دايماً ومش بيتحذف لما نبدّل تاب. لو بيتحذف، الـ Hyperbeam SDK
              بيفقد connection بتاعه وبييجي شاشة سودا لما ترجع. */}
          <div
            ref={browserContainerRef}
            className={`relative bg-[#050508] overflow-hidden ${isBrowserFullscreen && !isIOSDevice ? "fixed inset-0 z-[9999]" : !isBrowserFullscreen ? "flex-1" : ""}`}
            style={{
              display: mode === "browser" ? undefined : "none",
              ...(isBrowserFullscreen && isIOSDevice ? { position: "fixed", top: 0, left: 0, width: iosViewport.w, height: iosViewport.h, zIndex: 9999 } : undefined),
              touchAction: "pan-x pan-y",
            }}
            onTouchStart={hyperbeamEmbed ? showBrowserControls : undefined}
          >
              {hyperbeamEmbed ? (
                <>
                  <div
                    key={hyperbeamEmbed}
                    ref={hbContainerRef}
                    style={{
                      border: "none",
                      display: "block",
                      pointerEvents: isPrivileged ? "auto" : "none",
                      touchAction: "pan-x pan-y",
                      width: "100%",
                      height: "100%",
                    }}
                  />
                  <div
                    className="absolute inset-0"
                    style={{ zIndex: 5, pointerEvents: browserControlsVisible ? "none" : "auto" }}
                    onMouseMove={showBrowserControls}
                    onTouchStart={showBrowserControls}
                  />
                  <div
                    className="absolute bottom-4 right-4 flex items-center gap-2 transition-opacity duration-300"
                    style={{ zIndex: 10, opacity: browserControlsVisible ? 1 : 0, pointerEvents: browserControlsVisible ? "auto" : "none" }}
                  >
                    {/* Widen button — mobile, landscape, fullscreen only */}
                    {isMobileDevice && isLandscape && isBrowserFullscreen && (
                      <button
                        onClick={() => setBrowserWidened(w => !w)}
                        className="w-9 h-9 rounded-full bg-black/50 hover:bg-black/70 flex items-center justify-center transition-all active:scale-95 backdrop-blur-sm"
                        title={browserWidened ? "Reset width" : "Widen to full screen"}
                      >
                        <span className="flex items-center gap-0.5">
                          <ArrowLeft className="w-3 h-3 text-white" />
                          <ArrowRight className="w-3 h-3 text-white" />
                        </span>
                      </button>
                    )}
                    <button onClick={handleBrowserFullscreen} className="w-9 h-9 rounded-full bg-black/50 hover:bg-black/70 flex items-center justify-center transition-all active:scale-95 backdrop-blur-sm">
                      {isBrowserFullscreen ? <Minimize className="w-4 h-4 text-white" /> : <Maximize className="w-4 h-4 text-white" />}
                    </button>
                  </div>
                </>
              ) : (
                <div className="absolute inset-0 flex items-center justify-center">
                  {isPrivileged ? (
                    <div className="text-center p-8">
                      <Globe className="w-16 h-16 text-muted-foreground/30 mx-auto mb-4" />
                      <p className="text-muted-foreground text-sm mb-4">Start a shared browser session for everyone to browse together</p>
                      <button onClick={startBrowserSession} disabled={startingBrowser} className="flex items-center gap-2.5 px-7 py-3.5 rounded-xl bg-sky-500 text-white text-base font-bold hover:bg-sky-600 active:scale-95 transition-all shadow-lg shadow-sky-500/30 mx-auto disabled:opacity-50">
                        {startingBrowser ? <Loader2 className="w-5 h-5 animate-spin" /> : <Globe className="w-5 h-5" />}
                        {startingBrowser ? "Starting..." : "Start Browser Session"}
                      </button>
                    </div>
                  ) : (
                    <div className="text-center p-8">
                      <Globe className="w-16 h-16 text-muted-foreground/30 mx-auto mb-4" />
                      <p className="text-muted-foreground/60 text-sm">Waiting for host to start a browser session</p>
                    </div>
                  )}
                </div>
              )}
          </div>

          {/* MOVIES MODE */}
          {mode === "movies" && (
            <CineStream
              isPrivileged={isPrivileged}
              currentState={cineState}
              onNavigate={handleCineNavigate}
              directUrl={cineDirectUrl}
              subtitleUrl={cineSubtitleUrl}
              onDirectUrlChange={handleCineDirectUrlChange}
              onSubtitleChange={handleCineSubtitleChange}
              socket={socketRef.current}
              roomCode={code}
              sessionToken={sessionToken}
            />
          )}

          {/* MOD #2: Upload Video bar removed */}
        </div>

        {/* Side panel */}
        {panelOpen && (
          <div
            className="fixed inset-0 z-[59]"
            onClick={() => setPanelOpen(false)}
          />
        )}
        {panelOpen && (
          <div
            className="absolute right-0 top-0 w-80 bg-card border-l border-border z-[60] flex flex-col shadow-2xl"
            style={{ bottom: 0 }}
          >
            <div className="flex items-center justify-between px-4 py-3.5 border-b border-border flex-shrink-0">
              <span className="text-base font-bold">Room Panel</span>
              <button onClick={() => setPanelOpen(false)} className="p-1.5 rounded-lg hover:bg-muted transition-colors">
                <X className="w-5 h-5 text-muted-foreground" />
              </button>
            </div>

            <div className="flex border-b border-border flex-shrink-0">
              <button
                onClick={() => setActiveTab("members")}
                className={`relative flex-1 py-3 text-sm font-semibold transition-colors ${activeTab === "members" ? "text-primary border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"}`}
              >
                Members
                {joinRequests.length > 0 && isPrivileged && (
                  <span className="absolute top-1.5 right-2 min-w-[18px] h-[18px] px-1 rounded-full bg-amber-500 text-white text-[11px] font-bold flex items-center justify-center shadow-sm shadow-amber-500/50">{joinRequests.length}</span>
                )}
              </button>
              {isPrivileged && (
                <button
                  onClick={() => { setActiveTab("bans"); refetchBans(); }}
                  className={`relative flex-1 py-3 text-sm font-semibold transition-colors ${activeTab === "bans" ? "text-primary border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"}`}
                >
                  Bans
                  {(bans?.length ?? 0) > 0 && (
                    <span className="absolute top-1.5 right-2 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[11px] font-bold flex items-center justify-center shadow-sm shadow-red-500/50 animate-pulse">{bans?.length}</span>
                  )}
                </button>
              )}
              <button
                onClick={() => { setActiveTab("chat"); setUnreadCount(0); }}
                className={`relative flex-1 py-3 text-sm font-semibold transition-colors ${activeTab === "chat" ? "text-primary border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"}`}
              >
                Chat
                {unreadCount > 0 && activeTab !== "chat" && (
                  <span className="absolute top-1.5 right-2 min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-white text-[11px] font-bold flex items-center justify-center shadow-sm">{unreadCount}</span>
                )}
              </button>
            </div>

            {/* Members tab */}
            {activeTab === "members" && (
              <div className="flex-1 overflow-y-auto flex flex-col">
                <div className="px-4 py-2.5 border-b border-border/50 flex-shrink-0">
                  <span className="text-sm font-medium text-muted-foreground">{onlineCount} online</span>
                </div>

                {/* Join requests */}
                {isPrivileged && joinRequests.length > 0 && (
                  <div className="px-3.5 py-2.5 border-b border-border/50 space-y-2 flex-shrink-0">
                    <p className="text-sm font-semibold text-amber-400">Waiting for approval</p>
                    {joinRequests.map(req => (
                      <div key={req.memberId} className="flex items-center gap-2.5 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
                        <UserCheck className="w-5 h-5 text-amber-400 flex-shrink-0" />
                        <span className="text-sm font-medium flex-1 truncate">{req.name}</span>
                        <button onClick={() => approveJoin(req.memberId)} className="px-2.5 py-1 rounded bg-green-500/20 text-green-400 text-sm hover:bg-green-500/30 transition-colors">✓</button>
                        <button onClick={() => rejectJoin(req.memberId)} className="px-2.5 py-1 rounded bg-red-500/20 text-red-400 text-sm hover:bg-red-500/30 transition-colors">✗</button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex-1 overflow-y-auto px-3.5 py-2.5 space-y-1.5">
                  {onlineMembers.map(member => {
                    const isMe = member.id === myMemberId;
                    const vol = speakingState[member.id] ?? 0;
                    const isSpeaking = vol > 8;
                    return (
                      <div key={member.id} className="relative rounded-lg overflow-hidden" style={{
                        boxShadow: member.role === "host"
                          ? "0 0 14px rgba(251,191,36,0.6)"
                          : member.role === "admin"
                          ? "0 0 14px rgba(139,92,246,0.6)"
                          : "0 0 14px rgba(59,130,246,0.55)",
                      }}>
                        <div
                          style={{
                            position: "absolute",
                            width: "300%",
                            aspectRatio: "1",
                            top: "50%",
                            left: "50%",
                            translate: "-50% -50%",
                            background: member.role === "host"
                              ? "conic-gradient(from 0deg, #78350f 0deg, #f59e0b 60deg, #fef08a 180deg, #f59e0b 300deg, #78350f 360deg)"
                              : member.role === "admin"
                              ? "conic-gradient(from 0deg, #3b0764 0deg, #9333ea 60deg, #f0abfc 180deg, #9333ea 300deg, #3b0764 360deg)"
                              : "conic-gradient(from 0deg, #172554 0deg, #2563eb 60deg, #bfdbfe 180deg, #2563eb 300deg, #172554 360deg)",
                            animation: "spin 3s linear infinite",
                          }}
                        />
                      <div className={`relative flex items-center gap-2.5 p-2.5 rounded-[6px] z-10 m-[1.5px] transition-all ${isMe ? "bg-muted" : "bg-card hover:bg-muted/60"}`}>
                        <div className={`relative w-10 h-10 rounded-full bg-muted flex items-center justify-center flex-shrink-0 transition-all ${getRoleRing(member.role)} ${isSpeaking ? "shadow-[0_0_0_3px_rgba(139,92,246,0.5)]" : ""}`}>
                          {member.role === "host"
                            ? <Crown className="w-5 h-5 text-yellow-500" />
                            : member.role === "admin"
                              ? <Shield className="w-5 h-5 text-purple-400" />
                              : <User className="w-5 h-5 text-muted-foreground" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="text-sm font-semibold truncate">{member.name}{isMe ? " (you)" : ""}</span>
                            {member.isMuted && <MicOff className="w-3 h-3 text-destructive flex-shrink-0" />}
                            {/* مؤشر جودة الشبكة — يظهر فقط لصاحب الجهاز لما المايك شغّال */}
                            {isMe && micEnabled && networkQuality !== "none" && (
                              <span
                                className={`w-2 h-2 rounded-full flex-shrink-0 ${getNetworkQualityDotClass(networkQuality)} ${networkQuality === "poor" ? "animate-pulse" : ""}`}
                                title={getNetworkQualityLabel(networkQuality)}
                              />
                            )}
                          </div>
                          <div className="mt-1">{getRoleBadge(member.role)}</div>
                        </div>
                        {isPrivileged && !isMe && (
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                              onClick={() => muteMember(member.id, !member.isMuted)}
                              className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                              title={member.isMuted ? "Unmute" : "Mute"}
                            >
                              {member.isMuted ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
                            </button>
                            {myRole === "host" && member.role !== "host" && (
                              <button
                                onClick={() => promoteMember(member.id, member.role === "admin" ? "guest" : "admin")}
                                className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-purple-400 transition-colors"
                                title={member.role === "admin" ? "Demote to Guest" : "Make Admin"}
                              >
                                <Shield className="w-4 h-4" />
                              </button>
                            )}
                            {(myRole === "host" || (myRole === "admin" && member.role === "guest")) && (
                              <>
                                <button
                                  onClick={() => kickMember(member.id)}
                                  className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-orange-400 transition-colors"
                                  title="Kick"
                                >
                                  <LogOut className="w-4 h-4" />
                                </button>
                                <button
                                  onClick={() => banMember(member.id)}
                                  className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-destructive transition-colors"
                                  title="Ban"
                                >
                                  <Ban className="w-4 h-4" />
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Bans tab */}
            {activeTab === "bans" && isPrivileged && (
              <div className="flex-1 overflow-y-auto flex flex-col">
                {bansLoading ? (
                  <div className="flex items-center justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
                ) : !bans || bans.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-8 text-center px-4">
                    <ShieldOff className="w-10 h-10 text-muted-foreground/30 mb-3" />
                    <p className="text-sm text-muted-foreground">No banned members</p>
                  </div>
                ) : (
                  <div className="px-3.5 py-2.5 space-y-1.5">
                    {bans.map(ban => (
                      <div key={ban.id} className="flex items-center gap-2.5 p-2.5 rounded-lg bg-muted/30 border border-border/50">
                        <Ban className="w-5 h-5 text-destructive flex-shrink-0" />
                        <span className="text-sm flex-1 truncate font-semibold">{(ban as unknown as { name?: string }).name ?? "Unknown"}</span>
                        {myRole === "host" && (
                          <button
                            onClick={() => unban.mutate({ code, banId: ban.id })}
                            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-green-400 transition-colors"
                            title="Unban"
                          >
                            <UserCheck className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Chat tab */}
            {activeTab === "chat" && (
              <div className="flex-1 flex flex-col overflow-hidden">
                <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2" style={{ touchAction: "pan-y", overscrollBehavior: "none" }}>
                  {chatMessages.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-8 text-center">
                      <MessageSquare className="w-8 h-8 text-muted-foreground/30 mb-2" />
                      <p className="text-xs text-muted-foreground">No messages yet</p>
                    </div>
                  )}
                  {chatMessages.map((msg, i) => {
                    const isMe = msg.memberId === myMemberId;
                    const isSwiping = swipingMsgIdx === i;
                    const offset = isSwiping ? swipeOffset : 0;
                    const triggered = isSwiping && swipeOffset > 45;
                    return (
                      <div
                        key={msg.id ?? i}
                        className={`flex flex-col w-full min-w-0 ${isMe ? "items-end" : "items-start"}`}
                        style={{
                          transform: `translateX(${isMe ? -offset : offset}px)`,
                          transition: isSwiping ? "none" : "transform 0.2s ease-out",
                        }}
                        onTouchStart={e => {
                          touchStartXRef.current = e.touches[0].clientX;
                          touchStartYRef.current = e.touches[0].clientY;
                          setSwipingMsgIdx(i);
                          setSwipeOffset(0);
                          longPressTriggeredRef.current = false;
                          if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
                          longPressTimerRef.current = setTimeout(() => {
                            longPressTimerRef.current = null;
                            longPressTriggeredRef.current = true;
                            if (navigator.vibrate) navigator.vibrate(10);
                            setSwipingMsgIdx(null);
                            setSwipeOffset(0);
                            setReactionPickerFor(msg.id);
                          }, 450);
                        }}
                        onTouchMove={e => {
                          // أي حركة محسوسة (مش رعشة صغيرة) بتلغي الضغطة الطويلة عشان لا تتعارض مع السحب أو السكرول
                          const movedX = Math.abs(e.touches[0].clientX - touchStartXRef.current);
                          const movedY = Math.abs(e.touches[0].clientY - touchStartYRef.current);
                          if ((movedX > 10 || movedY > 10) && longPressTimerRef.current) {
                            clearTimeout(longPressTimerRef.current);
                            longPressTimerRef.current = null;
                          }
                          if (swipingMsgIdx !== i) return;
                          // FIX PANEL-SWIPE: لو الحركة أفقية بشكل واضح، وقف الـ bubble
                          // عشان الـ panel أو الـ browser ما يتحركوش مع السحب
                          if (movedX > movedY && movedX > 5) {
                            e.stopPropagation();
                          }
                          const dx = isMe
                            ? touchStartXRef.current - e.touches[0].clientX
                            : e.touches[0].clientX - touchStartXRef.current;
                          if (dx > 0) {
                            setSwipeOffset(Math.min(dx, 65));
                          }
                        }}
                        onTouchEnd={e => {
                          if (longPressTimerRef.current) {
                            clearTimeout(longPressTimerRef.current);
                            longPressTimerRef.current = null;
                          }
                          if (longPressTriggeredRef.current) {
                            // المنتقي فتح فعلاً من الضغطة الطويلة — منمنع أي click/swipe زيادة بعد كده
                            longPressTriggeredRef.current = false;
                            e.preventDefault();
                            return;
                          }
                          if (swipeOffset > 45) setReplyingTo(msg);
                          setSwipeOffset(0);
                          setSwipingMsgIdx(null);
                        }}
                      >
                        <span className="text-sm text-muted-foreground mb-1">{msg.name}</span>
                        {msg.replyTo && (
                          <div className="max-w-[85%] px-2 py-1 mb-1 rounded-lg text-sm border-l-2 border-primary/50 bg-muted/60 text-muted-foreground truncate">
                            <span className="font-medium text-primary/80">{msg.replyTo.name}:</span> {msg.replyTo.message}
                          </div>
                        )}
                        <div className="relative flex items-end gap-1.5">
                          {!isMe && (
                            <button
                              onClick={() => setReplyingTo(msg)}
                              className={`p-1 rounded-full transition-all ${triggered ? "text-primary scale-125" : "text-muted-foreground/50 hover:text-foreground"}`}
                              title="Reply"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
                            </button>
                          )}
                          {!isMe && msg.id && (
                            <button
                              onClick={() => setReactionPickerFor(p => (p === msg.id ? null : msg.id))}
                              className={`p-1 rounded-full transition-all ${reactionPickerFor === msg.id ? "text-primary scale-125" : "text-muted-foreground/50 hover:text-foreground"}`}
                              title="React"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" x2="9.01" y1="9" y2="9"/><line x1="15" x2="15.01" y1="9" y2="9"/></svg>
                            </button>
                          )}
                          <div style={{ overflowWrap: "anywhere", wordBreak: "break-word" }} className={`max-w-[85%] rounded-2xl text-base leading-snug min-w-0 overflow-hidden ${msg.imageData || msg.message.startsWith("__sticker__") ? "bg-transparent p-0" : `px-3 py-2 ${isMe ? "bg-primary text-primary-foreground rounded-tr-sm" : "bg-muted text-foreground rounded-tl-sm"}`}`}>
                            {msg.imageData && msg.imageData.startsWith("data:image/") ? (
                              <img src={msg.imageData} alt="image" className="max-w-[200px] max-h-[200px] rounded-xl object-cover cursor-pointer" onClick={() => safeOpenImage(msg.imageData)} />
                            ) : msg.message.startsWith("__sticker__") ? (
                              <span className="text-5xl leading-none select-none">{msg.message.replace("__sticker__", "")}</span>
                            ) : msg.message}
                          </div>
                          {isMe && msg.id && (
                            <button
                              onClick={() => setReactionPickerFor(p => (p === msg.id ? null : msg.id))}
                              className={`p-1 rounded-full transition-all ${reactionPickerFor === msg.id ? "text-primary scale-125" : "text-muted-foreground/50 hover:text-foreground"}`}
                              title="React"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" x2="9.01" y1="9" y2="9"/><line x1="15" x2="15.01" y1="9" y2="9"/></svg>
                            </button>
                          )}
                          {isMe && (
                            <button
                              onClick={() => setReplyingTo(msg)}
                              className={`p-1 rounded-full transition-all ${triggered ? "text-primary scale-125" : "text-muted-foreground/50 hover:text-foreground"}`}
                              title="Reply"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
                            </button>
                          )}

                          {/* Emoji reaction picker popup */}
                          {reactionPickerFor === msg.id && (
                            <div className={`absolute bottom-full mb-1 z-20 flex items-center gap-1 bg-card border border-border rounded-full shadow-xl px-2 py-1.5 ${isMe ? "right-0" : "left-0"}`}>
                              {REACTION_EMOJIS.map(em => (
                                <button
                                  key={em}
                                  onClick={() => toggleReaction(msg.id, em)}
                                  className="text-xl hover:scale-125 transition-transform active:scale-95"
                                >
                                  {em}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Reaction pills */}
                        {msg.reactions && Object.keys(msg.reactions).length > 0 && (
                          <div className={`flex flex-wrap gap-1 mt-1 ${isMe ? "justify-end" : "justify-start"}`}>
                            {Object.entries(msg.reactions).map(([emoji, memberIds]) => {
                              const reactedByMe = myMemberId != null && memberIds.includes(myMemberId);
                              return (
                                <button
                                  key={emoji}
                                  onClick={() => toggleReaction(msg.id, emoji)}
                                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs border transition-all ${reactedByMe ? "bg-primary/15 border-primary/50 text-primary" : "bg-muted/60 border-border/50 text-muted-foreground hover:bg-muted"}`}
                                >
                                  <span>{emoji}</span>
                                  <span className="font-medium">{memberIds.length}</span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <div ref={chatBottomRef} />
                </div>
                {replyingTo && (
                  <div className="px-3 py-2 border-t border-border/50 bg-muted/30 flex items-center gap-2 flex-shrink-0">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-primary/80 font-medium">Replying to {replyingTo.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{replyingTo.message}</p>
                    </div>
                    <button onClick={() => setReplyingTo(null)} className="p-1 rounded text-muted-foreground hover:text-foreground flex-shrink-0">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}
                <div
                  className="px-3 pt-3 pb-3 border-t border-border flex-shrink-0 relative"
                >
                  {/* Sticker panel — floats above the input bar */}
                  {showStickerPanel && (
                    <div className="absolute bottom-full left-0 right-0 mb-1 mx-3 bg-card border border-border rounded-xl shadow-xl p-3 z-10">
                      <p className="text-xs text-muted-foreground mb-2 font-medium">Stickers</p>
                      <div className="grid grid-cols-6 gap-2">
                        {["🎉","🥳","😍","🤩","😎","🥹","💀","🤯","🫶","💪","🙈","🐣","🦋","🌈","⭐","🔥","💫","✨","🎯","🎮","🍕","🎂","🏆","❤️‍🔥","💔","🫠","🤡","👻","💩","🤖","🦄","🐸"].map(s => (
                          <button key={s} onClick={() => sendStickerMessage(s)} className="text-2xl hover:scale-125 transition-transform active:scale-95 flex items-center justify-center h-9">{s}</button>
                        ))}
                      </div>
                    </div>
                  )}
                  {/* Row 1: image + sticker buttons + quick emojis (all in one scrollable row) */}
                  <div className="flex items-center gap-2 mb-2 overflow-x-auto scrollbar-none pb-0.5">
                    {/* Hidden file input */}
                    <input
                      ref={imageInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={e => { const f = e.target.files?.[0]; if (f) sendImageMessage(f); e.target.value = ""; }}
                    />
                    <button
                      onClick={() => { setShowStickerPanel(false); imageInputRef.current?.click(); }}
                      className="p-1 rounded-lg text-muted-foreground hover:text-foreground transition-all flex-shrink-0"
                      title="Send image"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
                    </button>
                    <button
                      onClick={() => setShowStickerPanel(v => !v)}
                      className={`p-1 rounded-lg transition-all flex-shrink-0 ${showStickerPanel ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}
                      title="Stickers"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" x2="9.01" y1="9" y2="9"/><line x1="15" x2="15.01" y1="9" y2="9"/></svg>
                    </button>
                    <div className="w-px h-5 bg-border flex-shrink-0" />
                    {["😂","❤️","👍","🔥","😮","👏","🤣","😭","✨","🙏"].map(em => (
                      <button key={em} onClick={() => setChatInput(p => p + em)} className="text-lg hover:scale-125 transition-transform flex-shrink-0">{em}</button>
                    ))}
                  </div>
                  {/* Row 2: text input + send button */}
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={chatInput}
                      onChange={e => setChatInput(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChatMessage(); } if (e.key === "Escape") { setReplyingTo(null); setShowStickerPanel(false); } }}
                      onFocus={() => setShowStickerPanel(false)}
                      placeholder="Type a message..."
                      maxLength={500}
                      className="flex-1 px-3 py-2.5 rounded-lg bg-muted border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                    />
                    <button onClick={sendChatMessage} disabled={!chatInput.trim()} className="p-2.5 rounded-lg bg-primary text-primary-foreground disabled:opacity-50 transition-all flex-shrink-0">
                      <Send className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Speaking notification */}
      {(() => {
        const speaking = members.filter(m => m.isOnline && (speakingState[m.id] ?? 0) > 15 && m.id !== myMemberId);
        if (speaking.length === 0) return null;
        return (
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-1 pointer-events-none">
            {speaking.slice(0, 3).map(m => {
              const vol = speakingState[m.id] ?? 0;
              return (
                <div key={m.id} className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/75 backdrop-blur-sm border border-white/10 text-white text-xs shadow-lg">
                  <div className="flex items-end gap-0.5 h-4">
                    {[0.4, 0.7, 1, 0.7, 0.4].map((mult, i) => (
                      <div key={i} className="w-0.5 bg-green-400 rounded-full transition-all duration-100" style={{ height: `${Math.max(2, Math.min(16, vol * mult * 0.16))}px` }} />
                    ))}
                  </div>
                  <span className="font-medium">{m.name}</span>
                </div>
              );
            })}
          </div>
        );
      })()}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*,.mkv"
        className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); e.target.value = ""; }}
      />

    </div>
    </>
  );
}