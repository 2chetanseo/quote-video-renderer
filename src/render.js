import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 720x1280 (9:16) keeps memory well within the free 512MB instance while staying HD.
const W = 720;
const H = 1280;
const FONT = process.env.FONT_PATH || "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

/**
 * Download a remote URL to a local temp file.
 */
async function download(url, destPath) {
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) {
    throw new Error(`failed to download ${url}: ${resp.status}`);
  }
  const arrayBuf = await resp.arrayBuffer();
  await writeFile(destPath, Buffer.from(arrayBuf));
  return destPath;
}

/**
 * Wrap text to a max number of characters per line (word-aware).
 */
function wrapText(text, maxCharsPerLine = 22) {
  const words = String(text).replace(/\s+/g, " ").trim().split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > maxCharsPerLine) {
      if (current) lines.push(current.trim());
      current = word;
    } else {
      current = (current + " " + word).trim();
    }
  }
  if (current) lines.push(current.trim());
  return lines;
}

/**
 * Escape a string for use inside an ffmpeg drawtext `text='...'` value.
 * ffmpeg is picky: backslash, colon, single quote, percent all need care.
 */
function escapeDrawtext(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\u2019") // replace straight apostrophe with typographic to avoid quote breakage
    .replace(/%/g, "\\%");
}

/**
 * Detect whether the background is a video by extension (best-effort).
 * Falls back to treating it as an image on ambiguous types.
 */
function isVideoUrl(url) {
  return /\.(mp4|mov|webm|mkv|m4v)(\?|$)/i.test(url);
}

/**
 * Render a vertical quote short.
 * Returns { buffer } with the MP4 bytes.
 */
export async function renderQuoteVideo({ quote, author, backgroundUrl, audioUrl, duration }) {
  const work = await mkdtemp(join(tmpdir(), "qvr-"));
  const bgIsVideo = isVideoUrl(backgroundUrl);
  const bgPath = join(work, bgIsVideo ? "bg.mp4" : "bg.img");
  const outPath = join(work, "out.mp4");

  try {
    await download(backgroundUrl, bgPath);
    let audioPath = "";
    if (audioUrl) {
      audioPath = join(work, "audio.m4a");
      try {
        await download(audioUrl, audioPath);
      } catch (e) {
        console.warn("audio download failed, continuing without audio:", e.message);
        audioPath = "";
      }
    }

    // Build the drawtext filter chain for the wrapped quote lines + author.
    // Sized for the 720px-wide canvas.
    const lines = wrapText(quote, 24);
    const fontSize = lines.length > 5 ? 40 : 50;
    const lineSpacing = Math.round(fontSize * 1.35);
    const totalTextHeight = lines.length * lineSpacing;
    const startY = Math.round(H / 2 - totalTextHeight / 2);

    const drawtexts = lines.map((line, i) => {
      const y = startY + i * lineSpacing;
      return [
        `drawtext=fontfile=${FONT}`,
        `text='${escapeDrawtext(line)}'`,
        `fontcolor=white`,
        `fontsize=${fontSize}`,
        `x=(w-text_w)/2`,
        `y=${y}`,
        `shadowcolor=black@0.8`,
        `shadowx=3`,
        `shadowy=3`,
      ].join(":");
    });

    if (author && author.trim() && author.trim().toLowerCase() !== "unknown") {
      const authorY = startY + lines.length * lineSpacing + 40;
      drawtexts.push(
        [
          `drawtext=fontfile=${FONT}`,
          `text='${escapeDrawtext("- " + author.trim())}'`,
          `fontcolor=0xFFD700`,
          `fontsize=30`,
          `x=(w-text_w)/2`,
          `y=${authorY}`,
          `shadowcolor=black@0.8`,
          `shadowx=2`,
          `shadowy=2`,
        ].join(":")
      );
    }

    // Scale + crop background to exactly 1080x1920 (cover), add a dark overlay for text legibility.
    const scaleCrop =
      `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
      `drawbox=x=0:y=0:w=${W}:h=${H}:color=black@0.35:t=fill`;

    const videoFilter = [scaleCrop, ...drawtexts].join(",");

    // Assemble ffmpeg args.
    const args = ["-y"];

    if (bgIsVideo) {
      // Loop the video to fill duration if it is shorter.
      args.push("-stream_loop", "-1", "-i", bgPath);
    } else {
      // Static image looped into a video stream.
      args.push("-loop", "1", "-i", bgPath);
    }

    if (audioPath) {
      args.push("-i", audioPath);
    }

    // Memory-frugal settings so the encode fits the free 512MB Render instance:
    // ultrafast preset + single thread + capped rate/refs keeps RAM low.
    args.push(
      "-t", String(duration),
      "-vf", videoFilter,
      "-r", "24",
      "-threads", "1",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-preset", "ultrafast",
      "-tune", "stillimage",
      "-crf", "28",
      "-x264-params", "ref=1:bframes=0:rc-lookahead=10",
      "-max_muxing_queue_size", "1024",
      "-movflags", "+faststart"
    );

    if (audioPath) {
      args.push("-c:a", "aac", "-b:a", "96k", "-shortest", "-map", "0:v:0", "-map", "1:a:0");
    } else {
      args.push("-an");
    }

    args.push(outPath);

    await runFfmpeg(args);

    const buffer = await readFile(outPath);
    return { buffer };
  } finally {
    // Best-effort cleanup of temp files.
    rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-1500)}`));
    });
  });
}
