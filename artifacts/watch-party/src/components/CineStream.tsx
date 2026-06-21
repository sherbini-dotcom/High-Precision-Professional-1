import { useState, useEffect, useRef, useCallback } from "react";
import {
  Search, Film, Tv, Play, X, ChevronLeft, ChevronRight,
  Star, TrendingUp, Calendar, ArrowRight, Loader2, Server,
} from "lucide-react";

// ─── Inline utils ─────────────────────────────────────────────────────────────

function posterUrl(path: string | null, size: "w185" | "w300" | "w500" = "w300"): string {
  if (!path) return `https://placehold.co/300x450/18181b/52525b?text=—`;
  return `https://image.tmdb.org/t/p/${size}${path}`;
}

function backdropUrl(path: string | null | undefined): string {
  if (!path) return "";
  return `https://image.tmdb.org/t/p/w1280${path}`;
}

function formatRating(r: number): string {
  return r ? r.toFixed(1) : "—";
}

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface TmdbItem {
  id: number;
  title?: string;
  name?: string;
  poster_path: string | null;
  backdrop_path?: string | null;
  vote_average: number;
  release_date?: string;
  first_air_date?: string;
  overview: string;
  media_type?: string;
}

interface SeasonDetail {
  season_number: number;
  episode_count: number;
  name: string;
}

export interface CineState {
  view: "browse" | "player";
  contentType: "movie" | "tv";
  category: "popular" | "top_rated";
  searchQuery: string;
  selectedItem: TmdbItem | null;
  season: number;
  episode: number;
}

interface CineStreamProps {
  isPrivileged: boolean;
  currentState: CineState;
  onNavigate: (state: CineState) => void;
  // ── Server sync (FIX: كانت هذه الـ props مُمررة من room.tsx لكن غير مستخدمة هنا،
  // فاختيار السيرفر كان يتغير محلياً عند الهوست فقط ولا يصل للضيوف أبداً) ──
  directUrl?: string;
  subtitleUrl?: string;
  onDirectUrlChange?: (url: string) => void;
  onSubtitleChange?: (url: string) => void;
  // غير مستخدمة حالياً داخل هذا الكومبوننت — مقبولة فقط لتفادي أخطاء TypeScript
  // لأن room.tsx يمررها بالفعل (مُعدّة لاستخدام مستقبلي عبر embed-proxy)
  socket?: unknown;
  roomCode?: string;
  sessionToken?: string;
}

export const DEFAULT_CINE_STATE: CineState = {
  view: "browse",
  contentType: "movie",
  category: "popular",
  searchQuery: "",
  selectedItem: null,
  season: 1,
  episode: 1,
};

const TMDB_KEY = "fac9dcacf0da4bba9c5a4c70fa8bfece";
const TMDB = "https://api.themoviedb.org/3";

// ─── Server definitions ───────────────────────────────────────────────────────

interface VideoServer {
  id: string;
  name: string;
  color: string;
  buildUrl: (tmdbId: number, type: "movie" | "tv", season: number, episode: number, imdbId?: string) => string;
  needsImdb?: boolean;
}

const VIDEO_SERVERS: VideoServer[] = [
  {
    id: "videasy",
    name: "Videasy",
    color: "from-red-500 to-rose-600",
    buildUrl: (tmdbId, type, season, episode) =>
      type === "movie"
        ? `https://player.videasy.net/movie/${tmdbId}`
        : `https://player.videasy.net/tv/${tmdbId}/${season}/${episode}`,
  },
  {
    id: "smashystream",
    name: "SmashyStream",
    color: "from-orange-500 to-amber-600",
    buildUrl: (tmdbId, type, season, episode) =>
      type === "movie"
        ? `https://embed.smashystream.com/playere.php?tmdb=${tmdbId}`
        : `https://embed.smashystream.com/playere.php?tmdb=${tmdbId}&season=${season}&episode=${episode}`,
  },
  {
    id: "playimdb",
    name: "PlayIMDB",
    color: "from-yellow-500 to-orange-500",
    needsImdb: true,
    buildUrl: (_tmdbId, _type, _season, _episode, imdbId) =>
      imdbId ? `https://www.playimdb.com/title/${imdbId}` : "",
  },
];

// ─── Poster Card (browse grid) ────────────────────────────────────────────────

