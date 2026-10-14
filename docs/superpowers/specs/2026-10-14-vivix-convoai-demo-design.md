# Vivix × Agora ConvoAI web demo — design

Date: 2026-10-14 · Status: approved; updated after spike `02-convoai-spike`

## Goal

A streamlined, low-latency web demo in which an **Agora Conversational AI agent**
(configured by a console `pipeline_id`: ASR → LLM → TTS) drives a **Vivix streaming
avatar**. The customer types their own Agora and Vivix credentials into the page.

Scope of v1: web only, one conversation screen. No mobile clients, no scenes.

## Why not the Spatius approach

`spatius-scenario-demo` passes the avatar to ConvoAI as `properties.avatar.vendor =
"spatius"`, so Agora's engine feeds TTS to the avatar vendor server-side. Vivix is not a
ConvoAI avatar vendor, and Vivix's Agora delivery is **Vivix-provisioned**: the create
response returns its own `app_id` / `channel_name` / `token` ("session-scoped … not provider
account credentials"). The customer's Agora project cannot be pointed at it.

Vivix does offer **pure rendering mode**: `pipeline_config.a2a_config = { enable_a2a: true,
provider: "passthrough" }` animates the avatar from audio the client publishes into the
Vivix RTC room. The browser bridges the two.

## Media path

```
mic ──► channel A (customer App ID) ──► ConvoAI agent (pipeline_id)
                                           │ TTS audio
browser ◄──────────────────────────────────┘  subscribed, never played
   │ same MediaStreamTrack → AgoraRTC.createCustomAudioTrack → publish
   ▼
channel B (Vivix-provisioned, passthrough) ──► Vivix renders ──► avatar video + audio ──► played
```

- Two `AgoraRTC` clients, one SDK bundle. Channel A: publish mic, subscribe the agent uid's
  audio only. Channel B: publish the relayed track, subscribe `publisher_user_id` only.
- The avatar's audio is the only audio played, so browser AEC sees one far-end signal.
- Interruption is native to ConvoAI: agent audio stops, the avatar goes quiet.
- Transcripts arrive over the RTC datastream (`parameters.data_channel = "datastream"`,
  `transcript.enable`) as `stream-message` events on channel A — no RTM SDK.
- The Vivix control WebSocket is opened (keeps the session alive for `auto_close`) but
  carries no traffic in v1.

## Backend — `server/`

Node >= 20.6 (runs on 20.17), built-in `http` and `fetch`; only dependency `agora-token`. Stateless: every
request carries the credentials it needs; nothing is written to disk. Binds `127.0.0.1`
by default, port 8787 (`HOST` / `PORT` override). In production it also serves `web/dist`.

| Route | Body | Does |
|---|---|---|
| `POST /api/session` | `{ agora: {appId, certificate, pipelineId, persona?}, vivix: {apiKey, imageUrl?} }` | In parallel: Vivix create + ConvoAI join. Rolls back the side that succeeded if the other fails. Returns both credential sets, Vivix control URL/secret, and per-call timings (ms). |
| `POST /api/session/stop` | `{ agora, vivix, agentId, vivixSessionId }` | In parallel: ConvoAI `leave` (404 = ok) and Vivix `close` (`closing`/`closed` = ok). |
| `POST /api/session/interrupt` | `{ agora, agentId }` | ConvoAI `interrupt`. |
| `GET /health` | — | `{ ok: true }` |

Modules:

- `agora.mjs` — UID minting (user / agent, non-overlapping ranges), AccessToken2 for the
  user and the agent, REST auth signed from App ID + certificate (`agora token="…"`, as in the
  reference), `join` / `leave` / `interrupt`. Join body: `name`, `pipeline_id`, `properties`
  with `channel`, `token`, `agent_rtc_uid`, `remote_rtc_uids: [user]`, `idle_timeout: 60`,
  `parameters: { data_channel: "datastream", enable_error_message: true }`, transcript
  enabled.
- `vivix.mjs` — `create` (body below) and `close`; envelope check `code === 0`.
- `app.mjs` — routing, JSON parsing with a size cap, input validation (`index.mjs` only
  starts the listener).
- `upstream.mjs` — value-based redaction: every submitted secret (API key, certificate) and
  every derived secret (REST auth token, agent and user RTC tokens) is replaced by
  `<redacted>` in upstream messages. This replaces the earlier keyword scrub.

Vivix create body:

```json
{
  "model": "vivix-a1-stream",
  "output": { "aspect_ratio": "9:16", "resolution": "720p" },
  "avatars": [{ "avatar_id": "host", "persona": "<short neutral persona>",
    "visual": { "source_images": [{ "source_image_id": "portrait",
      "url": "<imageUrl or Quickstart default>", "media_type": "image/jpeg" }] } }],
  "pipeline_config": {
    "tts_config": { "tts_voice_id": "longanhuan_v3.6" },
    "a2a_config": { "enable_a2a": true, "provider": "passthrough" }
  },
  "delivery": { "media": { "transport": "agora" } },
  "max_duration_seconds": 1200,
  "auto_close": { "disconnected_timeout_seconds": 60 }
}
```

`tts_config` is required even in passthrough: without it Vivix returns HTTP 500 / code 50001
(found in the spike). The voice is never heard.

Optional `persona` (typed in the UI) is sent as ConvoAI `properties.llm.system_messages`, overriding
the published agent's prompt for this session only; empty means the agent's own prompt is used.

## Web — `web/`

Vite + vanilla TypeScript, no framework.

- `config.ts` — credentials form state; "remember on this device" saves to `localStorage`,
  otherwise memory only.
- `session.ts` — orchestration: on Start, request the mic **in parallel** with
  `POST /api/session`; then join channel A, join channel B and open the control WebSocket in
  parallel; the relay starts as soon as channel B's RTC join completes (it does not wait for the control
  socket, though Start still fails if the socket fails); Stop tears down in reverse and calls `/api/session/stop`; `pagehide`
  sends the stop via `navigator.sendBeacon`.
