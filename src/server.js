import express from "express";
import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderQuoteVideo } from "./render.js";
import { cfQuote, cfImage, cfConfigured, cfAccountCount } from "./cloudflare.js";

const app = express();
app.use(express.json({ limit: "4mb" }));

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.RENDER_API_KEY || "";

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AUDIO_DIR = join(ROOT, "assets", "audio");
// Generated background images are cached here and served via /img/:id so the
// render step can fetch them back by URL.
const IMG_CACHE = join(tmpdir(), "qvr-images");
try { mkdirSync(IMG_CACHE, { recursive: true }); } catch {}

function requireKey(req, res) {
  if (!API_KEY) return true;
  if ((req.get("x-api-key") || "") === API_KEY) return true;
  res.status(401).json({ error: "unauthorized" });
  return false;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "quote-video-renderer", ts: Date.now(), cfAccounts: cfAccountCount() });
});

/**
 * POST /quote  { "idea": "..." }
 * Generates the quote JSON via Cloudflare Workers AI, rotating across accounts
 * to avoid rate limits. Returns { quote, author, description, hashtags }.
 */
app.post("/quote", async (req, res) => {
  if (!requireKey(req, res)) return;
  try {
    if (!cfConfigured()) return res.status(501).json({ error: "cf_not_configured" });
    const idea = (req.body && req.body.idea) || "";
    if (!idea) return res.status(400).json({ error: "idea is required" });
    const p = await cfQuote(idea);
    const hashtags = Array.isArray(p.hashtags)
      ? p.hashtags.map((t) => "#" + String(t).replace(/^#+/, "").replace(/\s+/g, "")).join(" ")
      : "";
    return res.json({
      quote: (p.quote || "").toString().trim(),
      author: (p.author || "Unknown").toString().trim(),
      description: (p.description || "").toString().trim(),
      hashtags,
    });
  } catch (err) {
    console.error("quote error:", err);
    return res.status(502).json({ error: "quote_failed", detail: String(err?.message || err) });
  }
});

// Serve cached generated background images (used by the render step).
app.use("/img", express.static(IMG_CACHE, { maxAge: "1h" }));

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
    if (!cfConfigured()) {
      return res.status(501).json({ error: "image_gen_not_configured", detail: "Configure Cloudflare accounts (CF_ACCOUNTS or CF_ACCOUNT_ID/CF_API_TOKEN)." });
    }
    const { prompt } = req.body || {};
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt is required (string)" });
    }

    // Generate via the rotation client (auto-fails over across accounts on 429/quota).
    const buf = await cfImage(prompt);

    const id = randomUUID().slice(0, 12);
    const file = join(IMG_CACHE, `${id}.jpg`);
    writeFileSync(file, buf);
    const publicUrl = `${req.protocol}://${req.get("host")}/img/${id}.jpg`;
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("X-Image-Url", publicUrl);
    res.setHeader("Content-Length", buf.length);
    return res.status(200).send(buf);
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