function PosterCard({
  item, contentType, isActive, canControl, onSelect,
}: {
  item: TmdbItem;
  contentType: "movie" | "tv";
  isActive: boolean;
  canControl: boolean;
  onSelect: () => void;
}) {
  const type: "movie" | "tv" =
    item.media_type === "tv" ? "tv" : contentType === "tv" ? "tv" : "movie";
  const title = item.title ?? item.name ?? "";
  const year = new Date(item.release_date ?? item.first_air_date ?? "").getFullYear() || null;

  return (
    <div
      onClick={canControl ? onSelect : undefined}
      className={`group relative rounded-xl overflow-hidden bg-zinc-900 transition-all duration-300 ${
        canControl ? "cursor-pointer hover:scale-105 hover:shadow-2xl hover:shadow-black/60 hover:z-10" : "cursor-default"
      } ${isActive ? "ring-2 ring-red-500" : ""}`}
    >
      <div className="aspect-[2/3] relative overflow-hidden">
        <img
          src={posterUrl(item.poster_path, "w300")}
          alt={title}
          className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
          loading="lazy"
        />
        {canControl && (
          <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-end p-2.5">
            <p className="text-white text-[10px] leading-relaxed line-clamp-4">{item.overview}</p>
          </div>
        )}
        {canControl && (
          <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300">
            <div className="bg-white/20 backdrop-blur-sm p-3 rounded-full border border-white/30">
              <Play className="w-5 h-5 text-white fill-white" />
            </div>
          </div>
        )}
        <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 bg-black/70 backdrop-blur-sm px-1.5 py-0.5 rounded-md">
          <Star className="w-2.5 h-2.5 text-yellow-400 fill-yellow-400" />
          <span className="text-white text-[10px] font-bold">{formatRating(item.vote_average)}</span>
        </div>
        <div className="absolute top-1.5 left-1.5">
          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-md ${type === "movie" ? "bg-blue-500/80 text-white" : "bg-violet-500/80 text-white"}`}>
            {type === "movie" ? "فيلم" : "مسلسل"}
          </span>
        </div>
        {isActive && (
          <div className="absolute inset-0 bg-red-500/20 flex items-center justify-center">
            <div className="bg-red-500 p-2 rounded-full">
              <Play className="w-4 h-4 text-white fill-white" />
            </div>
          </div>
        )}
      </div>
      <div className="p-2">
        <h3 className="text-white text-xs font-semibold truncate">{title}</h3>
        {year && <p className="text-zinc-500 text-[10px] mt-0.5">{year}</p>}
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="rounded-xl overflow-hidden bg-zinc-900">
      <div className="aspect-[2/3] bg-zinc-800 animate-pulse" />
      <div className="p-2 space-y-1.5">
        <div className="h-3 w-4/5 bg-zinc-800 rounded animate-pulse" />
        <div className="h-3 w-2/5 bg-zinc-800 rounded animate-pulse" />
      </div>
    </div>
  );
}

// ─── Embed Player (iframe) ────────────────────────────────────────────────────

function EmbedPlayer({ url, isPrivileged }: { url: string; isPrivileged: boolean }) {
  // Videasy detects sandbox and breaks — skip sandbox for it
  const isVideasy = url.includes("videasy");
  const sandboxProps = isVideasy ? {} : {
    sandbox: "allow-scripts allow-same-origin allow-pointer-lock allow-presentation allow-orientation-lock" as const,
  };

  return (
    <div
      className="relative bg-black w-full flex-shrink-0"
      style={{ aspectRatio: "16/9" }}
    >
      <iframe
        key={url}
        src={url}
        className="w-full h-full border-0"
        allowFullScreen
        allow="autoplay; fullscreen *; encrypted-media; picture-in-picture"
        referrerPolicy="origin"
        title="Video Player"
        {...sandboxProps}
      />
      {!isPrivileged && (
        <div className="absolute top-2 left-2 bg-black/60 backdrop-blur-sm px-2 py-1 rounded-lg border border-white/10 pointer-events-none">
          <p className="text-zinc-400 text-[10px]">مشاهدة فقط</p>
        </div>
      )}
    </div>
  );
}

// ─── Star Rating Display ──────────────────────────────────────────────────────

function StarRating({ value }: { value: number }) {
  const filled = Math.round(value / 2);
  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: 5 }, (_, i) => (
        <Star
          key={i}
          className={`w-3 h-3 ${i < filled ? "text-yellow-400 fill-yellow-400" : "text-zinc-600 fill-zinc-600"}`}
        />
      ))}
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────────

export default function CineStream({
  isPrivileged,
  currentState,
  onNavigate,
  directUrl,
  onDirectUrlChange,
}: CineStreamProps) {
  const [items, setItems] = useState<TmdbItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [localSearch, setLocalSearch] = useState("");
  const [seasons, setSeasons] = useState<SeasonDetail[]>([]);
  const [loadingSeasons, setLoadingSeasons] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  // Server picker state
  const [imdbId, setImdbId] = useState<string | null>(null);
  const [loadingImdb, setLoadingImdb] = useState(false);
  const [fetchingServerId, setFetchingServerId] = useState<string | null>(null);
  const [customUrl, setCustomUrl] = useState("");

  // FIX: الرابط النشط بقى مشتق من الـ prop المُزامَنة (directUrl) بدل state محلي —
  // ده اللي بيخلي كل أعضاء الغرفة يشوفوا نفس السيرفر اللي اختاره الهوست
  const activeEmbedUrl = directUrl && directUrl.length > 0 ? directUrl : null;

  // تحديد أي سيرفر نشط بناءً على الـ domain الموجود في الرابط الحالي —
  // يشتغل صح سواء عند الهوست (اللي اختار) أو عند الضيف (اللي استقبل المزامنة)
  const activeServerId = (() => {
    if (!activeEmbedUrl) return null;
    try {
      const host = new URL(activeEmbedUrl).hostname.replace(/^www\./, "");
      const known = VIDEO_SERVERS.find((s) => {
        const sampleHost = (() => {
          try { return new URL(s.buildUrl(0, "movie", 1, 1, "tt0000000")).hostname.replace(/^www\./, ""); }
          catch { return ""; }
        })();
        return sampleHost && host === sampleHost;
      });
      return known?.id ?? "custom";
    } catch {
      return "custom";
    }
  })();

  const gridRef = useRef<HTMLDivElement>(null);

  const { view, contentType, category, searchQuery, selectedItem, season, episode } = currentState;

  const debouncedSearch = useDebounce(localSearch, 450);

  useEffect(() => { setLocalSearch(searchQuery); }, [searchQuery]);
  useEffect(() => { setPage(1); }, [contentType, category, searchQuery]);

  // Reset local imdbId cache when item/season/episode changes.
  // (activeEmbedUrl/activeServerId اتشالوا من هنا لأنهم بقوا مشتقين من directUrl
  // المُزامَن — مش محتاجين useEffect يصفّرهم يدوياً)
  useEffect(() => {
    setImdbId(null);
  }, [selectedItem?.id, season, episode]);

  const fetchBrowse = useCallback(async () => {
    if (view === "player" || searchQuery) return;
    setLoading(true);
    setItems([]);
    try {
      const path = category === "popular" ? "popular" : "top_rated";
      const res = await fetch(`${TMDB}/${contentType}/${path}?api_key=${TMDB_KEY}&language=ar&page=${page}`);
      const data = await res.json();
      setItems(data.results ?? []);
      setTotalPages(Math.min(data.total_pages ?? 1, 20));
    } catch { setItems([]); } finally { setLoading(false); }
  }, [contentType, category, view, searchQuery, page]);

  const fetchSearch = useCallback(async () => {
    if (!searchQuery) return;
    setLoading(true);
    setItems([]);
    try {
      const res = await fetch(`${TMDB}/search/multi?api_key=${TMDB_KEY}&language=ar&query=${encodeURIComponent(searchQuery)}&page=${page}`);
      const data = await res.json();
      const filtered = (data.results ?? []).filter((i: TmdbItem) => i.media_type === "movie" || i.media_type === "tv");
      setItems(filtered);
      setTotalPages(Math.min(data.total_pages ?? 1, 20));
    } catch { setItems([]); } finally { setLoading(false); }
  }, [searchQuery, page]);

  useEffect(() => { fetchBrowse(); }, [fetchBrowse]);
  useEffect(() => { fetchSearch(); }, [fetchSearch]);

  useEffect(() => {
    if (!isPrivileged) return;
    const trimmed = debouncedSearch.trim();
    if (trimmed === searchQuery) return;
    nav({ searchQuery: trimmed, view: "browse" });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  useEffect(() => {
    if (!selectedItem || view !== "player" || contentType !== "tv") { setSeasons([]); return; }
    setLoadingSeasons(true);
    fetch(`${TMDB}/tv/${selectedItem.id}?api_key=${TMDB_KEY}&language=ar`)
      .then((r) => r.json())
      .then((data) => setSeasons((data.seasons ?? []).filter((s: SeasonDetail) => s.season_number > 0)))
      .catch(() => {})
      .finally(() => setLoadingSeasons(false));
  }, [selectedItem?.id, view, contentType]);

  const nav = (patch: Partial<CineState>) => {
    if (!isPrivileged) return;
    onNavigate({ ...currentState, ...patch });
  };

  const handleSelectItem = (item: TmdbItem) => {
    if (!isPrivileged) return;
    const type: "movie" | "tv" = item.media_type === "tv" ? "tv" : contentType === "tv" ? "tv" : "movie";
    nav({ selectedItem: item, view: "player", contentType: type, season: 1, episode: 1 });
  };

  const handleBack = () => nav({ view: "browse", selectedItem: null });
  const handleContentType = (type: "movie" | "tv") =>
    nav({ contentType: type, category: "popular", searchQuery: "", view: "browse", selectedItem: null });
  const handleCategory = (cat: "popular" | "top_rated") =>
    nav({ category: cat, searchQuery: "", view: "browse" });

  // Fetch IMDB ID
  const getImdbId = async (tmdbId: number, type: "movie" | "tv"): Promise<string | null> => {
    if (imdbId) return imdbId;
    setLoadingImdb(true);
    try {
      const res = await fetch(`${TMDB}/${type}/${tmdbId}/external_ids?api_key=${TMDB_KEY}`);
      const data = await res.json();
      const id = data.imdb_id ?? null;
      setImdbId(id);
      return id;
    } catch {
      return null;
    } finally {
      setLoadingImdb(false);
    }
  };

  const handleNextServer = async () => {
    if (!selectedItem) return;
    const currentIndex = VIDEO_SERVERS.findIndex(s => s.id === activeServerId);
    const nextServer = VIDEO_SERVERS[(currentIndex + 1) % VIDEO_SERVERS.length];
    await handlePickServer(nextServer);
  };

  const handlePickServer = async (server: VideoServer) => {
    if (!isPrivileged || !selectedItem) return;
    setFetchingServerId(server.id);
    try {
      let url: string;
      if (server.needsImdb) {
        const id = await getImdbId(selectedItem.id, contentType);
        if (!id) { alert("تعذر الحصول على معرف IMDB لهذا المحتوى"); return; }
        url = server.buildUrl(selectedItem.id, contentType, season, episode, id);
        if (!url) { alert("تعذر بناء رابط السيرفر"); return; }
      } else {
        url = server.buildUrl(selectedItem.id, contentType, season, episode);
      }
      // FIX: بث اختيار السيرفر لباقي أعضاء الغرفة عبر الـ socket (موجود فعلاً
      // في room.tsx وموصّل بحدث moviesDirectUrl) بدل حفظه محلياً فقط
      onDirectUrlChange?.(url);
    } finally {
      setFetchingServerId(null);
    }
  };

  const selectedSeasonData = seasons.find((s) => s.season_number === season);

  // ─── Player View ────────────────────────────────────────────────────────────

  if (view === "player" && selectedItem) {
    const title = selectedItem.title ?? selectedItem.name ?? "";
    const year = new Date(selectedItem.release_date ?? selectedItem.first_air_date ?? "").getFullYear() || null;
    const backdrop = backdropUrl(selectedItem.backdrop_path);
    const isTV = contentType === "tv";

    return (
      <div className="flex-1 min-h-0 flex flex-col overflow-y-auto bg-[#0d0d12] text-white" dir="rtl">

        {/* CINEMATIC HERO */}
        <div className="relative w-full flex-shrink-0" style={{ minHeight: 260 }}>
          {backdrop ? (
            <>
              <img
                src={backdrop}
                alt=""
                className="absolute inset-0 w-full h-full object-cover object-top"
                style={{ opacity: 0.35 }}
              />
              <div className="absolute inset-0 bg-gradient-to-t from-[#0d0d12] via-[#0d0d12]/70 to-transparent" />
              <div className="absolute inset-0 bg-gradient-to-r from-[#0d0d12]/90 via-[#0d0d12]/30 to-transparent" />
              <div className="absolute top-0 inset-x-0 h-16 bg-gradient-to-b from-[#0d0d12]/60 to-transparent" />
            </>
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-zinc-900 via-zinc-900 to-[#0d0d12]" />
          )}

          {isPrivileged && (
            <button
              onClick={handleBack}
              className="absolute top-3 right-3 z-30 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-black/40 hover:bg-black/70 backdrop-blur-xl border border-white/10 text-white transition-all duration-200 active:scale-95"
            >
              <ArrowRight className="w-3.5 h-3.5" />
              <span className="text-xs font-medium">رجوع</span>
            </button>
          )}

          <div className="relative z-10 flex gap-3.5 px-4 pt-14 pb-5">
            <div className="flex-shrink-0 relative">
              <div className="absolute -inset-1 rounded-2xl bg-gradient-to-b from-white/10 to-transparent blur-sm" />
              <div
                className="relative w-[88px] rounded-2xl overflow-hidden shadow-2xl border border-white/10"
                style={{ aspectRatio: "2/3" }}
              >
                <img
                  src={posterUrl(selectedItem.poster_path, "w185")}
                  alt={title}
                  className="w-full h-full object-cover"
                />
              </div>
            </div>

            <div className="flex-1 min-w-0 flex flex-col justify-end pb-1 gap-1.5">
              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${
                  isTV
                    ? "bg-violet-500/25 border border-violet-500/40 text-violet-300"
                    : "bg-blue-500/25 border border-blue-500/40 text-blue-300"
                }`}>
                  {isTV ? <Tv className="w-2.5 h-2.5" /> : <Film className="w-2.5 h-2.5" />}
                  {isTV ? "مسلسل" : "فيلم"}
                </span>
                {!isPrivileged && (
                  <span className="text-[10px] bg-zinc-800/80 border border-zinc-700/60 text-zinc-500 px-2 py-0.5 rounded-full">
                    مشاهدة فقط
                  </span>
                )}
              </div>

              <h1 className="text-[22px] font-black leading-tight tracking-tight drop-shadow-xl">
                {title}
              </h1>

              <div className="flex items-center gap-3">
                <StarRating value={selectedItem.vote_average} />
                <span className="text-yellow-400 text-xs font-bold tabular-nums">
                  {formatRating(selectedItem.vote_average)}
                </span>
                <span className="text-zinc-600 text-xs">•</span>
                {year && (
                  <div className="flex items-center gap-1 text-zinc-400">
                    <Calendar className="w-3 h-3" />
                    <span className="text-xs tabular-nums">{year}</span>
                  </div>
                )}
                {isTV && selectedSeasonData && (
                  <>
                    <span className="text-zinc-600 text-xs">•</span>
                    <span className="text-xs text-zinc-400">
                      S{season} E{episode}
                    </span>
                  </>
                )}
              </div>

              {selectedItem.overview && (
                <p className="text-zinc-400 text-[11px] leading-relaxed line-clamp-2 mt-0.5">
                  {selectedItem.overview}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* PLAYER AREA */}
        {activeEmbedUrl ? (
          <>
            <EmbedPlayer url={activeEmbedUrl} isPrivileged={isPrivileged} />

            {isPrivileged && (
              <div className="px-4 py-2.5 flex-shrink-0 bg-zinc-900/60 border-t border-zinc-800/60 backdrop-blur-sm">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                    </span>
                    <p className="text-[11px] text-zinc-300 font-medium">
                      {VIDEO_SERVERS.find(s => s.id === activeServerId)?.name ?? "مشغل مدمج"}
                    </p>
                    <span className="text-[10px] text-zinc-600">— يتحكم الهوست في التشغيل</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleNextServer}
                      disabled={!!fetchingServerId}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-600/30 border border-blue-500/40 text-blue-300 text-xs hover:bg-blue-600/50 hover:text-white transition-all active:scale-95 disabled:opacity-50"
                    >
                      {fetchingServerId ? <Loader2 className="w-3 h-3 animate-spin" /> : <ChevronLeft className="w-3 h-3" />}
                      جرب التالي
                    </button>
                    <button
                      onClick={() => onDirectUrlChange?.("")}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-zinc-800 border border-zinc-700/80 text-zinc-400 text-xs hover:bg-zinc-700 hover:text-white transition-all active:scale-95"
                    >
                      <X className="w-3 h-3" />
                      تغيير
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="flex-shrink-0 bg-[#0d0d12] border-t border-zinc-800/40">
            {isPrivileged ? (
              <div className="flex flex-col items-center gap-2 px-6 py-7">
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-orange-500/20 to-red-500/10 border border-orange-500/20 flex items-center justify-center mb-1 shadow-lg shadow-orange-500/10">
                  <Server className="w-6 h-6 text-orange-400" />
                </div>
                <p className="text-white text-sm font-bold">اختر سيرفر التشغيل</p>
                <p className="text-zinc-500 text-xs text-center">اضغط على أحد السيرفرات أدناه لبدء المشاهدة</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 py-9">
                <div className="w-16 h-16 rounded-full bg-zinc-800/60 border border-zinc-700/60 flex items-center justify-center">
                  <Play className="w-7 h-7 text-zinc-500 fill-zinc-500 ml-1" />
                </div>
                <p className="text-zinc-500 text-xs">في انتظار الهوست لاختيار السيرفر...</p>
              </div>
            )}
          </div>
        )}

        {/* SERVER PICKER */}
        {isPrivileged && (
          <div className="px-4 pt-3 pb-4 flex-shrink-0 border-t border-zinc-800/50">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-1 h-4 rounded-full bg-orange-500" />
              <p className="text-xs text-zinc-300 font-semibold uppercase tracking-wider">سيرفرات التشغيل</p>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              {VIDEO_SERVERS.map((server) => {
                const isActive = activeServerId === server.id;
                const isFetching = fetchingServerId === server.id;
                return (
                  <button
                    key={server.id}
                    onClick={() => handlePickServer(server)}
                    disabled={!!fetchingServerId}
                    className={`relative flex items-center gap-2.5 px-3.5 py-3 rounded-2xl border text-sm font-bold transition-all duration-200 active:scale-[0.97] overflow-hidden ${
                      isActive
                        ? `bg-gradient-to-r ${server.color} border-transparent text-white shadow-lg`
                        : "bg-zinc-900/70 border-zinc-700/80 text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800/80 hover:text-white"
                    } ${fetchingServerId && !isFetching ? "opacity-50 cursor-not-allowed" : ""}`}
                  >
                    {isActive && (
                      <div className="absolute inset-0 bg-gradient-to-r from-white/0 via-white/10 to-white/0 pointer-events-none" />
                    )}
                    <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 border ${
                      isActive ? "bg-white border-white/50 shadow-sm shadow-white/50" : "bg-zinc-600 border-zinc-500"
                    }`} />
                    <span className="flex-1 text-right truncate">{server.name}</span>
                    {isFetching
                      ? <Loader2 className="w-4 h-4 animate-spin flex-shrink-0 opacity-80" />
                      : isActive
                      ? <span className="text-[9px] font-bold opacity-80 flex-shrink-0">✓</span>
                      : null
                    }
                  </button>
                );
              })}
            </div>
            {loadingImdb && (
              <div className="mt-2.5 flex items-center gap-1.5 px-1">
                <Loader2 className="w-3 h-3 animate-spin text-zinc-500" />
                <span className="text-zinc-500 text-[10px]">جارٍ جلب معرف IMDB...</span>
              </div>
            )}

            {/* Custom URL — Arabic servers */}
            <div className="mt-4 pt-4 border-t border-zinc-800/60">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-1 h-4 rounded-full bg-green-500" />
                <p className="text-xs text-zinc-300 font-semibold">رابط سيرفر عربي مخصص</p>
              </div>
              <p className="text-zinc-600 text-[10px] mb-2">الصق رابط embed من أي موقع عربي (Vidspeeds، CimaLight...)</p>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="https://vidspeeds.com/embed-XXXXXXXX.html"
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                  className="flex-1 bg-zinc-800/80 border border-zinc-700 text-white text-xs px-3 py-2.5 rounded-xl focus:outline-none focus:border-green-500/60 focus:ring-1 focus:ring-green-500/20 transition-colors placeholder:text-zinc-600"
                  dir="ltr"
                />
                <button
                  onClick={() => {
                    const url = customUrl.trim();
                    if (!url) return;
                    onDirectUrlChange?.(url);
                    setCustomUrl("");
                  }}
                  disabled={!customUrl.trim()}
                  className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-green-600 to-emerald-600 text-white text-xs font-bold disabled:opacity-30 hover:opacity-90 transition-all active:scale-95 flex-shrink-0"
                >
                  تشغيل
                </button>
              </div>
            </div>
          </div>
        )}

        {/* TV — SEASON / EPISODE PICKER */}
        {isTV && (
          <div className="px-4 pb-4 flex-shrink-0 border-t border-zinc-800/50 pt-4 space-y-4">

            {!isPrivileged && (
              <div className="flex items-center justify-center gap-2 py-2 bg-zinc-900/50 rounded-xl border border-zinc-800/60">
                <span className="text-zinc-600 text-xs">فقط الهوست والأدمن يمكنهم تغيير الحلقة</span>
              </div>
            )}

            {loadingSeasons && (
              <div className="flex justify-center py-4">
                <Loader2 className="w-5 h-5 animate-spin text-zinc-500" />
              </div>
            )}

            {!loadingSeasons && seasons.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-1 h-4 rounded-full bg-red-500" />
                  <p className="text-xs text-zinc-300 font-semibold uppercase tracking-wider">المواسم</p>
                </div>
                <div className="flex gap-2 flex-wrap">
                  {seasons.map((s) => (
                    <button
                      key={s.season_number}
                      onClick={() => { if (!isPrivileged) return; nav({ season: s.season_number, episode: 1 }); }}
                      disabled={!isPrivileged}
                      className={`min-w-[46px] px-3 py-2 rounded-xl text-sm font-bold transition-all duration-200 ${
                        season === s.season_number
                          ? "bg-gradient-to-b from-red-500 to-red-700 text-white shadow-lg shadow-red-500/30 scale-105"
                          : isPrivileged
                          ? "bg-zinc-800/70 text-zinc-300 hover:bg-zinc-700 border border-zinc-700/80 hover:border-zinc-500"
                          : "bg-zinc-800/30 text-zinc-600 cursor-not-allowed border border-zinc-800/50"
                      }`}
                    >
                      {s.season_number}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {!loadingSeasons && selectedSeasonData && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-1 h-4 rounded-full bg-violet-500" />
                  <p className="text-xs text-zinc-300 font-semibold uppercase tracking-wider">
                    الحلقات
                  </p>
                  {isPrivileged && (
                    <span className="text-zinc-600 text-[10px] font-normal">
                      ({selectedSeasonData.episode_count} حلقة)
                    </span>
                  )}
                </div>
                <div className="flex gap-2 flex-wrap">
                  {Array.from({ length: selectedSeasonData.episode_count }, (_, i) => i + 1).map((ep) => (
                    <button
                      key={ep}
                      onClick={() => { if (!isPrivileged) return; nav({ episode: ep }); }}
                      disabled={!isPrivileged}
                      className={`w-11 h-11 rounded-xl text-sm font-bold transition-all duration-200 ${
                        episode === ep
                          ? "bg-gradient-to-b from-violet-500 to-violet-700 text-white shadow-lg shadow-violet-500/30 scale-105"
                          : isPrivileged
                          ? "bg-zinc-800/70 text-zinc-300 hover:bg-zinc-700 border border-zinc-700/80 hover:border-zinc-500"
                          : "bg-zinc-800/30 text-zinc-600 cursor-not-allowed border border-zinc-800/50"
                      }`}
                    >
                      {ep}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* OVERVIEW */}
        {selectedItem.overview && (
          <div className="mx-4 mb-6 flex-shrink-0 rounded-2xl overflow-hidden border border-zinc-800/60 bg-zinc-900/40 backdrop-blur-sm">
            <div className="px-4 pt-3.5 pb-1 flex items-center gap-2 border-b border-zinc-800/50">
              <div className="w-1 h-4 rounded-full bg-zinc-500" />
              <p className="text-xs text-zinc-400 font-semibold uppercase tracking-wider">القصة</p>
            </div>
            <p className="px-4 py-3.5 text-sm text-zinc-300 leading-relaxed">{selectedItem.overview}</p>
          </div>
        )}

      </div>
    );
  }

  // ─── Browse View ──────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-zinc-950 text-zinc-100" dir="rtl">

      {/* Toolbar */}
      <div className="flex-shrink-0 px-4 pt-3 pb-2 border-b border-white/5 space-y-2">

        <form
          className="relative"
          onSubmit={(e) => {
            e.preventDefault();
            if (!isPrivileged || !localSearch.trim()) return;
            nav({ searchQuery: localSearch.trim(), view: "browse" });
          }}
        >
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" />
          <input
            type="text"
            placeholder={isPrivileged ? "ابحث عن فيلم أو مسلسل..." : "مشاهدة فقط"}
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
            disabled={!isPrivileged}
            className={`w-full bg-zinc-800/80 border border-zinc-700 text-white placeholder:text-zinc-500 text-sm pr-10 pl-9 h-9 rounded-xl focus:outline-none focus:border-violet-500/60 focus:ring-1 focus:ring-violet-500/20 transition-colors ${!isPrivileged ? "opacity-50 cursor-not-allowed" : ""}`}
          />
          {localSearch && isPrivileged && (
            <button type="button" onClick={() => { setLocalSearch(""); nav({ searchQuery: "", view: "browse" }); }} className="absolute left-3 top-1/2 -translate-y-1/2">
              <X className="w-3.5 h-3.5 text-zinc-500 hover:text-white" />
            </button>
          )}
        </form>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex bg-zinc-800 rounded-lg p-0.5 gap-0.5">
            <button disabled={!isPrivileged} onClick={() => handleContentType("movie")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${contentType === "movie" ? "bg-red-500 text-white shadow" : isPrivileged ? "text-zinc-400 hover:text-zinc-200" : "text-zinc-600 cursor-not-allowed"}`}>
              <Film className="w-3.5 h-3.5" /> أفلام
            </button>
            <button disabled={!isPrivileged} onClick={() => handleContentType("tv")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${contentType === "tv" ? "bg-violet-500 text-white shadow" : isPrivileged ? "text-zinc-400 hover:text-zinc-200" : "text-zinc-600 cursor-not-allowed"}`}>
              <Tv className="w-3.5 h-3.5" /> مسلسلات
            </button>
          </div>

          {!searchQuery && (
            <>
              <button disabled={!isPrivileged} onClick={() => handleCategory("popular")}
                className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${category === "popular" ? "bg-orange-500/20 border-orange-500/40 text-orange-300" : isPrivileged ? "bg-transparent border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300" : "bg-transparent border-zinc-800 text-zinc-700 cursor-not-allowed"}`}>
                <TrendingUp className="w-3 h-3" /> رائج
              </button>
              <button disabled={!isPrivileged} onClick={() => handleCategory("top_rated")}
                className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${category === "top_rated" ? "bg-yellow-500/20 border-yellow-500/40 text-yellow-300" : isPrivileged ? "bg-transparent border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300" : "bg-transparent border-zinc-800 text-zinc-700 cursor-not-allowed"}`}>
                <Star className="w-3 h-3" /> الأعلى تقييماً
              </button>
            </>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <div className={`w-1 h-4 rounded-full ${contentType === "movie" ? "bg-red-500" : "bg-violet-500"}`} />
          <span className="text-zinc-400 text-xs font-medium">
            {searchQuery ? `نتائج البحث عن "${searchQuery}"` : category === "popular" ? (contentType === "movie" ? "أفلام رائجة" : "مسلسلات رائجة") : (contentType === "movie" ? "أفلام الأعلى تقييماً" : "مسلسلات الأعلى تقييماً")}
          </span>
          {!isPrivileged && <span className="mr-auto text-xs text-zinc-600">للعرض فقط</span>}
        </div>
      </div>

      {/* Grid */}
      <div ref={gridRef} className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-3">
            {Array.from({ length: 15 }).map((_, i) => <SkeletonCard key={i} />)}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 py-16">
            <Search className="w-10 h-10 text-zinc-700" />
            <p className="text-zinc-500 text-sm">لا توجد نتائج</p>
          </div>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-3">
            {items.map((item) => (
              <PosterCard
                key={item.id}
                item={item}
                contentType={contentType}
                isActive={selectedItem?.id === item.id}
                canControl={isPrivileged}
                onSelect={() => handleSelectItem(item)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Pagination */}
      {!loading && totalPages > 1 && (
        <div className="flex-shrink-0 flex items-center justify-center gap-3 py-3 border-t border-white/5">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1 || !isPrivileged}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-400 text-xs disabled:opacity-30 hover:bg-zinc-700 hover:text-white transition-all"
          >
            <ChevronRight className="w-3.5 h-3.5" />
            السابق
          </button>
          <span className="text-zinc-500 text-xs tabular-nums">{page} / {totalPages}</span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages || !isPrivileged}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-400 text-xs disabled:opacity-30 hover:bg-zinc-700 hover:text-white transition-all"
          >
            التالي
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

    </div>
  );
}