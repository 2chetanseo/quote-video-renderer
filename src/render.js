import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

// 720x1280 (9:16) keeps memory well within the free 512MB instance while staying HD.
const W = 720;
const H = 1280;
const FONT = process.env.FONT_PATH || "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "audio");

async function download(url, destPath) {
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) throw new Error(`failed to download ${url}: ${resp.status}`);
  const arrayBuf = await resp.arrayBuffer();
  await writeFile(destPath, Buffer.from(arrayBuf));
  return destPath;
}

/** Word-aware wrap to max chars per line. */
function wrapText(text, maxCharsPerLine = 24) {
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

/** Escape a string for ffmpeg drawtext text='...'. */
function escapeDrawtext(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\u2019")
    .replace(/%/g, "\\%");
}

function isVideoUrl(url) {
  return /\.(mp4|mov|webm|mkv|m4v)(\?|$)/i.test(url);
}

/**
 * Build an animated drawtext filter for one line.
 * Zenith-style: the line fades in and slides up into place, staggered per line,
 * then stays until the end.
 *  - appear: time (s) the line starts animating in
 *  - settleY: final resting y
 *  - fontSize, color
 */
function animatedLine({ text, appear, settleY, fontSize, color }) {
  const dur = 0.6; // fade/slide duration
  const rise = 40; // px it slides up while fading in
  const esc = escapeDrawtext(text);
  // alpha ramps 0->1 over [appear, appear+dur], then stays 1.
  const alpha = `if(lt(t,${appear}),0,if(lt(t,${appear + dur}),(t-${appear})/${dur},1))`;
  // y slides from settleY+rise up to settleY over the same window, then holds.
  const y = `if(lt(t,${appear}),${settleY + rise},if(lt(t,${appear + dur}),${settleY + rise}-(${rise}*(t-${appear})/${dur}),${settleY}))`;
  return [
    `drawtext=fontfile=${FONT}`,
    `text='${esc}'`,
    `fontcolor=${color}`,
    `fontsize=${fontSize}`,
    `x=(w-text_w)/2`,
    `y=${y}`,
    `alpha=${alpha}`,
    `shadowcolor=black@0.8`,
    `shadowx=3`,
    `shadowy=3`,
  ].join(":");
}

/**
 * Render a vertical quote short with animated text.
 *
 * Params:
 *  - quote (required)
 *  - author (optional)
 *  - background: "black" | image/video URL  (backgroundUrl kept for compatibility)
 *  - audioUrl (optional): remote URL OR a local asset name like "asset:zenith"
 *  - duration (seconds)
 * Returns { buffer }.
 */
export async function renderQuoteVideo({ quote, author, backgroundUrl, background, audioUrl, duration }) {
  const work = await mkdtemp(join(tmpdir(), "qvr-"));
  const outPath = join(work, "out.mp4");

  // Normalize background: "black" or a URL.
  const bg = background || backgroundUrl || "black";
  const useBlack = !bg || bg === "black";
  const bgIsVideo = !useBlack && isVideoUrl(bg);
  const bgPath = useBlack ? "" : join(work, bgIsVideo ? "bg.mp4" : "bg.img");

  try {
    if (!useBlack) {
      await download(bg, bgPath);
    }

    // Resolve audio: local asset (asset:<name>) or remote URL.
    let audioPath = "";
    if (audioUrl) {
      try {
        if (audioUrl.startsWith("asset:")) {
          const name = audioUrl.slice("asset:".length);
          const candidate = join(ASSETS_DIR, `${name}.mp3`);
          if (existsSync(candidate)) audioPath = candidate;
        } else {
          audioPath = join(work, "audio.m4a");
          await download(audioUrl, audioPath);
        }
      } catch (e) {
        console.warn("audio unavailable, continuing silent:", e.message);
        audioPath = "";
      }
    }

    // Text layout.
    const lines = wrapText(quote, 24);
    const fontSize = lines.length > 5 ? 40 : 52;
    const lineSpacing = Math.round(fontSize * 1.4);
    const hasAuthor = author && author.trim() && author.trim().toLowerCase() !== "unknown";
    const blockH = lines.length * lineSpacing + (hasAuthor ? 60 : 0);
    const startY = Math.round(H / 2 - blockH / 2);

    // Staggered appear times (line by line).
    const stagger = 0.45;
    const drawtexts = lines.map((line, i) =>
      animatedLine({
        text: line,
        appear: 0.3 + i * stagger,
        settleY: startY + i * lineSpacing,
        fontSize,
        color: "white",
      })
    );
    if (hasAuthor) {
      drawtexts.push(
        animatedLine({
          text: "- " + author.trim(),
          appear: 0.3 + lines.length * stagger,
          settleY: startY + lines.length * lineSpacing + 30,
          fontSize: 30,
          color: "0xFFD700",
        })
      );
    }

    // Base layer.
    let baseFilter;
    if (useBlack) {
      // Solid black is generated by the color source input; just add a subtle vignette-free box (noop) then text.
      baseFilter = drawtexts.join(",");
    } else {
      const scaleCrop =
        `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
        `drawbox=x=0:y=0:w=${W}:h=${H}:color=black@0.4:t=fill`;
      baseFilter = [scaleCrop, ...drawtexts].join(",");
    }

    const args = ["-y"];

    if (useBlack) {
      args.push("-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=24:d=${duration}`);
    } else if (bgIsVideo) {
      args.push("-stream_loop", "-1", "-i", bgPath);
    } else {
      args.push("-loop", "1", "-i", bgPath);
    }

    if (audioPath) args.push("-i", audioPath);

    // Memory-frugal encode for the free 512MB instance.
    args.push(
      "-t", String(duration),
      "-vf", baseFilter,
      "-r", "24",
      "-threads", "1",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-preset", "ultrafast",
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
