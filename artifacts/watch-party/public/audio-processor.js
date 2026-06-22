/**
 * audio-processor.js — AudioWorkletProcessor for mic capture.
 *
 * [FIX] Replaces the deprecated ScriptProcessorNode which ran on the main JS
 * thread and caused audio stuttering whenever the UI was busy (React renders,
 * DOM updates, network activity). AudioWorkletProcessor runs in a dedicated
 * audio rendering thread that is never blocked by the main thread, producing
 * glitch-free capture even on weak devices and slow connections.
 *
 * Drop this file in: artifacts/watch-party/public/audio-processor.js
 * (Vite serves everything in public/ as-is at the root URL.)
 *
 * Usage (in room.tsx):
 *   await audioContext.audioWorklet.addModule("/audio-processor.js");
 *   const workletNode = new AudioWorkletNode(ctx, "mic-processor");
 *   workletNode.port.onmessage = (e) => { ... send e.data.int16 via socket ... };
 */

// ── VAD constants (must mirror room.tsx values) ──────────────────────────────
const VAD_THRESHOLD = 0.008; // RMS ≈ -42 dBFS — real speech is always above this
// Accumulate ~170 ms of audio before sending (matches the old 8192-sample buffer
// at 48 kHz). Keeps the number of socket emits identical to the old approach.
const FRAMES_PER_CHUNK = 256; // process() delivers 128 frames; 2 calls = 256 frames
                               // We accumulate until we hit TARGET_SAMPLES.
const TARGET_SAMPLES = 8192;  // same as the old createScriptProcessor(8192, 1, 1)

class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(TARGET_SAMPLES);
    this._filled = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channel = input[0]; // mono — one channel
    for (let i = 0; i < channel.length; i++) {
      this._buffer[this._filled++] = channel[i];

      if (this._filled >= TARGET_SAMPLES) {
        this._flush();
        this._filled = 0;
      }
    }

    // Returning true keeps the processor alive.
    return true;
  }

  _flush() {
    const buf = this._buffer.slice(0, this._filled || TARGET_SAMPLES);

    // VAD: compute RMS — skip silent frames to save bandwidth.
    let sumSq = 0;
    for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
    const rms = Math.sqrt(sumSq / buf.length);
    if (rms < VAD_THRESHOLD) return;

    // Convert float32 → int16 for compact network transfer.
    const int16 = new Int16Array(buf.length);
    for (let i = 0; i < buf.length; i++) {
      int16[i] = Math.round(Math.max(-1, Math.min(1, buf[i])) * 32767);
    }

    // Transfer the buffer (zero-copy) to the main thread.
    this.port.postMessage({ int16 }, [int16.buffer]);
  }
}

registerProcessor("mic-processor", MicProcessor);
