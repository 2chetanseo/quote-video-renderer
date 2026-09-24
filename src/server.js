import express from "express";
import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderQuoteVideo } from "./render.js";

const app = express();
app.use(express.json({ limit: "4mb" }));

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.RENDER_API_KEY || "";

// Cloudflare Workers AI (for AI image backgrounds). Set these env vars on Render.
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || "";
const CF_API_TOKEN = process.env.CF_API_TOKEN || "";
const CF_IMAGE_MODEL = process.env.CF_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AUDIO_DIR = join(ROOT, "assets", "audio");

function requireKey(req, res) {
  if (!API_KEY) return true;
  if ((req.get("x-api-key") || "") === API_KEY) return true;
  res.status(401).json({ error: "unauthorized" });
  return false;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "quote-video-renderer", ts: Date.now() });
});

app.get("/", (_req, res) => {
  res.type("text/plain").send("quote-video-renderer running. Endpoints: /render, /audios, /image, /health");
});

// List available bundled audio tracks (returns [{ id, name }]).
// id is passed back to /render as audio="asset:<id>".
app.get("/audios", (_req, res) => {
  let tracks = [];
  try {
    if (existsSync(AUDIO_DIR)) {
      tracks = readdirSync(AUDIO_DIR)
        .filter((f) => f.toLowerCase().endsWith(".mp3"))
        .map((f) => {
          const id = f.replace(/\.mp3$/i, "");
          return { id, name: id.replace(/[-_]/g, " ") };
        });
    }
  } catch (e) {
    console.warn("audios list error:", e.message);
  }
  res.json({ tracks });
});

/**
 * POST /image
 * Body: { "prompt": "..." }
 * Generates a vertical background image with Cloudflare Workers AI.
 * Returns: image/jpeg binary.
 */
app.post("/image", async (req, res) => {
  if (!requireKey(req, res)) return;
  try {
    if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
      return res.status(501).json({ error: "image_gen_not_configured", detail: "Set CF_ACCOUNT_ID and CF_API_TOKEN env vars." });
    }
    const { prompt } = req.body || {};
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt is required (string)" });
    }

    const fullPrompt =
      `Cinematic vertical 9:16 background for a motivational quote short. ${prompt}. ` +
      `Moody, dramatic lighting, dark tones so white text is readable, no text, no watermark, high detail.`;

    const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${CF_IMAGE_MODEL}`;
    const cfResp = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${CF_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: fullPrompt }),
    });

    if (!cfResp.ok) {
      const t = await cfResp.text();
      return res.status(502).json({ error: "cf_image_failed", detail: t.slice(0, 400) });
    }

    // flux-1-schnell returns JSON { result: { image: "<base64>" } }.
    const ct = cfResp.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const data = await cfResp.json();
      const b64 = data?.result?.image;
      if (!b64) return res.status(502).json({ error: "cf_image_empty" });
      const buf = Buffer.from(b64, "base64");
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Content-Length", buf.length);
      return res.status(200).send(buf);
    }
    // Some models return the image bytes directly.
    const arr = Buffer.from(await cfResp.arrayBuffer());
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Length", arr.length);
    return res.status(200).send(arr);
  } catch (err) {
    console.error("image error:", err);
    return res.status(500).json({ error: "image_failed", detail: String(err?.message || err) });
  }
});

/**
 * POST /render
 * Body:
 * {
 *   "quote": "...",                 // required
 *   "author": "...",                // optional
 *   "background": "black" | "https://.../img.jpg",  // "black" or an image/video URL
 *   "background_url": "...",        // legacy alias for background
 *   "audio": "asset:zenith" | "https://.../track.mp3" | "",  // bundled asset or URL
 *   "audio_url": "...",             // legacy alias for audio
 *   "duration": 8
 * }
 * Returns: video/mp4 binary.
 */
app.post("/render", async (req, res) => {
  if (!requireKey(req, res)) return;
  try {
    const {
      quote,
      author = "",
      background,
      background_url,
      audio,
      audio_url = "",
      duration = 8,
    } = req.body || {};

    if (!quote || typeof quote !== "string") {
      return res.status(400).json({ error: "quote is required (string)" });
    }

    const bg = background || background_url || "black";
    const aud = audio || audio_url || "";
    const safeDuration = Math.min(Math.max(Number(duration) || 8, 3), 60);

    const { buffer } = await renderQuoteVideo({
      quote,
      author,
      background: bg,
      audioUrl: aud,
      duration: safeDuration,
    });

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'inline; filename="short.mp4"');
    res.setHeader("Content-Length", buffer.length);
    return res.status(200).send(buffer);
  } catch (err) {
    console.error("render error:", err);
    return res.status(500).json({ error: "render_failed", detail: String(err?.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`quote-video-renderer listening on :${PORT}`);
});
