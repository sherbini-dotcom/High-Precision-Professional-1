import ffmpeg from "fluent-ffmpeg";
import path from "path";
import fs from "fs";

interface StreamInfo {
  videoCodec: string | null;
  pixelFormat: string | null;
  audioCodec: string | null;
}

// Probe the input file for video/audio stream properties.
// Returns null fields on failure so callers can fall back to full transcode.
function detectStreamInfo(inputPath: string): Promise<StreamInfo> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) {
        resolve({ videoCodec: null, pixelFormat: null, audioCodec: null });
        return;
      }
      const videoStream = metadata.streams.find((s) => s.codec_type === "video");
      const audioStream = metadata.streams.find((s) => s.codec_type === "audio");
      resolve({
        videoCodec: videoStream?.codec_name ?? null,
        pixelFormat: videoStream?.pix_fmt ?? null,
        audioCodec: audioStream?.codec_name ?? null,
      });
    });
  });
}

export async function processToHls(
  inputPath: string,
  outputDir: string,
  onProgress: (percent: number) => void,
  onDone: (hlsDir: string) => void,
  onError: (err: Error) => void
): Promise<void> {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const playlistPath = path.join(outputDir, "playlist.m3u8");

  const { videoCodec, pixelFormat, audioCodec } = await detectStreamInfo(inputPath);

  // Stream-copy is only safe when ALL three conditions hold:
  //
  //   1. Video codec is H.264 — any other codec (HEVC from iPhone, AV1/VP9 from
  //      Android Chrome screen-capture, etc.) must be re-encoded.
  //
  //   2. Pixel format is yuv420p — Android phones that record in HDR or high-bit-depth
  //      mode produce yuv420p10le / yuv420p12le / p010le / etc. Browsers reject anything
  //      other than 8-bit 4:2:0 inside an HLS stream, so the video freezes immediately
  //      on load with no error shown to the user. A null pix_fmt (probe failure) is also
  //      treated as "unsafe", so we transcode rather than guess.
  //
  //   3. Audio codec is AAC — HLS requires AAC audio. Android WebM recordings and some
  //      Android Chrome captures use Opus or MP3. Opus inside an MP4/TS container is
  //      rejected by most HLS parsers; MP3 causes Safari + iOS to stall on every segment.
  //      A null audioCodec (silent video or probe failure) is safe to pass through aac
  //      re-encode since ffmpeg will produce silence if there is no audio stream.
  //
  // When any condition fails we fall through to the full transcode path which produces
  // a universally compatible H.264/yuv420p/AAC stream identical to what the iPhone fix
  // already applies.
  const needsTranscode =
    videoCodec !== "h264" ||
    pixelFormat !== "yuv420p" ||          // null → unsafe → transcode
    (audioCodec !== null && !audioCodec.startsWith("aac"));

  const videoOptions: string[] = needsTranscode
    ? [
        // Re-encode to H.264 with ultrafast preset — trades some compression
        // efficiency for maximum encoding speed. For watch-party use the
        // quality difference is imperceptible.
        "-c:v libx264",
        "-preset ultrafast",
        "-crf 26",
        // profile:v main + level 4.0 ensures iPhone/Safari can decode the output.
        // Without an explicit profile some encoders emit high-profile streams that
        // older iOS versions refuse to play inside an HLS <video> element.
        "-profile:v main",
        "-level 4.0",
        // yuv420p is required for broad browser/device compatibility.
        // Android HDR sources transcode to yuv420p10le by default; -pix_fmt forces 8-bit.
        "-pix_fmt yuv420p",
        // Ensure even pixel dimensions required by H.264 encoder.
        "-vf scale=trunc(iw/2)*2:trunc(ih/2)*2",
      ]
    : [
        // H.264 + yuv420p + AAC — safe to stream-copy with no quality loss.
        "-c:v copy",
      ];

  // Always re-encode audio to AAC for HLS compatibility.
  // This is a no-op quality penalty for sources that already have AAC because
  // the bitrate (128k) matches typical Android/iPhone recording rates.
  const audioOptions: string[] = ["-c:a aac", "-b:a 128k"];

  // HLS flags applied for BOTH copy and transcode paths:
  //   independent_segments — marks each segment as independently decodable in
  //   the manifest. Without this, players may refuse to seek into a segment that
  //   does not start on a keyframe. For copy mode we cannot force new keyframes,
  //   but the flag still improves seek reliability on Android Chrome/Firefox because
  //   the player is told it is allowed to start decoding from any segment boundary.
  //
  // Extra flags for transcode path only:
  //   force_key_frames — inserts an IDR frame every 4 s, exactly matching hls_time.
  //   This guarantees every segment boundary is also a keyframe so any client can
  //   seek to within 4 s of the target without stalling.
  const hlsFlags: string[] = needsTranscode
    ? [
        "-hls_flags", "independent_segments",
        "-force_key_frames", "expr:gte(t,n_forced*4)",
      ]
    : [
        // Copy mode: we cannot insert new keyframes, but we still mark segments as
        // independent so clients attempt decoding from each boundary rather than
        // bailing out. Android phones recording at 30fps typically place a keyframe
        // every 1–2 s so segment alignment is usually fine in practice.
        "-hls_flags", "independent_segments",
      ];

  ffmpeg(inputPath)
    .outputOptions([
      ...videoOptions,
      ...audioOptions,
      "-map_metadata", "0",
      "-start_number", "0",
      // 4-second segments give clients shorter download units, reducing stall time
      // on seek and improving initial buffering speed on mobile connections.
      "-hls_time", "4",
      "-hls_list_size", "0",
      ...hlsFlags,
      "-hls_segment_filename", path.join(outputDir, "segment%03d.ts"),
      "-f", "hls",
    ])
    .output(playlistPath)
    .on("progress", (progress) => {
      // progress.percent can be NaN for HEVC/AV1 transcoding — guard with isFinite.
      const percent = Math.round(Number.isFinite(progress.percent) ? progress.percent : 0);
      // Suppress unhandled rejection — async callbacks must never escape to Node's
      // top-level unhandledRejection handler (Node 24 crashes the process on that).
      Promise.resolve(onProgress(Math.min(percent, 99))).catch(() => {});
    })
    .on("end", () => {
      Promise.resolve(onDone(outputDir)).catch(() => {});
    })
    .on("error", (err) => {
      Promise.resolve(onError(err)).catch(() => {});
    })
    .run();
}
