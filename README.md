# Quote Video Renderer

A free-tier, self-hosted video renderer for vertical "quote shorts" (9:16, 1080x1920).
It runs **ffmpeg** inside a Docker container on **Render's free plan** — something Cloudflare's
free Workers plan cannot do (no ffmpeg / native binaries).

It is called by the n8n workflow **"Quote Shorts Factory - Telegram + JSON2Video"** and replaces
the paid JSON2Video render step with a $0 self-hosted renderer.

## What it does

`POST /render` takes a quote + background + optional audio and returns a rendered MP4:

```json
{
  "quote": "Discipline is the bridge between goals and accomplishment.",
  "author": "Jim Rohn",
  "background_url": "https://example.com/city.mp4",
  "audio_url": "https://example.com/track.mp3",
  "duration": 8
}
```

Response: `video/mp4` binary.

- Background can be an **image** (jpg/png) or a **video** (mp4/mov/webm). Video backgrounds
  loop to fill the duration; a dark overlay is added for text legibility.
- The quote is word-wrapped and centered; the author is shown in gold below it.
- If `audio_url` is provided, it is muxed in (trimmed to the video length).

## Endpoints

- `GET /health` — health check (used by Render and the optional keep-warm cron)
- `POST /render` — render a video (see above)

## Auth (optional)

Set env var `RENDER_API_KEY`. When set, callers must send header `x-api-key: <same value>`.
The n8n workflow sends this header from `$env.RENDER_API_KEY`.

## Deploy to Render (free)

1. Push this folder to a GitHub repo.
2. In the Render dashboard: **New → Web Service** (or **Blueprint** to use `render.yaml`).
3. Runtime: **Docker**. Plan: **Free**. Health check path: `/health`.
4. Deploy. Note the service URL, e.g. `https://quote-video-renderer.onrender.com`.

### Free-tier notes

- Free web services **sleep after ~15 min idle** and cold-start (~50s). The n8n HTTP
  Request timeout should be generous (e.g. 120s) to absorb a cold start + render.
- Free-tier deploys may be **queued during 8am–8pm peak hours**.
- To avoid cold starts during active hours, uncomment the `keep-warm` cron in `render.yaml`
  (or use an external free pinger against `/health`).

## Local run

```bash
npm install
npm start
# in another shell:
curl -X POST http://localhost:10000/render \
  -H 'Content-Type: application/json' \
  -d '{"quote":"Stay hungry, stay foolish.","author":"Steve Jobs","background_url":"https://picsum.photos/1080/1920","duration":6}' \
  --output short.mp4
```

(Local run requires ffmpeg installed on your machine; the Docker image bundles it.)

## How n8n calls it

In the workflow, a single **HTTP Request** node does `POST {RENDER_RENDER_URL}/render` with the
quote/author/background/audio, `responseFormat: file`, and the result is sent to Telegram via
`sendVideo`. No polling loop needed — the response is the MP4.
