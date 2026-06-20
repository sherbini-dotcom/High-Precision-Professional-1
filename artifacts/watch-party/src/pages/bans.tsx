import { useRoute, useLocation } from "wouter";
import { useListBans, useUnbanMember, getListBansQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { getSession } from "@/lib/storage";
import { ArrowLeft, Ban, UserCheck, Loader2, ShieldOff } from "lucide-react";

export default function Bans() {
  const [, params] = useRoute("/room/:code/bans");
  const code = params?.code?.toUpperCase() ?? "";
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  const session = getSession(code);
  const sessionToken = session?.sessionToken ?? "";
  const myRole = session?.role ?? "guest";

  const { data: bans, isLoading } = useListBans(code, {
    request: { headers: { "x-session-token": sessionToken } },
    query: { enabled: !!code && !!sessionToken, queryKey: getListBansQueryKey(code) },
  });

  const unban = useUnbanMember({
    request: { headers: { "x-session-token": sessionToken } },
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListBansQueryKey(code) });
      },
    },
  });

  if (myRole !== "host" && myRole !== "admin") {
    setLocation(`/room/${code}`);
    return null;
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto px-4 py-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => setLocation(`/room/${code}`)}
            className="p-2 rounded-lg hover:bg-muted transition-colors"
          >
            <ArrowLeft className="w-4 h-4 text-muted-foreground" />
          </button>
          <div>
            <h1 className="text-lg font-bold flex items-center gap-2">
              <Ban className="w-5 h-5 text-destructive" />
              Ban List
            </h1>
            <p className="text-xs text-muted-foreground">Room: {code}</p>
          </div>
        </div>

        {/* Content */}
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : !bans || bans.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <ShieldOff className="w-12 h-12 text-muted-foreground/30 mb-4" />
            <h2 className="text-base font-medium text-muted-foreground mb-1">No banned members</h2>
            <p className="text-xs text-muted-foreground/60">Nobody has been banned from this room</p>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground mb-3">{bans.length} banned {bans.length === 1 ? "member" : "members"}</p>
            {bans.map(ban => (
              <div
                key={ban.id}
                className="flex items-center gap-3 p-3 rounded-xl bg-card border border-border hover:border-destructive/30 transition-colors"
              >
                <div className="w-9 h-9 rounded-full bg-destructive/10 flex items-center justify-center flex-shrink-0">
                  <Ban className="w-4 h-4 text-destructive" />
                </div>
                <div className="flex-1 min-w-0">
                  {/* FIX: show name only, no IP address */}
                  <p className="text-sm font-medium truncate">
                    {(ban as unknown as { name?: string }).name ?? "Unknown Member"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Banned by {(ban as unknown as { bannedBy?: string }).bannedBy ?? "admin"}
                  </p>
                </div>
                {myRole === "host" && (
                  <button
                    onClick={() => unban.mutate({ code, banId: ban.id })}
                    disabled={unban.isPending}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-500/10 text-green-400 border border-green-500/20 text-xs font-medium hover:bg-green-500/20 transition-colors disabled:opacity-50"
                    title="Unban"
                  >
                    <UserCheck className="w-3.5 h-3.5" />
                    Unban
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
