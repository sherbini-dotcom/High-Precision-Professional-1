// ============================================================
// artifacts/api-server/src/lib/mediasoupManager.ts
// mediasoup SFU — Worker / Router / Transport / Producer / Consumer
// ============================================================
import * as mediasoup from "mediasoup";
import type { types as MediasoupTypes } from "mediasoup";
import { logger } from "./logger.js";

type Worker          = MediasoupTypes.Worker;
type Router          = MediasoupTypes.Router;
type WebRtcTransport = MediasoupTypes.WebRtcTransport;
type Producer        = MediasoupTypes.Producer;
type Consumer        = MediasoupTypes.Consumer;
type RtpCapabilities = MediasoupTypes.RtpCapabilities;

// ─── Config ──────────────────────────────────────────────────────────────────

const MEDIA_CODECS = [
  {
    kind: "audio" as const,
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
    parameters: {
      minptime: 10,
      "useinbandfec": 1,
    },
  },
];

function getAnnouncedIp(): string {
  if (process.env.MEDIASOUP_ANNOUNCED_IP) return process.env.MEDIASOUP_ANNOUNCED_IP;
  const replitDomain = process.env.REPLIT_DEV_DOMAIN;
  if (replitDomain) return replitDomain.split(":")[0]!;
  return "127.0.0.1";
}

function makeTransportOptions() {
  const announcedAddress = getAnnouncedIp();
  return {
    listenInfos: [
      { protocol: "udp" as const, ip: "0.0.0.0", announcedAddress },
      { protocol: "tcp" as const, ip: "0.0.0.0", announcedAddress },
    ],
    initialAvailableOutgoingBitrate: 600_000,
    minimumAvailableOutgoingBitrate: 100_000,
    maxSctpMessageSize: 262144,
  };
}

// ─── Global Worker ───────────────────────────────────────────────────────────

let globalWorker: Worker | null = null;

async function getWorker(): Promise<Worker> {
  if (!globalWorker) {
    globalWorker = await mediasoup.createWorker({
      logLevel: "warn",
      rtcMinPort: parseInt(process.env.MEDIASOUP_RTC_MIN_PORT ?? "40000"),
      rtcMaxPort: parseInt(process.env.MEDIASOUP_RTC_MAX_PORT ?? "49999"),
    });

    globalWorker.on("died", (err) => {
      logger.error({ err }, "mediasoup Worker died — will restart on next request");
      globalWorker = null;
    });

    logger.info({ pid: globalWorker.pid }, "mediasoup Worker created");
  }
  return globalWorker;
}

// ─── Per-peer state ───────────────────────────────────────────────────────────

export interface MsPeerState {
  sendTransport: WebRtcTransport | null;
  recvTransport: WebRtcTransport | null;
  producer: Producer | null;                 // mic producer
  consumers: Map<string, Consumer>;          // producerId → Consumer
}

// ─── Per-room state ───────────────────────────────────────────────────────────

export interface MsRoomState {
  router: Router;
  peers: Map<number, MsPeerState>;           // memberId → PeerState
}

const rooms = new Map<string, MsRoomState>();

// ─── Room lifecycle ───────────────────────────────────────────────────────────

export async function msGetOrCreateRoom(roomCode: string): Promise<MsRoomState> {
  if (!rooms.has(roomCode)) {
    const worker = await getWorker();
    const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
    rooms.set(roomCode, { router, peers: new Map() });
    logger.info({ roomCode }, "mediasoup Room created");
  }
  return rooms.get(roomCode)!;
}

export function msGetRoom(roomCode: string): MsRoomState | null {
  return rooms.get(roomCode) ?? null;
}

export function msCloseRoom(roomCode: string): void {
  const room = rooms.get(roomCode);
  if (!room) return;
  for (const [memberId] of room.peers) {
    msClosePeer(room, memberId);
  }
  room.router.close();
  rooms.delete(roomCode);
  logger.info({ roomCode }, "mediasoup Room closed");
}

// ─── Peer lifecycle ───────────────────────────────────────────────────────────

export function msGetOrCreatePeer(room: MsRoomState, memberId: number): MsPeerState {
  if (!room.peers.has(memberId)) {
    room.peers.set(memberId, {
      sendTransport: null,
      recvTransport: null,
      producer: null,
      consumers: new Map(),
    });
  }
  return room.peers.get(memberId)!;
}

export function msClosePeer(room: MsRoomState, memberId: number): void {
  const peer = room.peers.get(memberId);
  if (!peer) return;
  try { peer.producer?.close(); } catch { /* ignore */ }
  try { peer.sendTransport?.close(); } catch { /* ignore */ }
  try { peer.recvTransport?.close(); } catch { /* ignore */ }
  for (const consumer of peer.consumers.values()) {
    try { consumer.close(); } catch { /* ignore */ }
  }
  room.peers.delete(memberId);
}

// ─── Transport factory ────────────────────────────────────────────────────────

export async function msCreateWebRtcTransport(router: Router): Promise<WebRtcTransport> {
  const transport = await router.createWebRtcTransport(makeTransportOptions());

  transport.on("dtlsstatechange", (dtlsState) => {
    if (dtlsState === "closed") {
      try { transport.close(); } catch { /* ignore */ }
    }
  });

  return transport;
}

// ─── Router capabilities ──────────────────────────────────────────────────────

export function msGetRtpCapabilities(room: MsRoomState): RtpCapabilities {
  return room.router.rtpCapabilities;
}

// ─── Produce ─────────────────────────────────────────────────────────────────

export async function msProduce(
  peer: MsPeerState,
  transportId: string,
  kind: "audio" | "video",
  rtpParameters: unknown,
  appData: Record<string, unknown> = {},
): Promise<Producer> {
  const transport = peer.sendTransport;
  if (!transport || transport.id !== transportId) {
    throw new Error(`sendTransport not found for id ${transportId}`);
  }

  const producer = await transport.produce({
    kind,
    rtpParameters: rtpParameters as Parameters<typeof transport.produce>[0]["rtpParameters"],
    appData,
  });

  peer.producer?.close();
  peer.producer = producer;
  return producer;
}

// ─── Consume ─────────────────────────────────────────────────────────────────

export async function msConsume(
  router: Router,
  consumerPeer: MsPeerState,
  producerId: string,
  rtpCapabilities: unknown,
): Promise<Consumer> {
  if (!router.canConsume({ producerId, rtpCapabilities: rtpCapabilities as RtpCapabilities })) {
    throw new Error("Router cannot consume: incompatible RTP capabilities");
  }

  const transport = consumerPeer.recvTransport;
  if (!transport) throw new Error("recvTransport not found");

  const consumer = await transport.consume({
    producerId,
    rtpCapabilities: rtpCapabilities as RtpCapabilities,
    paused: true,
  });

  consumerPeer.consumers.set(producerId, consumer);

  consumer.on("transportclose", () => {
    consumerPeer.consumers.delete(producerId);
  });

  consumer.on("producerclose", () => {
    consumerPeer.consumers.delete(producerId);
    try { consumer.close(); } catch { /* ignore */ }
  });

  return consumer;
}
