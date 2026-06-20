import { useState, useEffect } from "react";
import { useRoute, useLocation } from "wouter";
import { Film, Lock, ArrowRight, Loader2, Users, AlertCircle, Eye, EyeOff } from "lucide-react";
import { saveSession, getSession } from "@/lib/storage";

interface RoomInfo {
  id: number;
  code: string;
  name: string;
  hasPassword: boolean;
}

type Pose = "idle" | "pointing" | "coverEyes" | "peek" | "coverPassword" | "peekPassword";
type FocusedField = "none" | "name" | "password";

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
    width: 0; height: 0; visibility: hidden;
  }
`;

function CineBuddy({ pose, field, pwdLength = 0 }: { pose: Pose; field: FocusedField; pwdLength?: number }) {
  const RT = "transform 0.5s cubic-bezier(0.34,1.56,0.64,1)";
  const OT = "opacity 0.4s ease";
  const S   = 28;
  const L_R = 130;
  const L_L = 215;

  const isPointing  = pose === "pointing";
  const coveringPwd = pose === "coverPassword";
  const peekingPwd  = pose === "peekPassword";

  // invite.tsx: "name" is the TOP field — use shorter right arm (L_R=130).
  // longLeft is only used when covering password.
  const longRight = (isPointing && field === "name") || coveringPwd;
  const longLeft  = coveringPwd;
  const closed    = pose === "coverEyes";

  // Y_PWD calibrated for invite.tsx: password input is ~220 SVG units below arm pivot
  // (arm pivot at SVG y=64, form paddingTop=64px, name input ~52px, gap ~12px, label ~20px, input center ~26px)
  const Y_PWD  = 284;
  const dY_cov = Y_PWD - 64;

  // Left arm: FIXED at left edge of input — stays put as anchor.
  const dX_covL = 22 - (-135);
  const LCovL   = Math.round(Math.sqrt(dX_covL ** 2 + dY_cov ** 2));
  const aCovL   = Math.atan2(dX_covL, dY_cov) * (180 / Math.PI);

  // Right arm: circle center ON the last typed character.
  // charWidth ≈ 10 SVG units (password dots are small), half = 5.
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
          <circle  cx="40" cy="31" r="2"          fill="white" />
          <ellipse cx="62" cy="33" rx="8" ry="9" fill="white"
            style={{ animation: "eyeBlink 3.8s ease-in-out 0.25s infinite", transformOrigin: "62px 33px" }} />
          <ellipse cx="62" cy="34" rx="5" ry="6" fill="#1e1b4b" />
          <circle  cx="64" cy="31" r="2"          fill="white" />
        </>
      )}

      {closed
        ? <path d="M 40 48 Q 50 44 60 48" stroke="white" strokeWidth="2.5" fill="none" strokeLinecap="round" />
        : <path d="M 37 47 Q 50 56 63 47" stroke="white" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      }

      <ellipse cx="24" cy="42" rx="6" ry="3.5" fill="#f9a8d4" opacity="0.55" />
      <ellipse cx="76" cy="42" rx="6" ry="3.5" fill="#f9a8d4" opacity="0.55" />

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

export default function Invite() {
  const [, params] = useRoute("/invite/:code");
  const code = params?.code?.toUpperCase() ?? "";
  const [, setLocation] = useLocation();

  const [room, setRoom] = useState<RoomInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [joining, setJoining] = useState(false);
  const [focusedField, setFocusedField] = useState<FocusedField>("none");

  const pose: Pose =
    focusedField === "password"
      ? showPassword ? "peekPassword" : "coverPassword"
      : focusedField === "name"
        ? "pointing"
        : "idle";

  const showCharacter = true;

  useEffect(() => {
    if (!code) return;
    fetch(`/api/rooms/${code}`)
      .then(r => r.json())
      .then((data: RoomInfo & { error?: string }) => {
        if (data.error || !data.name) setNotFound(true);
        else setRoom(data);
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [code]);

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!name.trim()) { setError("Please enter your name"); return; }
    if (room?.hasPassword && !password.trim()) { setError("This room requires a password"); return; }

    setJoining(true);
    try {
      const existing = getSession(code);
      const res = await fetch("/api/rooms/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          name: name.trim(),
          password: password || null,
          sessionToken: existing?.sessionToken ?? null,
        }),
      });
      const data = await res.json() as {
        room?: { code: string };
        member?: { id: number; role: string; name: string };
        sessionToken?: string;
        error?: string;
      };
      if (!res.ok || !data.room || !data.member || !data.sessionToken) {
        setError(data.error ?? "Failed to join room");
        return;
      }
      saveSession(data.room.code, data.sessionToken, data.member.role, data.member.name, data.member.id);
      setLocation(`/room/${data.room.code}`);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setJoining(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
        <div className="text-center max-w-sm">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-destructive/10 border border-destructive/20 mb-4">
            <AlertCircle className="w-8 h-8 text-destructive" />
          </div>
          <h1 className="text-2xl font-bold text-foreground mb-2">Room Not Found</h1>
          <p className="text-muted-foreground text-sm mb-6">This invite link is invalid or the room has been closed.</p>
          <button
            onClick={() => setLocation("/")}
            className="px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all"
          >
            Go to Home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4 film-grain">
      <style>{ANIM_STYLES}</style>

      {/* Background blobs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-primary/5 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-64 h-64 bg-accent/5 rounded-full blur-3xl" />
      </div>

      <div className="relative z-10 w-full max-w-sm">
        {/* Brand header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 mb-3">
            <Film className="w-7 h-7 text-primary" />
          </div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-widest mb-1">CineSync</p>
          <h1 className="text-2xl font-bold text-foreground">You're invited!</h1>
        </div>

        {/* Room card — LED spinning border */}
        <div className="mb-5" style={{ position: "relative", padding: "2px", borderRadius: "1rem", overflow: "hidden" }}>
          <div style={{
            position: "absolute",
            inset: "-100%",
            background: "conic-gradient(from 0deg, #6366f1, #a78bfa, #ec4899, #f97316, #22d3ee, #10b981, #6366f1)",
            animation: "ledSpin 2s linear infinite",
          }} />
          <div
            className="bg-card shadow-lg"
            style={{ position: "relative", borderRadius: "calc(1rem - 2px)", padding: "20px" }}
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
                <Users className="w-5 h-5 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground mb-0.5">Watch party room</p>
                <h2 className="text-lg font-bold text-foreground truncate">{room?.name}</h2>
              </div>
            </div>
            {room?.hasPassword && (
              <div className="mt-3 flex items-center gap-1.5 text-xs text-amber-400">
                <Lock className="w-3 h-3" />
                <span>Password protected</span>
              </div>
            )}
          </div>
        </div>

        {/* Character — slides in when a field is focused, overlaps form below */}
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            overflow: "visible",
            marginBottom: "-50px",
            position: "relative",
            zIndex: 10,
            pointerEvents: "none",
          }}
        >
          <CineBuddy pose={pose} field={focusedField} pwdLength={password.length} />
        </div>

        {/* Join form card */}
        <div
          className="bg-card border border-border rounded-2xl px-5 pb-5 shadow-lg"
          style={{ paddingTop: "64px" }}
        >
          <form onSubmit={handleJoin} className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1.5">Your name</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                onFocus={() => setFocusedField("name")}
                onBlur={() => setFocusedField("none")}
                placeholder="Enter your display name"
                maxLength={32}
                autoFocus
                className="w-full px-4 py-3 rounded-xl bg-muted border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all"
              />
            </div>

            {room?.hasPassword && (
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Room password</label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    onFocus={() => setFocusedField("password")}
                    onBlur={() => setFocusedField("none")}
                    placeholder="Enter room password"
                    className="w-full px-4 py-3 pr-11 rounded-xl bg-muted border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all"
                  />
                  <button
                    type="button"
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => setShowPassword(v => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 bg-card border border-border rounded-md p-1 text-muted-foreground hover:text-foreground hover:border-primary/40 transition-all"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            )}

            {error && (
              <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-xs">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={joining}
              className="w-full flex items-center justify-between px-5 py-3.5 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 transition-all group disabled:opacity-60"
            >
              <span>{joining ? "Joining..." : "Join Watch Party"}</span>
              {joining
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
              }
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-muted-foreground mt-4">
          Room code: <code className="font-mono font-bold text-foreground">{code}</code>
        </p>
      </div>
    </div>
  );
}
