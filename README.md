# Vivix × Agora ConvoAI demo

An Agora Conversational AI agent — ASR, LLM and voice configured by a console **pipeline ID** —
drives a [Vivix](https://docs.vivix.ai) streaming avatar. Type your own Agora and Vivix
credentials into the page; they go only to this local backend, per request.

```
mic ─► Agora channel (your App ID) ─► ConvoAI agent ─► TTS audio
                                                         │ relayed by the browser
avatar video + audio ◄─ Vivix renders ◄─ Vivix channel ◄─┘ (pure rendering / passthrough)
```

Vivix is not a ConvoAI avatar vendor and only joins channels it provisions, so the browser
republishes the agent's voice into the Vivix channel. See
`docs/superpowers/specs/2026-10-14-vivix-convoai-demo-design.md`.

## Run

```bash
npm install
npm run build
npm start                 # http://localhost:8787
```

Development with hot reload: `npm start` in one terminal, `npm run dev:web` in another
(http://localhost:5180, proxies `/api` to 8787).

## Credentials

| Field | Where |
|---|---|
| Agora App ID / App Certificate | console.agora.io → Projects (enable the primary certificate) |
| ConvoAI pipeline ID | console.agora.io → Agents → publish an agent → Code panel |
| Vivix API key | Vivix console |
| Avatar image URL (optional) | any https image; default is the Vivix Quickstart portrait |
| Persona override (optional) | replaces the agent's prompt for this session |

"Remember on this device" stores them in this browser's localStorage; otherwise they live
only in the page.

> ⚠️ **"Remember on this device" saves the App Certificate and Vivix API key in this
> browser's localStorage in plain text.** Anyone with access to this browser profile can read
> them. Use it only on a machine you trust.

## Latency

The side panel shows the startup timeline and, per turn, the time from the agent's voice
becoming audible to the avatar's: measured 2.2–2.9 s, almost all of it inside Vivix's
passthrough renderer (the relay itself is ready ~40 ms after the agent's audio arrives).

## Test

```bash
npm test                  # unit tests
npm run build && npm start &
E2E_WAV=speech.wav node --env-file=.env e2e/smoke.mjs   # real services, headless Chrome
```

## Cleanup and cost

Stop closes both upstream sessions. A closed tab sends a beacon to do the same; if that is
lost, ConvoAI stops after 60 s alone in the channel and Vivix closes 60 s after its control
connection drops (sessions are capped at 20 minutes).

## ⚠️ Demo only

The backend binds 127.0.0.1 and has no authentication or rate limiting. Do not expose it
publicly as is.

`01-agora-player/` is the Vivix Agora guide built as documented; `02-convoai-spike/` is the
throwaway spike that proved the relay.
