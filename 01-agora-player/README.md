# 01 — Vivix Agora player (doc reference build)

A direct build of <https://docs.vivix.ai/streaming-avatar/integrate/agora>.
`server.mjs`, `index.html` and `main.js` are the doc's code blocks verbatim; `session.json`
is the Quickstart body plus `delivery.media.transport: "agora"` and the FAQ's `auto_close`.

Only deviation: `server.mjs` listens on `PORT` if set (the doc hardcodes 3000, which is
taken on this machine).

```bash
nvm use 22
npm install
npx esbuild main.js --bundle --outfile=app.js
export VIVIX_API_KEY="YOUR_API_KEY"
PORT=3200 node server.mjs        # then open http://localhost:3200 and click Start
```

This is a viewer: it plays the avatar's video and audio and never opens the microphone.
Stop calls Vivix close; closing the tab leaves the session to `auto_close` (60 s).
