import { useState, useRef, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { useCreateRoom, useJoinRoom } from "@workspace/api-client-react";
import { saveSession, getSession } from "@/lib/storage";
import { Film, Users, Lock, ArrowRight, Loader2, Eye, EyeOff } from "lucide-react";

type Mode = "landing" | "create" | "join";
type Pose = "idle" | "pointing" | "coverEyes" | "peek" | "coverPassword" | "peekPassword";
type FocusedField = "none" | "roomName" | "hostName" | "password" | "name" | "code";

// ── Animation keyframes ────────────────────────────────────────────────────────
const ANIM_STYLES = `
  @keyframes ledSpin {
    to { transform: rotate(360deg); }
  }
  @keyframes charSlideIn {
    from { opacity: 0; transform: translateX(70px) scale(0.7) rotate(10deg); }
    to   { opacity: 1; transform: translateX(0)    scale(1)   rotate(0deg);  }
  }
  @keyframes charBob {
    0%, 100% { transform: translateY(0px);  }
    50%      { transform: translateY(-7px); }
  }
  @keyframes eyeBlink {
    0%, 88%, 100% { transform: scaleY(1);    }
    93%           { transform: scaleY(0.06); }
  }
  input[type="password"]::-ms-reveal,
  input[type="password"]::-ms-clear,
  input[type="password"]::-webkit-password-toggle-button,
  input[type="password"]::-webkit-credentials-auto-fill-button {
    display: none !important;
    width: 0;
    height: 0;
    visibility: hidden;
  }
`;

// ── CineBuddy character ────────────────────────────────────────────────────────
function CineBuddy({
  pose,
  field,
  pwdLength = 0,
  yPwd = 356,
}: {
  pose: Pose;
  field: FocusedField;
  pwdLength?: number;
  /** SVG-unit Y of the password input centre, measured dynamically */
  yPwd?: number;
}) {
  const RT = "transform 0.5s cubic-bezier(0.34,1.56,0.64,1)";
  const OT = "opacity 0.4s ease";
  const S   = 28;
  const L_R = 130;
  const L_L = 215;

  const isPointing  = pose === "pointing";
  const coveringPwd = pose === "coverPassword";
  const peekingPwd  = pose === "peekPassword";

  const longRight = (isPointing && (field === "roomName" || field === "code")) || coveringPwd;
  const longLeft  = (isPointing && (field === "hostName" || field === "name")) || coveringPwd;
  const closed    = pose === "coverEyes";

  // ── Arm geometry ── pivot at y=64, tip at password-input centre ────────────
  const Y_PWD  = yPwd;
  const dY_cov = Y_PWD - 64;

  const dX_covL = 22 - (-135);
  const LCovL   = Math.round(Math.sqrt(dX_covL ** 2 + dY_cov ** 2));
  const aCovL   = Math.atan2(dX_covL, dY_cov) * (180 / Math.PI);

  const CHAR_W  = 10;
  const X_cur   = pwdLength === 0
    ? -135
    : Math.min(-135 + (pwdLength - 1) * CHAR_W + CHAR_W / 2, 155);
  const dX_covR = 78 - X_cur;
  const LCovR   = Math.round(Math.sqrt(dX_covR ** 2 + dY_cov ** 2));
  const aCovR   = Math.atan2(dX_covR, dY_cov) * (180 / Math.PI);

  const aL =
    coveringPwd          ? aCovL :
    peekingPwd           ? -70   :
    longLeft             ?  15   :
    isPointing           ? -10   :
    pose === "coverEyes" ? 163   :
    pose === "peek"      ? 120   :
    -30;

  const aR =
    coveringPwd          ? aCovR :
    peekingPwd           ?  70   :
    longRight            ?  15   :
    isPointing           ? -10   :
    pose === "coverEyes" ? -163  :
    pose === "peek"      ? -120  :
    30;

  return (
    <svg
      viewBox="0 0 100 120"
      width="88"
      height="106"
      overflow="visible"
      aria-hidden="true"
      style={{
        animation: "charBob 2.6s ease-in-out infinite",
        filter: "drop-shadow(0 6px 20px rgba(99,102,241,0.5))",
      }}
    >
      <rect x="22" y="58" width="56" height="60" rx="14" fill="#4f46e5" />
      <rect x="32" y="67" width="36" height="16" rx="6" fill="#4338ca" />
      <circle cx="42" cy="75" r="3.5" fill="#818cf8" />
      <circle cx="50" cy="75" r="3.5" fill="#818cf8" />
      <circle cx="58" cy="75" r="3.5" fill="#818cf8" />

      <circle cx="50" cy="38" r="30" fill="#6366f1" />
      <circle cx="20" cy="37" r="8"   fill="#6366f1" />
      <circle cx="20" cy="37" r="4.5" fill="#818cf8" />
      <circle cx="80" cy="37" r="8"   fill="#6366f1" />
      <circle cx="80" cy="37" r="4.5" fill="#818cf8" />

      {closed ? (
        <>
          <path d="M 33 34 Q 38 41 43 34" stroke="white" strokeWidth="3" fill="none" strokeLinecap="round" />
          <path d="M 57 34 Q 62 41 67 34" stroke="white" strokeWidth="3" fill="none" strokeLinecap="round" />
        </>
      ) : (
        <>
          <ellipse cx="38" cy="33" rx="8" ry="9" fill="white"
            style={{ animation: "eyeBlink 3.8s ease-in-out infinite", transformOrigin: "38px 33px" }} />
          <ellipse cx="38" cy="34" rx="5" ry="6" fill="#1e1b4b" />
          <circle  cx="40" cy="31" r="2" fill="white" />
          <ellipse cx="62" cy="33" rx="8" ry="9" fill="white"
            style={{ animation: "eyeBlink 3.8s ease-in-out 0.25s infinite", transformOrigin: "62px 33px" }} />
          <ellipse cx="62" cy="34" rx="5" ry="6" fill="#1e1b4b" />
          <circle  cx="64" cy="31" r="2" fill="white" />
        </>
      )}

      {closed
        ? <path d="M 40 48 Q 50 44 60 48" stroke="white" strokeWidth="2.5" fill="none" strokeLinecap="round" />
        : <path d="M 37 47 Q 50 56 63 47" stroke="white" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      }

      <ellipse cx="24" cy="42" rx="6" ry="3.5" fill="#f9a8d4" opacity="0.55" />
      <ellipse cx="76" cy="42" rx="6" ry="3.5" fill="#f9a8d4" opacity="0.55" />

      {/* LEFT arm */}
      <g style={{ transform: `rotate(${aL}deg)`, transformOrigin: "22px 64px", transition: RT }}>
        <g style={{ opacity: !longLeft && !peekingPwd ? 1 : 0, transition: OT }}>
          <rect x="18" y="64" width="8" height={S} rx="4" fill="#6366f1" />
          <circle cx="22" cy={64 + S} r="7" fill="#818cf8" />
        </g>
        <g style={{ opacity: peekingPwd ? 1 : 0, transition: OT }}>
          <rect x="18" y="64" width="8" height={S} rx="4" fill="#6366f1" />
          <circle cx="22" cy={64 + S} r="7" fill="#818cf8" />
        </g>
        <g style={{ opacity: longLeft && !coveringPwd ? 1 : 0, transition: OT }}>
          <rect x="18" y="64" width="8" height={L_L} rx="4" fill="#6366f1" />
          <circle cx="22" cy={64 + L_L} r="7" fill="#818cf8" />
        </g>
        <g style={{ opacity: coveringPwd ? 1 : 0, transition: OT }}>
          <rect x="18" y="64" width="8" rx="4" fill="#6366f1"
            style={{ height: LCovL, transition: "height 0.45s ease" }} />
          <circle cx="22" r="30" fill="hsl(var(--input))" stroke="#818cf8" strokeWidth="3"
            style={{ cy: 64 + LCovL, transition: "cy 0.45s ease" } as React.CSSProperties} />
        </g>
      </g>

      {/* RIGHT arm */}
      <g style={{ transform: `rotate(${aR}deg)`, transformOrigin: "78px 64px", transition: RT }}>
        <g style={{ opacity: !longRight && !peekingPwd ? 1 : 0, transition: OT }}>
          <rect x="74" y="64" width="8" height={S} rx="4" fill="#6366f1" />
          <circle cx="78" cy={64 + S} r="7" fill="#818cf8" />
        </g>
        <g style={{ opacity: peekingPwd ? 1 : 0, transition: OT }}>
          <rect x="74" y="64" width="8" height={S} rx="4" fill="#6366f1" />
          <circle cx="78" cy={64 + S} r="7" fill="#818cf8" />
        </g>
        <g style={{ opacity: longRight && !coveringPwd ? 1 : 0, transition: OT }}>
          <rect x="74" y="64" width="8" height={L_R} rx="4" fill="#6366f1" />
          <circle cx="78" cy={64 + L_R} r="7" fill="#818cf8" />
        </g>
        <g style={{ opacity: coveringPwd ? 1 : 0, transition: OT }}>
          <rect x="74" y="64" width="8" rx="4" fill="#6366f1"
            style={{ height: LCovR, transition: "height 0.45s ease" }} />
          <circle cx="78" r="30" fill="hsl(var(--input))" stroke="#818cf8" strokeWidth="3"
            style={{ cy: 64 + LCovR, transition: "cy 0.45s ease" } as React.CSSProperties} />
        </g>
      </g>
    </svg>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function Home() {
  const [, setLocation] = useLocation();

  const pendingCode = (() => {
    try {
      const c = localStorage.getItem("wp_join_code") ?? "";
      localStorage.removeItem("wp_join_code");
      return c;
    } catch {
      return "";
    }
  })();

  const existingSession = pendingCode ? getSession(pendingCode) : null;

  const [mode, setMode]             = useState<Mode>(pendingCode ? "join" : "landing");
  const [createForm, setCreateForm] = useState({ roomName: "", hostName: "", password: "" });
  const [joinForm, setJoinForm]     = useState({ code: pendingCode, name: existingSession?.name ?? "", password: "" });
  const [error, setError]           = useState("");
  const [showPassword, setShowPassword]         = useState(false);
  const [showJoinPassword, setShowJoinPassword] = useState(false);
  const [focusedField, setFocusedField]         = useState<FocusedField>("none");

  // ── Dynamic Y_PWD ──────────────────────────────────────────────────────────
  //
  // Key insight: the SVG has a `charBob` CSS animation that moves it up/down by
  // 7px, making getBoundingClientRect() on the SVG element unreliable for
  // measuring the arm geometry.
  //
  // Instead we measure from the FORM CARD (which has no animation).
  // The form card always starts at exactly (SVG_height - marginBottom_overlap)
  // pixels below the SVG's layout top = 106 - 50 = 56px.
  // In SVG coordinate units: 56 × (120/106) ≈ 63.4
  //
  // Then:  Y_PWD = 63.4  +  (password_centre_from_card_top_px) × (120/106)
  //
  // Both the form card and the password input are stable (no CSS transforms),
  // so this measurement is accurate on every screen size.

  // SVG coordinate of the card top relative to SVG y=0
  const Y_CARD_SVG = 56 * (120 / 106); // ≈ 63.4 — constant, based on layout geometry

  const formCreateCardRef = useRef<HTMLDivElement>(null);
  const formJoinCardRef   = useRef<HTMLDivElement>(null);
  const pwdCreateRef      = useRef<HTMLInputElement>(null);
  const pwdJoinRef        = useRef<HTMLInputElement>(null);
  const [yPwd, setYPwd]   = useState(356);

  const measureYPwd = useCallback(() => {
    const card = mode === "create" ? formCreateCardRef.current : formJoinCardRef.current;
    const pwd  = mode === "create" ? pwdCreateRef.current      : pwdJoinRef.current;
    if (!card || !pwd) return;

    const cardBox = card.getBoundingClientRect();
    const pwdBox  = pwd.getBoundingClientRect();

    // Pixels from card top to password input vertical centre
    const distPx = (pwdBox.top + pwdBox.height / 2) - cardBox.top;

    setYPwd(Math.round(Y_CARD_SVG + distPx * (120 / 106)));
  }, [mode, Y_CARD_SVG]);

  // Measure once after the form is shown (wait for charSlideIn to finish)
  // and on every window/viewport resize (e.g. virtual keyboard opening)
  useEffect(() => {
    if (mode === "landing") return;

    // charSlideIn lasts 550ms; wait 600ms to let it settle before measuring
    const t = setTimeout(measureYPwd, 600);

    const onResize = () => measureYPwd();
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);

    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
    };
  }, [mode, measureYPwd]);

  // ── Derive character pose ───────────────────────────────────────────────────
  const currentShowPassword = mode === "create" ? showPassword : showJoinPassword;
  const currentPwdLength    = mode === "create" ? createForm.password.length : joinForm.password.length;

  const pose: Pose =
    focusedField === "password"
      ? currentShowPassword ? "peekPassword" : "coverPassword"
      : (focusedField === "roomName" || focusedField === "hostName" || focusedField === "name" || focusedField === "code")
        ? "pointing"
        : "idle";

  // ── API hooks ───────────────────────────────────────────────────────────────
  const createRoom = useCreateRoom({
    mutation: {
      onSuccess: (data) => {
        saveSession(data.room.code, data.sessionToken, data.member.role, data.member.name, data.member.id);
        setLocation(`/room/${data.room.code}`);
      },
      onError: (err: unknown) => {
        const e = err as { data?: { error?: string } };
        setError(e?.data?.error ?? "Failed to create room");
      },
    },
  });

  const joinRoom = useJoinRoom({
    mutation: {
      onSuccess: (data) => {
        saveSession(data.room.code, data.sessionToken, data.member.role, data.member.name, data.member.id);
        setLocation(`/room/${data.room.code}`);
      },
      onError: (err: unknown) => {
        const e = err as { data?: { error?: string } };
        setError(e?.data?.error ?? "Failed to join room");
      },
    },
  });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!createForm.roomName.trim() || !createForm.hostName.trim()) {
      setError("Room name and your name are required");
      return;
    }
    createRoom.mutate({
      data: {
        roomName: createForm.roomName.trim(),
        hostName: createForm.hostName.trim(),
        password: createForm.password || null,
      },
    });
  };

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!joinForm.code.trim() || !joinForm.name.trim()) {
      setError("Room code and your name are required");
      return;
    }
    const upperCode = joinForm.code.trim().toUpperCase();
    const existing  = getSession(upperCode);
    joinRoom.mutate({
      data: {
        code: upperCode,
        name: joinForm.name.trim(),
        password: joinForm.password || null,
        sessionToken: existing?.sessionToken ?? null,
      },
    });
  };

  const inputCls =
    "w-full px-4 py-2.5 rounded-lg bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm";

  const eyeBtnCls =
    "absolute right-2 top-1/2 -translate-y-1/2 bg-card border border-border rounded-md p-1 text-muted-foreground hover:text-foreground hover:border-primary/40 transition-all";

  return (
    <div
      className="bg-background flex flex-col items-center px-4 film-grain"
      style={{
        minHeight: "100dvh",
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
        justifyContent: mode === "landing" ? "center" : "flex-start",
        overflowY: mode === "landing" ? "hidden" : "auto",
      }}
    >
      <style>{ANIM_STYLES}</style>

      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-primary/5 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-64 h-64 bg-accent/5 rounded-full blur-3xl" />
      </div>

      <div className="relative z-10 w-full max-w-md" style={{ paddingTop: mode !== "landing" ? "16px" : 0, paddingBottom: mode !== "landing" ? "24px" : 0 }}>

        {mode === "landing" ? (
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 mb-4">
              <Film className="w-8 h-8 text-primary" />
            </div>
            <h1 className="text-4xl font-bold text-foreground tracking-tight">CineSync</h1>
            <p className="mt-2 text-muted-foreground text-sm">Watch together. In perfect sync.</p>
          </div>
        ) : (
          <div className="flex items-center gap-2 mb-4">
            <div className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10 border border-primary/20">
              <Film className="w-4 h-4 text-primary" />
            </div>
            <span className="text-lg font-bold text-foreground tracking-tight">CineSync</span>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════
            LANDING MODE
        ══════════════════════════════════════════════════════════ */}
        {mode === "landing" && (
          <div className="space-y-3">
            <div style={{ position: "relative", padding: "2px", borderRadius: "0.75rem", overflow: "hidden" }}>
              <div style={{
                position: "absolute", inset: "-100%",
                background: "conic-gradient(from 0deg, #6366f1, #a78bfa, #ec4899, #f97316, #22d3ee, #10b981, #6366f1)",
                animation: "ledSpin 2s linear infinite",
              }} />
              <button
                data-testid="button-create-room"
                onClick={() => { setMode("create"); setError(""); setFocusedField("none"); setShowPassword(false); }}
                style={{ position: "relative", borderRadius: "calc(0.75rem - 2px)" }}
                className="w-full flex items-center justify-between px-5 py-4 bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-all group"
              >
                <span className="flex items-center gap-3"><Film className="w-5 h-5" /> Create a Room</span>
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
              </button>
            </div>

            <div style={{ position: "relative", padding: "2px", borderRadius: "0.75rem", overflow: "hidden" }}>
              <div style={{
                position: "absolute", inset: "-100%",
                background: "conic-gradient(from 0deg, #6366f1, #a78bfa, #ec4899, #f97316, #22d3ee, #10b981, #6366f1)",
                animation: "ledSpin 2s linear infinite",
              }} />
              <button
                data-testid="button-join-room"
                onClick={() => { setMode("join"); setError(""); setFocusedField("none"); setShowJoinPassword(false); }}
                style={{ position: "relative", borderRadius: "calc(0.75rem - 2px)" }}
                className="w-full flex items-center justify-between px-5 py-4 bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-all group"
              >
                <span className="flex items-center gap-3"><Users className="w-5 h-5" /> Join a Room</span>
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
              </button>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════
            CREATE MODE
        ══════════════════════════════════════════════════════════ */}
        {mode === "create" && (
          <>
            <div className="flex items-center justify-between mb-3">
              <button
                onClick={() => { setMode("landing"); setError(""); setFocusedField("none"); }}
                className="text-muted-foreground hover:text-foreground text-sm flex items-center gap-1"
              >
                <ArrowRight className="w-3 h-3 rotate-180" /> Back
              </button>
              <h2 className="text-lg font-bold">Create a Room</h2>
            </div>

            <div
              className="flex justify-center"
              style={{
                animation: "charSlideIn 0.55s cubic-bezier(0.34,1.56,0.64,1) both",
                overflow: "visible",
                marginBottom: "-50px",
                position: "relative",
                zIndex: 10,
              }}
            >
              <CineBuddy pose={pose} field={focusedField} pwdLength={currentPwdLength} yPwd={yPwd} />
            </div>

            {/* ref on the card — used as stable anchor for Y_PWD measurement */}
            <div ref={formCreateCardRef} className="bg-card border border-border rounded-2xl px-5 pb-5" style={{ paddingTop: "64px" }}>
              <form onSubmit={handleCreate} className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-1.5">Room Name</label>
                  <input
                    data-testid="input-room-name"
                    type="text"
                    maxLength={50}
                    value={createForm.roomName}
                    onChange={(e) => setCreateForm((f) => ({ ...f, roomName: e.target.value }))}
                    onFocus={() => setFocusedField("roomName")}
                    onBlur={() => setFocusedField("none")}
                    placeholder="Movie Night"
                    className={inputCls}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-1.5">Your Name</label>
                  <input
                    data-testid="input-host-name"
                    type="text"
                    maxLength={30}
                    value={createForm.hostName}
                    onChange={(e) => setCreateForm((f) => ({ ...f, hostName: e.target.value }))}
                    onFocus={() => setFocusedField("hostName")}
                    onBlur={() => setFocusedField("none")}
                    placeholder="Alex"
                    className={inputCls}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-1.5">
                    <span className="flex items-center gap-1.5"><Lock className="w-3 h-3" /> Password (optional)</span>
                  </label>
                  <div className="relative">
                    <input
                      ref={pwdCreateRef}
                      data-testid="input-create-password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="new-password"
                      value={createForm.password}
                      onChange={(e) => setCreateForm((f) => ({ ...f, password: e.target.value }))}
                      onFocus={() => { measureYPwd(); setFocusedField("password"); }}
                      onBlur={() => setFocusedField("none")}
                      placeholder="Leave empty for public room"
                      className={inputCls + " pr-11"}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      onMouseDown={(e) => e.preventDefault()}
                      className={eyeBtnCls}
                      tabIndex={-1}
                      aria-label={showPassword ? "Hide password" : "Show password"}
                    >
                      {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>

                {error && <p className="text-destructive text-sm">{error}</p>}

                <button
                  data-testid="button-submit-create"
                  type="submit"
                  disabled={createRoom.isPending}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-primary text-primary-foreground font-semibold hover:bg-primary/90 disabled:opacity-50 transition-all"
                >
                  {createRoom.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  Create Room
                </button>
              </form>
            </div>
          </>
        )}

        {/* ══════════════════════════════════════════════════════════
            JOIN MODE
        ══════════════════════════════════════════════════════════ */}
        {mode === "join" && (
          <>
            <div className="flex items-center justify-between mb-3">
              <button
                onClick={() => { setMode("landing"); setError(""); setFocusedField("none"); }}
                className="text-muted-foreground hover:text-foreground text-sm flex items-center gap-1"
              >
                <ArrowRight className="w-3 h-3 rotate-180" /> Back
              </button>
              <h2 className="text-lg font-bold">Join a Room</h2>
            </div>

            <div
              className="flex justify-center"
              style={{
                animation: "charSlideIn 0.55s cubic-bezier(0.34,1.56,0.64,1) both",
                overflow: "visible",
                marginBottom: "-50px",
                position: "relative",
                zIndex: 10,
              }}
            >
              <CineBuddy pose={pose} field={focusedField} pwdLength={currentPwdLength} yPwd={yPwd} />
            </div>

            {/* ref on the card — used as stable anchor for Y_PWD measurement */}
            <div ref={formJoinCardRef} className="bg-card border border-border rounded-2xl px-5 pb-5" style={{ paddingTop: "64px" }}>
              <form onSubmit={handleJoin} className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-1.5">Room Code</label>
                  <input
                    data-testid="input-room-code"
                    type="text"
                    maxLength={6}
                    value={joinForm.code}
                    onChange={(e) => {
                      const newCode = e.target.value.toUpperCase();
                      const session = getSession(newCode);
                      setJoinForm((f) => ({ ...f, code: newCode, name: session?.name ?? f.name }));
                    }}
                    onFocus={() => setFocusedField("code")}
                    onBlur={() => setFocusedField("none")}
                    placeholder="ABC123"
                    className={inputCls + " font-mono tracking-widest uppercase"}
                  />
                </div>

                {(() => {
                  const lockedSession = getSession(joinForm.code.trim().toUpperCase());
                  return (
                    <div>
                      <label className="block text-sm font-medium text-muted-foreground mb-1.5 flex items-center gap-1.5">
                        Your Name
                        {lockedSession && <Lock className="w-3 h-3 text-primary" />}
                      </label>
                      <input
                        data-testid="input-join-name"
                        type="text"
                        maxLength={30}
                        value={joinForm.name}
                        readOnly={!!lockedSession}
                        onChange={(e) => { if (!lockedSession) setJoinForm((f) => ({ ...f, name: e.target.value })); }}
                        onFocus={() => { if (!lockedSession) setFocusedField("name"); }}
                        onBlur={() => setFocusedField("none")}
                        placeholder="Alex"
                        className={`w-full px-4 py-2.5 rounded-lg border text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 ${
                          lockedSession
                            ? "bg-muted border-primary/30 cursor-not-allowed select-none"
                            : "bg-input border-border placeholder:text-muted-foreground"
                        }`}
                      />
                      {lockedSession && (
                        <p className="text-xs text-muted-foreground mt-1">
                          Returning as a previous member of this room
                        </p>
                      )}
                    </div>
                  );
                })()}

                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-1.5">
                    <span className="flex items-center gap-1.5"><Lock className="w-3 h-3" /> Password (if required)</span>
                  </label>
                  <div className="relative">
                    <input
                      ref={pwdJoinRef}
                      data-testid="input-join-password"
                      type={showJoinPassword ? "text" : "password"}
                      autoComplete="current-password"
                      value={joinForm.password}
                      onChange={(e) => setJoinForm((f) => ({ ...f, password: e.target.value }))}
                      onFocus={() => { measureYPwd(); setFocusedField("password"); }}
                      onBlur={() => setFocusedField("none")}
                      placeholder="Enter room password"
                      className={inputCls + " pr-11"}
                    />
                    <button
                      type="button"
                      onClick={() => setShowJoinPassword((v) => !v)}
                      onMouseDown={(e) => e.preventDefault()}
                      className={eyeBtnCls}
                      tabIndex={-1}
                      aria-label={showJoinPassword ? "Hide password" : "Show password"}
                    >
                      {showJoinPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>

                {error && <p className="text-destructive text-sm">{error}</p>}

                <button
                  data-testid="button-submit-join"
                  type="submit"
                  disabled={joinRoom.isPending}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-primary text-primary-foreground font-semibold hover:bg-primary/90 disabled:opacity-50 transition-all"
                >
                  {joinRoom.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  Join Room
                </button>
              </form>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
