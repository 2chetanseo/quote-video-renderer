# Audio tracks

Drop `.mp3` files here. Each file becomes a selectable track in the Telegram bot.

- The **filename (without .mp3)** is the track id. e.g. `zenith.mp3` -> id `zenith`.
- The bot lists these via `GET /audios` and the user picks one.
- The renderer uses it when `/render` is called with `audio: "asset:<id>"`.

`zenith.mp3` is currently a royalty-free placeholder. Replace it with your real
Zenith track (keep the filename `zenith.mp3`), or add more files like
`calm.mp3`, `epic.mp3`, etc. Commit + push and Render redeploys automatically.

Naming tip: use lowercase, hyphens instead of spaces (e.g. `deep-focus.mp3`).
