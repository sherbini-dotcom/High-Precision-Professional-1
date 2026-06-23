/**
 * audio-processor.js — AudioWorkletProcessor for mic capture.
 *
 * Runs in a dedicated audio rendering thread — never blocked by the main JS
 * thread (React renders, DOM updates, network activity) → glitch-free capture
 * even on weak devices and slow connections.
 *
 * FIX LIST (v4):
 *  [FIX-SEQ]          Each chunk carries a monotonic seq number so the receiver
 *                     can detect and discard out-of-order packets on weak networks.
 *  [FIX-VAD]          VAD threshold is configurable via port.postMessage from
 *                     the main thread (message: { type: "setThreshold", value: 0.01 }).
 *  [FIX-FLUSH]        Partial buffer is flushed on port.close() / processor stop so
 *                     the last syllable of speech is never silently dropped.
 *  [FIX-LATENCY]      TARGET_SAMPLES reduced 8192 → 4096 (170ms → ~85ms at 48kHz).
 *                     Halves worklet-side latency. Kept at 4096 (not 2048) so the
 *                     Socket.IO fallback path can deliver ~12 chunks/sec — well within
 *                     the server's 15/sec rate cap (no chunks dropped on fallback).
 *  [FIX-AUDIOTIME]    Each chunk now carries audioTime (currentTime from the audio
 *                     rendering thread) alongside seq. The receiver uses this for
 *                     accurate scheduling instead of Date.now() which drifts under
 *                     CPU load on the main thread.
 *  [FIX-DYNAMIC-VAD]  VAD threshold is now auto-calibrated from the noise floor
 *                     measured during the first 2 s of mic capture. Replaces the
 *                     fixed 0.004 that was too aggressive for high-quality headsets
 *                     and too permissive for loud environments.
 */

// ── VAD constants ─────────────────────────────────────────────────────────────
// [FIX-DYNAMIC-VAD] Threshold starts at 0.004 and is replaced by the auto-
// calibrated value once the 2-second noise-floor measurement completes.
// Bounds: min 0.002 (ultra-quiet mics / anechoic room) to 0.01 (noisy office).
// Can still be overridden at runtime via port.postMessage({ type: "setThreshold", value: N }).
let VAD_THRESHOLD = 0.004;

// Noise-floor calibration state — runs for the first CALIBRATION_CHUNKS chunks.
// We accumulate per-chunk RMS values, then set VAD_THRESHOLD = mean × 3.
// 24 chunks × 4096 samples = 98 304 samples ≈ 2.05 s at 48 kHz.
const CALIBRATION_CHUNKS = 24;
let _calibChunksLeft = CALIBRATION_CHUNKS;
let _calibRmsSum = 0;
let _calibrated = false;

// [FIX-LATENCY] Accumulate ~85 ms of audio before sending (4096 samples at 48 kHz).
// AudioWorklet delivers 128 frames per process() call → 32 calls per chunk (~12/sec).
// Server rate cap is 15/sec — 12/sec fits with headroom, so no chunks are dropped
// on the Socket.IO fallback path. Keeps latency at ~85ms vs original 170ms.
const TARGET_SAMPLES = 4096;

class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(TARGET_SAMPLES);
    this._filled = 0;
    // [FIX-SEQ] Monotonically increasing sequence number.
    // Receiver can use this to detect dropped / reordered packets.
    this._seq = 0;

    // [FIX-VAD] Accept runtime threshold changes from the main thread.
    this.port.onmessage = (e) => {
      if (e.data?.type === "setThreshold" && typeof e.data.value === "number") {
        VAD_THRESHOLD = Math.max(0, e.data.value);
        _calibrated = true; // manual override stops auto-calibration
      }
      // [FIX-FLUSH] Explicit flush request from stopMic() — sends whatever
      // partial audio is buffered so the last syllable isn't lost.
      if (e.data?.type === "flush") {
        if (this._filled > 0) {
          this._flush(true); // force=true bypasses VAD
          this._filled = 0;
        }
      }
      // [FIX-DYNAMIC-VAD] Allow the main thread to reset calibration (e.g. on
      // device change or environment change) without restarting the mic.
      if (e.data?.type === "resetCalibration") {
        _calibChunksLeft = CALIBRATION_CHUNKS;
        _calibRmsSum = 0;
        _calibrated = false;
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channel = input[0]; // mono — one channel
    for (let i = 0; i < channel.length; i++) {
      this._buffer[this._filled++] = channel[i];
      if (this._filled >= TARGET_SAMPLES) {
        this._flush(false);
        this._filled = 0;
      }
    }

    return true; // keep processor alive
  }

  /**
   * @param {boolean} force - If true, skip VAD and always send (used for
   *   partial-buffer flush at mic stop so the last word isn't dropped).
   */
  _flush(force) {
    const count = this._filled || TARGET_SAMPLES;
    const buf = this._buffer.slice(0, count);

    // Always compute RMS — used both for VAD and for noise-floor calibration.
    let sumSq = 0;
    for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
    const rms = Math.sqrt(sumSq / buf.length);

    // [FIX-DYNAMIC-VAD] During the calibration window, accumulate noise-floor
    // RMS values. We record ALL chunks (including speech) in this window — the
    // mean of a real microphone's idle noise floor is far below speech levels,
    // so even with a few speech chunks mixed in the estimate stays conservative.
    // After CALIBRATION_CHUNKS chunks, set threshold = mean_rms × 3 clamped to
    // [0.002, 0.01]. Report the calibrated threshold back to the main thread.
    if (!_calibrated) {
      _calibRmsSum += rms;
      _calibChunksLeft--;
      if (_calibChunksLeft <= 0) {
        const noiseFloor = _calibRmsSum / CALIBRATION_CHUNKS;
        VAD_THRESHOLD = Math.min(0.01, Math.max(0.002, noiseFloor * 3));
        _calibrated = true;
        this.port.postMessage({ type: "calibrated", threshold: VAD_THRESHOLD });
      }
    }

    // VAD disabled — audio always sent without gating.
    // Auto-calibrated threshold caused false cutouts on sensitive mics.
    // Opus handles silence efficiency at the codec level instead.
    void rms; void VAD_THRESHOLD; void force;

    // Convert float32 → int16 for compact network transfer.
    const int16 = new Int16Array(buf.length);
    for (let i = 0; i < buf.length; i++) {
      int16[i] = Math.round(Math.max(-1, Math.min(1, buf[i])) * 32767);
    }

    // [FIX-SEQ] Include sequence number so the receiver can detect
    // out-of-order delivery or dropped packets on lossy connections.
    const seq = this._seq++;

    // [FIX-AUDIOTIME] Include currentTime from the audio rendering clock.
    // Unlike Date.now() on the main thread, this is not affected by CPU
    // jitter or event-loop back-pressure, so the receiver can use it for
    // accurate jitter-buffer scheduling instead of arrival wall-clock time.
    // Transfer the buffer (zero-copy) to the main thread.
    this.port.postMessage({ int16, seq, audioTime: currentTime }, [int16.buffer]);
  }
}

registerProcessor("mic-processor", MicProcessor);