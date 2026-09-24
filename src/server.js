import express from "express";
import { renderQuoteVideo } from "./render.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
// Optional shared secret. If set, callers must send header `x-api-key` matching it.
const API_KEY = process.env.RENDER_API_KEY || "";

// Health check (used by Render + optional keep-warm cron)
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "quote-video-renderer", ts: Date.now() });
});

app.get("/", (_req, res) => {
  res.type("text/plain").send(
    "quote-video-renderer is running. POST /render with { quote, author, background_url, audio_url, duration }."
  );
});

/**
 * POST /render
 * Body:
 * {
 *   "quote": "The text of the quote",
 *   "author": "Author name",          // optional
 *   "background_url": "https://...",   // image OR video URL (required)
 *   "audio_url": "https://...",        // audio track URL (optional)
 *   "duration": 8                       // seconds (optional, default 8)
 * }
 * Returns: video/mp4 binary (the rendered vertical short)
 */
app.post("/render", async (req, res) => {
  try {
    if (API_KEY) {
      const provided = req.get("x-api-key") || "";
      if (provided !== API_KEY) {
        return res.status(401).json({ error: "unauthorized" });
      }
    }

    const {
      quote,
      author = "",
      background_url,
      audio_url = "",
      duration = 8,
    } = req.body || {};

    if (!quote || typeof quote !== "string") {
      return res.status(400).json({ error: "quote is required (string)" });
    }
    if (!background_url || typeof background_url !== "string") {
      return res.status(400).json({ error: "background_url is required (string)" });
    }

    const safeDuration = Math.min(Math.max(Number(duration) || 8, 3), 60);

    const { buffer } = await renderQuoteVideo({
      quote,
      author,
      backgroundUrl: background_url,
      audioUrl: audio_url,
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