- `convo.ts` — channel A client (mic publish, agent audio subscribe, datastream).
- `avatar.ts` — channel B client + control WebSocket (15 s open timeout).
- `relay.ts` — agent `MediaStreamTrack` → custom audio track → publish on channel B;
  re-relays if the agent republishes (publishes a clone, so closing a relay never stops
  the agent's remote track).
- `transcript.ts` — reassembles chunked datastream messages
  (`<id>|<part>|<total>|<base64>`) and renders user/agent lines, partial then final.
- `metrics.ts` — startup timeline (Vivix create, ConvoAI join, channel A join, channel B
  join, agent joined, avatar first frame) and per-turn relay latency: agent-audio onset vs
  avatar-audio onset, sampled from `getVolumeLevel()` every 50 ms.
- UI: credentials panel (collapsible once started), 9:16 stage, Start/Stop, mic mute,
  Interrupt, transcript, metrics. Autoplay failure shows an "Enable sound" button.

## Error handling

- Missing/invalid credential fields: 400 with the field name, shown next to the field.
- Partial create failure: rollback, surface the failing side's scrubbed message.
- RTC/control failures after start: status line shows what broke; Stop always attempts
  both upstream closes.
- Backstops for abandoned pages: ConvoAI `idle_timeout: 60`, Vivix
  `auto_close.disconnected_timeout_seconds: 60`, `max_duration_seconds: 1200`.

## Testing

- Vitest 4 (one runner for server `.mjs` and web `.ts`) with injected `fetch`: ConvoAI join body (pipeline_id, uids, datastream),
  Vivix create body (passthrough, agora transport), rollback on partial failure, stop
  tolerance (404 / `closing`), value-based redaction, transcript chunk reassembly.
- Spike (done, `02-convoai-spike`): with real credentials (Agora from `spatius-scenario-demo/backend/.env`, read
  at runtime and never copied into this repo; Vivix key from the user): confirm the client can
  publish audio with the Vivix-issued token in passthrough mode — confirmed. Measured agent-audio
  onset → avatar-audio onset 2.25–2.85 s, almost all inside Vivix (relay ready ~40 ms after the
  agent track arrives); no API knob exists to reduce it.
- End-to-end: `e2e/smoke.mjs` drives headless Chrome (Playwright, system Chrome, fake mic WAV)
  through Start → avatar first frame → agent reply relayed → Stop.

## Out of scope (v1)

Mobile clients, scenes, server-side relay, Vivix-hosted conversation mode, auth/rate
limiting (the server is for localhost/LAN demo use).
