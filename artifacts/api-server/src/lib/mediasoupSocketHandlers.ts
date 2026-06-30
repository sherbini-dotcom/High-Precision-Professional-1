// ============================================================
// artifacts/api-server/src/lib/mediasoupSocketHandlers.ts
// mediasoup SFU — Socket.IO signaling handlers
// ============================================================
// Call setupMsHandlers() inside io.on("connection", (socket) => { ... })
// passing a `state` object whose properties are updated by joinRoom.
// ============================================================
import type { Server as SocketIOServer, Socket } from "socket.io";
import {
  msGetOrCreateRoom,
  msGetRoom,
  msGetOrCreatePeer,
  msClosePeer,
  msCreateWebRtcTransport,
  msGetRtpCapabilities,
  msProduce,
  msConsume,
} from "./mediasoupManager.js";
import { logger } from "./logger.js";

export interface MsSocketState {
  roomCode: string | null;
  memberId: number | null;
}

export function setupMsHandlers(
  socket: Socket,
  io: SocketIOServer,
  state: MsSocketState,
): void {

  // ── helper: get roomCode from state (already set by joinRoom) ─────────────
  function getRoomCode(data?: { roomCode?: string }): string | null {
    return (state.roomCode ?? data?.roomCode ?? null)?.toUpperCase() ?? null;
  }

  // ── ms:getRouterRtpCapabilities ───────────────────────────────────────────
  // Client calls this first to load the mediasoup-client Device.
  socket.on(
    "ms:getRouterRtpCapabilities",
    async (
      data: { roomCode?: string },
      callback: (result: unknown) => void,
    ) => {
      try {
        const roomCode = getRoomCode(data);
        if (!roomCode) return callback({ error: "No room code" });
        const room = await msGetOrCreateRoom(roomCode);
        callback(msGetRtpCapabilities(room));
      } catch (err) {
        logger.error({ err }, "ms:getRouterRtpCapabilities error");
        callback({ error: String(err) });
      }
    },
  );

  // ── ms:createTransport ────────────────────────────────────────────────────
  // Creates a WebRTC transport on the server for this peer.
  // direction: "send" | "recv"
  socket.on(
    "ms:createTransport",
    async (
      data: { roomCode?: string; direction: "send" | "recv" },
      callback: (result: unknown) => void,
    ) => {
      try {
        const roomCode = getRoomCode(data);
        const memberId = state.memberId;
        if (!roomCode || !memberId) return callback({ error: "Not in room" });

        const room = await msGetOrCreateRoom(roomCode);
        const peer = msGetOrCreatePeer(room, memberId);
        const transport = await msCreateWebRtcTransport(room.router);

        if (data.direction === "send") {
          peer.sendTransport?.close();
          peer.sendTransport = transport;
        } else {
          peer.recvTransport?.close();
          peer.recvTransport = transport;
        }

        callback({
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
          sctpParameters: transport.sctpParameters,
        });
      } catch (err) {
        logger.error({ err }, "ms:createTransport error");
        callback({ error: String(err) });
      }
    },
  );

  // ── ms:connectTransport ───────────────────────────────────────────────────
  // Client sends DTLS params → server completes the DTLS handshake.
  socket.on(
    "ms:connectTransport",
    async (
      data: {
        roomCode?: string;
        transportId: string;
        dtlsParameters: unknown;
      },
      callback: (result: unknown) => void,
    ) => {
      try {
        const roomCode = getRoomCode(data);
        const memberId = state.memberId;
        if (!roomCode || !memberId) return callback({ error: "Not in room" });

        const room = msGetRoom(roomCode);
        if (!room) return callback({ error: "Room not found" });

        const peer = room.peers.get(memberId);
        if (!peer) return callback({ error: "Peer not found" });

        const transport =
          peer.sendTransport?.id === data.transportId
            ? peer.sendTransport
            : peer.recvTransport?.id === data.transportId
            ? peer.recvTransport
            : null;

        if (!transport) return callback({ error: "Transport not found" });

        await transport.connect({
          dtlsParameters: data.dtlsParameters as Parameters<typeof transport.connect>[0]["dtlsParameters"],
        });
        callback({});
      } catch (err) {
        logger.error({ err }, "ms:connectTransport error");
        callback({ error: String(err) });
      }
    },
  );

  // ── ms:produce ────────────────────────────────────────────────────────────
  // Client starts sending audio → server creates a Producer.
  socket.on(
    "ms:produce",
    async (
      data: {
        roomCode?: string;
        transportId: string;
        kind: "audio" | "video";
        rtpParameters: unknown;
        appData?: Record<string, unknown>;
      },
      callback: (result: unknown) => void,
    ) => {
      try {
        const roomCode = getRoomCode(data);
        const memberId = state.memberId;
        if (!roomCode || !memberId) return callback({ error: "Not in room" });

        const room = msGetRoom(roomCode);
        if (!room) return callback({ error: "Room not found" });

        const peer = room.peers.get(memberId);
        if (!peer) return callback({ error: "Peer not found" });

        const producer = await msProduce(
          peer,
          data.transportId,
          data.kind,
          data.rtpParameters,
          data.appData ?? {},
        );

        callback({ id: producer.id });

        // Notify all OTHER members in the room about the new producer
        socket.to(roomCode).emit("ms:newProducer", {
          memberId,
          producerId: producer.id,
        });

        producer.on("transportclose", () => {
          io.to(roomCode).emit("ms:producerClosed", {
            memberId,
            producerId: producer.id,
          });
        });
      } catch (err) {
        logger.error({ err }, "ms:produce error");
        callback({ error: String(err) });
      }
    },
  );

  // ── ms:consume ────────────────────────────────────────────────────────────
  // Client wants to receive audio from a specific producer.
  socket.on(
    "ms:consume",
    async (
      data: {
        roomCode?: string;
        transportId: string;
        producerId: string;
        rtpCapabilities: unknown;
      },
      callback: (result: unknown) => void,
    ) => {
      try {
        const roomCode = getRoomCode(data);
        const memberId = state.memberId;
        if (!roomCode || !memberId) return callback({ error: "Not in room" });

        const room = msGetRoom(roomCode);
        if (!room) return callback({ error: "Room not found" });

        const peer = msGetOrCreatePeer(room, memberId);
        if (!peer.recvTransport) return callback({ error: "No recv transport" });

        const consumer = await msConsume(
          room.router,
          peer,
          data.producerId,
          data.rtpCapabilities,
        );

        callback({
          id: consumer.id,
          producerId: consumer.producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });
      } catch (err) {
        logger.error({ err }, "ms:consume error");
        callback({ error: String(err) });
      }
    },
  );

  // ── ms:resumeConsumer ─────────────────────────────────────────────────────
  // Client signals it's ready to receive — server un-pauses the consumer.
  socket.on(
    "ms:resumeConsumer",
    async (
      data: { roomCode?: string; consumerId: string },
      callback: (result: unknown) => void,
    ) => {
      try {
        const roomCode = getRoomCode(data);
        const memberId = state.memberId;
        if (!roomCode || !memberId) return callback({ error: "Not in room" });

        const room = msGetRoom(roomCode);
        const peer = room?.peers.get(memberId);
        if (!peer) return callback({ error: "Peer not found" });

        // Find the consumer by id across all of this peer's consumers
        let found = false;
        for (const consumer of peer.consumers.values()) {
          if (consumer.id === data.consumerId) {
            await consumer.resume();
            found = true;
            break;
          }
        }
        callback(found ? {} : { error: "Consumer not found" });
      } catch (err) {
        logger.error({ err }, "ms:resumeConsumer error");
        callback({ error: String(err) });
      }
    },
  );

  // ── ms:getExistingProducers ───────────────────────────────────────────────
  // Called by a client that just joined to subscribe to already-active producers.
  socket.on(
    "ms:getExistingProducers",
    (
      data: { roomCode?: string },
      callback: (result: unknown) => void,
    ) => {
      try {
        const roomCode = getRoomCode(data);
        const memberId = state.memberId;
        if (!roomCode || !memberId) return callback([]);

        const room = msGetRoom(roomCode);
        if (!room) return callback([]);

        const producers: Array<{ memberId: number; producerId: string }> = [];
        for (const [peerId, peer] of room.peers) {
          if (peerId === memberId) continue;          // skip own
          if (peer.producer && !peer.producer.closed) {
            producers.push({ memberId: peerId, producerId: peer.producer.id });
          }
        }
        callback(producers);
      } catch (err) {
        logger.error({ err }, "ms:getExistingProducers error");
        callback([]);
      }
    },
  );
}

// ── Called on disconnect to clean up mediasoup state ─────────────────────────
export function closeMsPeer(roomCode: string | null, memberId: number | null, io: SocketIOServer): void {
  if (!roomCode || !memberId) return;
  const room = msGetRoom(roomCode);
  if (!room) return;

  const peer = room.peers.get(memberId);
  if (!peer) return;

  // Notify others before closing
  if (peer.producer && !peer.producer.closed) {
    io.to(roomCode).emit("ms:producerClosed", {
      memberId,
      producerId: peer.producer.id,
    });
  }

  msClosePeer(room, memberId);
}
