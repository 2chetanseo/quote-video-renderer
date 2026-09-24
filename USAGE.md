# Quote Shorts Bot — Usage

An on-demand Telegram bot that turns a quote/idea into a vertical animated short.
No flooding: it polls Telegram every 30s and only acts on genuinely new messages
and button taps (offset-deduplicated).

## Conversation flow

1. **Send any text** (a quote or an idea) to the bot.
   - The bot drafts a polished quote with Cloudflare Workers AI and replies with a
     preview and two buttons: **✅ Use this** / **🔄 Another**.
   - Tap **Another** to regenerate; **Use this** to continue.
2. **Background** — buttons: **⬛ Black** / **🖼️ Image**.
   - **Black**: solid black background (Zenith style).
   - **Image**: the bot generates an AI background from your quote, sends it, and
     offers **✅ Use** / **🔄 Regenerate**.
3. **Audio** — the bot lists the available music tracks (from the renderer's
   `assets/audio` folder) as buttons, plus **🔇 No audio**.
4. The bot renders the short (animated line-by-line text over the chosen
   background, with the chosen audio) and **posts the MP4 back** with the quote,
   author, description and hashtags as the caption.

Send **/start** or **/reset** any time to start over. **/help** shows a summary.

## Adding / changing audio tracks

Drop `.mp3` files into `assets/audio/`. The filename (without `.mp3`) becomes the
track id and the button label. Commit + push; Render redeploys and the new tracks
appear automatically in the bot's audio list.

- Replace `assets/audio/zenith.mp3` (currently a royalty-free placeholder) with the
  real Zenith track, keeping the filename `zenith.mp3`.

## Notes / limits (free tier)

- **Cloudflare Workers AI** free pool is 10,000 neurons/day (resets 00:00 UTC).
  Quote drafting is cheap (~25 neurons). **Image generation is expensive** and can
  drain the daily pool quickly — use the Image background sparingly, or it will
  return an error until the pool resets. Black background is free/unlimited.
- **Render** free instance sleeps after ~15 min idle; the first render after idle
  cold-starts (~50s). The n8n render step waits up to 180s.
- Output is 720x1280 (9:16) H.264, tuned to fit Render's free 512 MB instance.

## Activating the workflow

The workflow is **"Quote Shorts Factory - Interactive"** in n8n. Toggle it **Active**
in the n8n UI. It registers no webhook (polling), so there is no port requirement.
