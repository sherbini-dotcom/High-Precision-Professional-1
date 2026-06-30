// ============================================================
// useMediasoupVoice.ts — نظام الصوت عبر mediasoup SFU
// ============================================================
import { useEffect, useRef, useState, useCallback } from "react";
import * as mediasoupClient from "mediasoup-client";

type Device    = mediasoupClient.Device;
type Transport = mediasoupClient.types.Transport;
type Producer  = mediasoupClient.types.Producer;
type Consumer  = mediasoupClient.types.Consumer;

import type { Socket } from "socket.io-client";

interface UseMediasoupVoiceOptions {
  socket: Socket | null;
  roomCode: string | null;
  memberId: number | null;
  enabled: boolean;
}

interface UseMediasoupVoiceResult {
  isMuted: boolean;
  isConnected: boolean;
  toggleMute: () => void;
  speakingMap: Map<number, number>;
  activeSpeakers: number[];
}

export function useMediasoupVoice({
  socket,
  roomCode,
  memberId,
  enabled,
}: UseMediasoupVoiceOptions): UseMediasoupVoiceResult {
  const [isMuted, setIsMuted] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [speakingMap, setSpeakingMap] = useState<Map<number, number>>(new Map());
  const [activeSpeakers, setActiveSpeakers] = useState<number[]>([]);

  const deviceRef        = useRef<Device | null>(null);
  const sendTransportRef = useRef<Transport | null>(null);
  const recvTransportRef = useRef<Transport | null>(null);
  const producerRef      = useRef<Producer | null>(null);
  const consumersRef     = useRef<Map<string, Consumer>>(new Map());
  const audioStreamRef   = useRef<MediaStream | null>(null);
  const audioContextRef  = useRef<AudioContext | null>(null);
  const speakingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioElemsRef    = useRef<HTMLAudioElement[]>([]);

  // ─── Cleanup ──────────────────────────────────────────────

  const cleanup = useCallback(() => {
    if (speakingTimerRef.current) {
      clearInterval(speakingTimerRef.current);
      speakingTimerRef.current = null;
    }
    producerRef.current?.close();
    producerRef.current = null;

    consumersRef.current.forEach((c) => { try { c.close(); } catch { /* ignore */ } });
    consumersRef.current.clear();

    sendTransportRef.current?.close();
    sendTransportRef.current = null;
    recvTransportRef.current?.close();
    recvTransportRef.current = null;

    audioStreamRef.current?.getTracks().forEach((t) => t.stop());
    audioStreamRef.current = null;
    audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;

    audioElemsRef.current.forEach((el) => { el.srcObject = null; });
    audioElemsRef.current = [];

    deviceRef.current = null;
    setIsConnected(false);
    setSpeakingMap(new Map());
    setActiveSpeakers([]);
  }, []);

  // ─── emit مع Promise ──────────────────────────────────────

  function emitP<T>(sock: Socket, event: string, data: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      sock.emit(event, data, (result: unknown) => {
        if (
          result !== null &&
          typeof result === "object" &&
          "error" in (result as Record<string, unknown>)
        ) {
          reject(new Error(String((result as Record<string, unknown>).error)));
        } else {
          resolve(result as T);
        }
      });
    });
  }

  // ─── اشتراك في producer عضو آخر ─────────────────────────

  const subscribeToProducer = useCallback(
    async (producerId: string, overrideDevice?: Device, overrideTransport?: Transport) => {
      const _device    = overrideDevice    ?? deviceRef.current;
      const _transport = overrideTransport ?? recvTransportRef.current;
      if (!socket || !roomCode || !_device || !_transport) return;
      if (consumersRef.current.has(producerId)) return;

      try {
        type ConsumeResult = {
          id: string;
          producerId: string;
          kind: "audio" | "video";
          rtpParameters: mediasoupClient.types.RtpParameters;
        };

        const data = await emitP<ConsumeResult>(socket, "ms:consume", {
          roomCode,
          transportId: _transport.id,
          producerId,
          rtpCapabilities: _device.rtpCapabilities,
        });

        const consumer = await _transport.consume({
          id: data.id,
          producerId: data.producerId,
          kind: data.kind,
          rtpParameters: data.rtpParameters,
        });

        consumersRef.current.set(producerId, consumer);

        const el = new Audio();
        el.srcObject = new MediaStream([consumer.track]);
        audioElemsRef.current.push(el);
        el.play().catch(() => {});

        socket.emit("ms:resumeConsumer", { roomCode, consumerId: consumer.id }, () => {});
      } catch (err) {
        console.error("[mediasoup] subscribe error:", err);
      }
    },
    [socket, roomCode],
  );

  // ─── مؤشر مستوى الصوت ────────────────────────────────────

  const startSpeakingAnalyser = useCallback((stream: MediaStream, localMemberId: number) => {
    try {
      const ctx = new AudioContext();
      audioContextRef.current = ctx;
      const source   = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      speakingTimerRef.current = setInterval(() => {
        analyser.getByteFrequencyData(data);
        const vol = Math.round(data.reduce((a, b) => a + b, 0) / data.length);

        setSpeakingMap((prev) => { const n = new Map(prev); n.set(localMemberId, vol); return n; });

        const THRESHOLD = 12;
        setActiveSpeakers((prev) =>
          vol > THRESHOLD
            ? prev.includes(localMemberId) ? prev : [...prev, localMemberId]
            : prev.filter((id) => id !== localMemberId),
        );
      }, 200);
    } catch { /* AudioContext unavailable */ }
  }, []);

  // ─── الاتصال الرئيسي ─────────────────────────────────────

  const connect = useCallback(async () => {
    if (!socket || !roomCode || !memberId) return;
    try {
      // 1. Device
      const rtpCaps = await emitP<mediasoupClient.types.RtpCapabilities>(
        socket, "ms:getRouterRtpCapabilities", { roomCode },
      );
      const device = new mediasoupClient.Device();
      await device.load({ routerRtpCapabilities: rtpCaps });
      deviceRef.current = device;

      // 2. Send transport
      const sendParams = await emitP<mediasoupClient.types.TransportOptions>(
        socket, "ms:createTransport", { roomCode, direction: "send" },
      );
      const sendTransport = device.createSendTransport(sendParams);
      sendTransportRef.current = sendTransport;

      sendTransport.on("connect", ({ dtlsParameters }, cb, errCb) => {
        socket.emit("ms:connectTransport", { roomCode, transportId: sendTransport.id, dtlsParameters },
          (r: unknown) => {
            typeof r === "object" && r !== null && "error" in (r as Record<string, unknown>)
              ? errCb(new Error(String((r as Record<string, unknown>).error)))
              : cb();
          });
      });

      sendTransport.on("produce", ({ kind, rtpParameters, appData }, cb, errCb) => {
        socket.emit("ms:produce", { roomCode, transportId: sendTransport.id, kind, rtpParameters, appData },
          (r: unknown) => {
            typeof r === "object" && r !== null && "error" in (r as Record<string, unknown>)
              ? errCb(new Error(String((r as Record<string, unknown>).error)))
              : cb({ id: (r as Record<string, unknown>).id as string });
          });
      });

      // 3. Recv transport
      const recvParams = await emitP<mediasoupClient.types.TransportOptions>(
        socket, "ms:createTransport", { roomCode, direction: "recv" },
      );
      const recvTransport = device.createRecvTransport(recvParams);
      recvTransportRef.current = recvTransport;

      recvTransport.on("connect", ({ dtlsParameters }, cb, errCb) => {
        socket.emit("ms:connectTransport", { roomCode, transportId: recvTransport.id, dtlsParameters },
          (r: unknown) => {
            typeof r === "object" && r !== null && "error" in (r as Record<string, unknown>)
              ? errCb(new Error(String((r as Record<string, unknown>).error)))
              : cb();
          });
      });

      // 4. ميكروفون
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      audioStreamRef.current = stream;
      producerRef.current = await sendTransport.produce({ track: stream.getAudioTracks()[0] });

      // 5. المنتجين الموجودين
      const existing = await new Promise<Array<{ memberId: number; producerId: string }>>((resolve) => {
        socket.emit("ms:getExistingProducers", { roomCode }, (r: unknown) =>
          resolve((r as Array<{ memberId: number; producerId: string }>) ?? []));
      });
      for (const { producerId } of existing) {
        await subscribeToProducer(producerId, device, recvTransport);
      }

      // 6. مؤشر الصوت
      startSpeakingAnalyser(stream, memberId);
      setIsConnected(true);
    } catch (err) {
      console.error("[mediasoup] connect error:", err);
      cleanup();
    }
  }, [socket, roomCode, memberId, subscribeToProducer, startSpeakingAnalyser, cleanup]);

  // ─── Toggle Mute ─────────────────────────────────────────

  const toggleMute = useCallback(() => {
    const producer = producerRef.current;
    const stream   = audioStreamRef.current;
    if (!producer || !stream) return;
    const newMuted = !isMuted;
    if (newMuted) {
      producer.pause();
      stream.getAudioTracks().forEach((t) => { t.enabled = false; });
    } else {
      producer.resume();
      stream.getAudioTracks().forEach((t) => { t.enabled = true; });
    }
    setIsMuted(newMuted);
  }, [isMuted]);

  // ─── Socket events ────────────────────────────────────────

  useEffect(() => {
    if (!socket) return;
    const onNew    = ({ producerId }: { memberId: number; producerId: string }) =>
      void subscribeToProducer(producerId);
    const onClosed = ({ producerId }: { memberId: number; producerId: string }) => {
      const c = consumersRef.current.get(producerId);
      if (c) { try { c.close(); } catch { /* ignore */ } consumersRef.current.delete(producerId); }
    };
    socket.on("ms:newProducer",   onNew);
    socket.on("ms:producerClosed", onClosed);
    return () => { socket.off("ms:newProducer", onNew); socket.off("ms:producerClosed", onClosed); };
  }, [socket, subscribeToProducer]);

  // ─── Connect / Disconnect ─────────────────────────────────

  useEffect(() => {
    if (enabled && socket && roomCode && memberId) void connect();
    return () => { cleanup(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, socket?.id, roomCode, memberId]);

  return { isMuted, isConnected, toggleMute, speakingMap, activeSpeakers };
}
