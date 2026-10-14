# 01 — Vivix Agora player (doc reference build)

A direct build of <https://docs.vivix.ai/streaming-avatar/integrate/agora>.
`server.mjs`, `index.html` and `main.js` are the doc's code blocks verbatim; `session.json`
is the Quickstart body plus `delivery.media.transport: "agora"` and the FAQ's `auto_close`.

Runs on the default Node 20.17 here (the doc asks for 22; nothing used needs it).

Only code deviation: `server.mjs` listens on `PORT` if set (the doc hardcodes 3000, which is
taken on this machine).

```bash
npm install
npx esbuild main.js --bundle --outfile=app.js
export VIVIX_API_KEY="YOUR_API_KEY"
PORT=3200 node server.mjs        # then open http://localhost:3200 and click Start
```

Plus the Agora microphone step from <https://docs.vivix.ai/streaming-avatar/interaction/conversation>
("Microphone on/off" buttons, code verbatim; Stop calls `stopMicrophone()` before leaving).
Vivix runs ASR → LLM → TTS itself; measured speech end → avatar speaking ≈ 2.1–2.5 s.
Stop calls Vivix close; closing the tab leaves the session to `auto_close` (60 s).
