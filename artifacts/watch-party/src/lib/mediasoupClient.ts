// ============================================================
// artifacts/watch-party/src/lib/mediasoupClient.ts
// mediasoup-client wrapper — SFU mic audio for watch-party
// ============================================================
import { Device, types as MsTypes } from "mediasoup-client";
import type { Socket } from "socket.io-client";

type Transport        = MsTypes.Transport;
type Producer         = MsTypes.Producer;
type Consumer         = MsTypes.Consumer;
type RtpCapabilities  = MsTypes.RtpCapabilities;
type DtlsParameters   = MsTypes.DtlsParameters;
type IceParameters    = MsTypes.IceParameters;
type IceCandidate     = MsTypes.IceCandidate;
type SctpParameters   = MsTypes.SctpParameters;

interface TransportParams {
  id: string;
  iceParameters: IceParameters;
  iceCandidates: IceCandidate[];
  dtlsParameters: DtlsParameters;
  sctpParameters?: SctpParameters;
}

interface ConsumeResult {
  id: string;
  producerId: string;
  kind: "audio" | "video";
  rtpParameters: Consumer["rtpParameters"];
}

type RemoteAudioCallback = (memberId: number, stream: MediaStream | null) => void;

// ─── socketRequest helper ──────────────────────────────────────────────────────
// Wraps a socket.emit with ack into a Promise that rejects on error.
function socketRequest<T>(socket: Socket, event: string, data: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    socket.emit(event, data, (response: { error?: string } & Record<string, unknown>) => {
      if (response?.error) reject(new Error(response.error));
      else resolve(response as T);
    });
  });
}

// ─── MediasoupClient ──────────────────────────────────────────────────────────

export class MediasoupClient {
  private device = new Device();
  private socket: Socket;
  private roomCode: string;
  private memberId: number;

  private sendTransport: Transport | null = null;
  private recvTransport: Transport | null = null;
  private producer: Producer | null = null;
  private consumers = new Map<string, Consumer>();        // producerId → Consumer
  private audioElements = new Map<number, HTMLAudioElement>(); // memberId → <audio>

  private onRemoteAudio: RemoteAudioCallback | null;
  private initialized = false;
  private closed = false;

  constructor(
    socket: Socket,
    roomCode: string,
    memberId: number,
    onRemoteAudio?: RemoteAudioCallback,
  ) {
    this.socket = socket;
    this.roomCode = roomCode;
    this.memberId = memberId;
    this.onRemoteAudio = onRemoteAudio ?? null;
  }

  // ─── init ─────────────────────────────────────────────────────────────────
  async init(): Promise<void> {
    if (this.initialized || this.closed) return;

    // 1. Load device with router RTP capabilities
    const rtpCapabilities = await socketRequest<RtpCapabilities>(
      this.socket,
      "ms:getRouterRtpCapabilities",
      { roomCode: this.roomCode },
    );
    await this.device.load({ routerRtpCapabilities: rtpCapabilities });

    // 2. Create send transport (mic → server)
    const sendParams = await socketRequest<TransportParams>(
      this.socket,
      "ms:createTransport",
      { roomCode: this.roomCode, direction: "send" },
    );
    this.sendTransport = this.device.createSendTransport(sendParams);

    this.sendTransport.on("connect", ({ dtlsParameters }, callback, errback) => {
      socketRequest(this.socket, "ms:connectTransport", {
        roomCode: this.roomCode,
        transportId: this.sendTransport!.id,
        dtlsParameters,
      })
        .then(() => callback())
        .catch(errback);
    });

    this.sendTransport.on("produce", (parameters, callback, errback) => {
      socketRequest<{ id: string }>(this.socket, "ms:produce", {
        roomCode: this.roomCode,
        transportId: this.sendTransport!.id,
        kind: parameters.kind,
        rtpParameters: parameters.rtpParameters,
        appData: parameters.appData,
      })
        .then(({ id }) => callback({ id }))
        .catch(errback);
    });

    // 3. Create recv transport (server → this client)
    const recvParams = await socketRequest<TransportParams>(
      this.socket,
      "ms:createTransport",
      { roomCode: this.roomCode, direction: "recv" },
    );
    this.recvTransport = this.device.createRecvTransport(recvParams);

    this.recvTransport.on("connect", ({ dtlsParameters }, callback, errback) => {
      socketRequest(this.socket, "ms:connectTransport", {
        roomCode: this.roomCode,
        transportId: this.recvTransport!.id,
        dtlsParameters,
      })
        .then(() => callback())
        .catch(errback);
    });

    // 4. Listen for new producers from other members
    this.socket.on(
      "ms:newProducer",
      ({ memberId, producerId }: { memberId: number; producerId: string }) => {
        if (memberId === this.memberId) return; // own producer
        void this._consumeProducer(memberId, producerId);
      },
    );

    // 5. Listen for producer closed (peer left / mic off)
    this.socket.on(
      "ms:producerClosed",
      ({ memberId, producerId }: { memberId: number; producerId: string }) => {
        const consumer = this.consumers.get(producerId);
        if (consumer) {
          try { consumer.close(); } catch { /* ignore */ }
          this.consumers.delete(producerId);
        }
        this._removeAudioElement(memberId);
        this.onRemoteAudio?.(memberId, null);
      },
    );

    this.initialized = true;
  }

