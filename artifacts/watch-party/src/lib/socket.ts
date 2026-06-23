import { io, Socket } from "socket.io-client";

let socket: Socket | null = null;

// iOS بيوقف WebSocket connections في الخلفية بسرعة أكتر من HTTP polling.
// HTTP polling: iOS بيسمح للـ pending request يكمل لما الـ tab يصحى لحظياً.
// WebSocket: TCP connection بيتوقف فوراً لما iOS يسكّت الـ tab.
const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export function getSocket(): Socket {
  if (!socket) {
    socket = io("/", {
      // iOS: polling أولاً (أصمد في الخلفية)، بعدين upgrade لـ websocket لو أمكن
      // Android/Desktop: websocket أولاً (أسرع وأحسن latency)
      transports: isIOS ? ["polling", "websocket"] : ["websocket", "polling"],
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      // [FIX-COMMENT] `timeout` here is the Socket.IO connection/handshake timeout
      // (how long a single connect/reconnect attempt waits), NOT the heartbeat
      // pingTimeout — that's negotiated automatically by the server during the
      // handshake and the client doesn't need to "match" it. The server currently
      // runs pingInterval: 60s / pingTimeout: 90s for iOS background tolerance
      // (see artifacts/api-server/src/lib/socket.ts). 20s here just avoids the
      // client giving up on a single attempt too early on a slow/weak network.
      timeout: 20000,
      // [FIX] Allow upgrade from polling → WebSocket when WS initially fails.
      // upgrade:false meant the socket stayed on polling forever if it fell back,
      // which is far worse for latency and audio delivery than WebSocket.
      upgrade: true,
      // [FIX C-01] auth object يُرسَل في كل handshake تلقائياً
      // يُحدَّث قبل كل connect() عبر connectSocket()
      auth: {},
    });
  }
  return socket;
}

export function connectSocket(roomCode: string, sessionToken: string): Socket {
  const s = getSocket();

  // [FIX C-01] تحديث بيانات المصادقة قبل الاتصال
  // Socket.IO يرسل هذا الـ object في كل handshake و reconnect
  s.auth = { sessionToken, roomCode };

  if (!s.connected) {
    s.connect();
  }
  return s;
}

// Force a clean reconnect regardless of current connection state.
// Used when Android returns from the background and the socket may be in a
// zombie state (socket.connected === true but no messages are delivered).
export function forceReconnectSocket(): void {
  const s = socket;
  if (!s) return;
  s.disconnect();
  setTimeout(() => s.connect(), 150);
}

export function disconnectSocket(): void {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
  }
  socket = null;
}