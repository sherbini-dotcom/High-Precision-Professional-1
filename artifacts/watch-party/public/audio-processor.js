/**
 * audio-processor.js — AudioWorkletProcessor for mic capture.
 *
 * Runs in a dedicated audio rendering thread — never blocked by the main JS
 * thread (React renders, DOM updates, network activity) → glitch-free capture
 * even on weak devices and slow connections.
 *
 * FIX LIST (v2):
 *  [FIX-SEQ]   Each chunk now carries a monotonic seq number so the receiver
 *               can detect and discard out-of-order packets on weak networks.
 *  [FIX-VAD]   VAD threshold is now configurable via port.postMessage from
 *               the main thread (message: { type: "setThreshold", value: 0.01 }).
 *               This lets the UI expose a sensitivity slider without reloading
 *               the worklet.
 *  [FIX-FLUSH] Partial buffer is flushed on port.close() / processor stop so
 *               the last syllable of speech is never silently dropped.
 *
 * Drop this file in: artifacts/watch-party/public/audio-processor.js
 * (Vite serves everything in public/ as-is at the root URL.)
 */

// ── VAD constants ─────────────────────────────────────────────────────────────
// Default RMS ≈ -42 dBFS — real speech is always above this.
// Can be overridden at runtime via port.postMessage({ type: "setThreshold", value: N }).
let VAD_THRESHOLD = 0.008;

// Accumulate ~170 ms of audio before sending (8192 samples at 48 kHz).
// AudioWorklet delivers 128 frames per process() call.
const TARGET_SAMPLES = 8192;

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
      }
      // [FIX-FLUSH] Explicit flush request from stopMic() — sends whatever
      // partial audio is buffered so the last syllable isn't lost.
      if (e.data?.type === "flush") {
        if (this._filled > 0) {
          this._flush(true); // force=true bypasses VAD
          this._filled = 0;
        }
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

    // [FIX-VAD] VAD: skip silent frames to save bandwidth — unless forced.
    if (!force) {
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
      const rms = Math.sqrt(sumSq / buf.length);
      if (rms < VAD_THRESHOLD) return;
    }

    // Convert float32 → int16 for compact network transfer.
    const int16 = new Int16Array(buf.length);
    for (let i = 0; i < buf.length; i++) {
      int16[i] = Math.round(Math.max(-1, Math.min(1, buf[i])) * 32767);
    }

    // [FIX-SEQ] Include sequence number so the receiver can detect
    // out-of-order delivery or dropped packets on lossy connections.
    const seq = this._seq++;

    // Transfer the buffer (zero-copy) to the main thread.
    this.port.postMessage({ int16, seq }, [int16.buffer]);
  }
}

registerProcessor("mic-processor", MicProcessor);