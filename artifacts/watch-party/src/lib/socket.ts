import { io, Socket } from "socket.io-client";

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io("/", {
      transports: ["websocket", "polling"],
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      // [FIX] Match server's new pingTimeout (20 s). Old 10 s caused false
      // disconnects on weak connections before the server could respond.
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