  // ─── startMic ─────────────────────────────────────────────────────────────
  async startMic(stream: MediaStream): Promise<void> {
    if (!this.sendTransport) throw new Error("MediasoupClient: not initialized");
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error("MediasoupClient: no audio track in stream");

    // Close previous producer if any
    if (this.producer && !this.producer.closed) {
      this.producer.close();
      this.producer = null;
    }

    this.producer = await this.sendTransport.produce({
      track,
      codecOptions: {
        opusStereo: false,
        opusDtx: true,
        opusFec: true,
        opusMaxPlaybackRate: 48000,
      },
      appData: { source: "mic", memberId: this.memberId },
    });

    this.producer.on("transportclose", () => { this.producer = null; });
    this.producer.on("trackended", () => { this.stopMic(); });
  }

  // ─── stopMic ──────────────────────────────────────────────────────────────
  stopMic(): void {
    if (this.producer && !this.producer.closed) {
      this.producer.close();
    }
    this.producer = null;
  }

  // ─── consumeExisting ──────────────────────────────────────────────────────
  // Called once after init() to consume producers that were already active
  // before this client joined.
  async consumeExistingProducers(
    producers: Array<{ memberId: number; producerId: string }>,
  ): Promise<void> {
    await Promise.all(
      producers.map(({ memberId, producerId }) =>
        this._consumeProducer(memberId, producerId),
      ),
    );
  }

  // ─── removePeer ───────────────────────────────────────────────────────────
  removePeer(memberId: number): void {
    this._removeAudioElement(memberId);
    this.onRemoteAudio?.(memberId, null);
  }

  // ─── audio helpers ────────────────────────────────────────────────────────
  setVolume(memberId: number, volume: number): void {
    const el = this.audioElements.get(memberId);
    if (el) el.volume = Math.max(0, Math.min(1, volume));
  }

  resumeAllAudio(): void {
    for (const el of this.audioElements.values()) {
      if (el.paused) el.play().catch(() => {});
    }
  }

  // ─── close ────────────────────────────────────────────────────────────────
  close(): void {
    if (this.closed) return;
    this.closed = true;

    this.socket.off("ms:newProducer");
    this.socket.off("ms:producerClosed");

    try { this.producer?.close(); } catch { /* ignore */ }
    try { this.sendTransport?.close(); } catch { /* ignore */ }
    try { this.recvTransport?.close(); } catch { /* ignore */ }

    for (const consumer of this.consumers.values()) {
      try { consumer.close(); } catch { /* ignore */ }
    }
    this.consumers.clear();

    for (const [, el] of this.audioElements) {
      el.srcObject = null;
      try { el.remove(); } catch { /* ignore */ }
    }
    this.audioElements.clear();
    this.initialized = false;
  }

  // ─── private: consume a remote producer ──────────────────────────────────
  private async _consumeProducer(
    memberId: number,
    producerId: string,
  ): Promise<void> {
    if (this.closed || !this.recvTransport || !this.device.loaded) return;
    if (this.consumers.has(producerId)) return; // already consuming

    try {
      const result = await socketRequest<ConsumeResult>(
        this.socket,
        "ms:consume",
        {
          roomCode: this.roomCode,
          transportId: this.recvTransport.id,
          producerId,
          // eslint-disable-next-line @typescript-eslint/no-deprecated
          rtpCapabilities: this.device.rtpCapabilities,
        },
      );

      const consumer = await this.recvTransport.consume({
        id: result.id,
        producerId: result.producerId,
        kind: result.kind,
        rtpParameters: result.rtpParameters,
      });

      this.consumers.set(producerId, consumer);

      // Resume (consumer starts paused on server side)
      await socketRequest(this.socket, "ms:resumeConsumer", {
        roomCode: this.roomCode,
        consumerId: result.id,
      });

      // Create/reuse audio element
      let el = this.audioElements.get(memberId);
      if (!el) {
        el = document.createElement("audio");
        el.autoplay = true;
        el.setAttribute("playsinline", "");
        el.muted = false;
        el.volume = 1.0;
        el.style.cssText =
          "position:absolute;width:0;height:0;opacity:0;pointer-events:none;";
        document.body.appendChild(el);
        this.audioElements.set(memberId, el);
      }

      const stream = new MediaStream([consumer.track]);
      el.srcObject = stream;
      el.play().catch(() => {});
      this.onRemoteAudio?.(memberId, stream);

      // "transportclose" fires when the recv transport closes (e.g. network drop)
      consumer.on("transportclose", () => {
        this.consumers.delete(producerId);
        this._removeAudioElement(memberId);
        this.onRemoteAudio?.(memberId, null);
      });

      // "trackended" fires when the remote track ends (e.g. peer stopped mic)
      consumer.on("trackended", () => {
        this.consumers.delete(producerId);
        this._removeAudioElement(memberId);
        this.onRemoteAudio?.(memberId, null);
      });

      // NOTE: "producerclose" is a SERVER-side mediasoup event only.
      // On the client side, producer closure is signalled via socket event
      // "ms:producerClosed" which is handled in init() above.
    } catch (err) {
      console.error("[MediasoupClient] consumeProducer error:", err);
    }
  }

  private _removeAudioElement(memberId: number): void {
    const el = this.audioElements.get(memberId);
    if (el) {
      el.srcObject = null;
      try { el.remove(); } catch { /* ignore */ }
      this.audioElements.delete(memberId);
    }
  }
}
