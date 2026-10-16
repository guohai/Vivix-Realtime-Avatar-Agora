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

### From another machine

Browsers only open the microphone over HTTPS (or on localhost), so serve it over TLS and
bind to an address the other machine can reach — ideally a VPN interface, since the API has
no authentication:

```bash
mkdir -p certs            # git-ignored
openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=myhost.example" \
  -addext "subjectAltName=DNS:myhost.example,IP:100.x.y.z" -keyout certs/key.pem -out certs/cert.pem
HOST=100.x.y.z PUBLIC_HOST=myhost.example TLS_CERT=certs/cert.pem TLS_KEY=certs/key.pem npm start
```

The certificate is self-signed: accept the browser warning once on the other machine.

### Server-side credential defaults

Set any of `AGORA_APP_ID`, `AGORA_APP_CERTIFICATE`, `AGORA_PIPELINE_ID`, `VIVIX_API_KEY` in
the server's environment (e.g. `node --env-file=.env server/index.mjs`) and the page may leave
those fields blank; the server fills them in. The values never reach the browser —
`GET /api/defaults` only says which fields are covered. Agora defaults apply only when the App
ID is blank or is the default one, so a typed App ID is never paired with another project's
certificate. Anyone who can reach the server then spends those accounts, so keep it on
localhost or a VPN.

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

The side panel shows, for each turn:

- **End to end** — you stop speaking → you hear and see the avatar.
- **Agora response** — you stop speaking → the agent's voice (turn detection, ASR, LLM, TTS).
  The end of your speech is the last loud mic sample before ConvoAI's final transcript.
- **Vivix rendering** — the agent's voice arrives → the avatar's voice and video arrive, with
  Agora's measured network delay of the avatar video alongside.

Typical run (English, borrowed pipeline): end to end ~5 s = Agora ~2.3 s + Vivix ~2.6 s, of
which ~0.2–0.3 s is the video's network hop back. Below that, the startup timeline.

Vivix rendering:

- Spike (`02-convoai-spike`): agent→avatar onset of 2.25, 2.55 and 2.85 s (n=3).
- This app's smoke runs: 3.05 and 3.15 s (n=2).

Almost all of it is inside Vivix's passthrough renderer. In the spike the relay itself was
ready ~40 ms after the agent's audio arrived (agent audio subscribed at +4.02 s, relay
published at +4.06 s).

## Test

```bash
npm test                  # unit tests
npm run build
npm start                 # in a separate terminal (or: node server/index.mjs & SRV=$!  ...  kill $SRV)
```

Then run the smoke against real services in headless Chrome (creates billed sessions):

```bash
E2E_WAV=speech.wav node --env-file=.env e2e/smoke.mjs      # or: npm run e2e
```

`--env-file` may be given more than once to load several files. Required env vars:
`AGORA_APP_ID`, `AGORA_APP_CERTIFICATE`, `AGORA_PIPELINE_ID`, `VIVIX_API_KEY`. Optional:
`E2E_WAV` (speech WAV for the fake mic), `E2E_URL` (default http://localhost:8787),
`CHROME_PATH` (default /usr/bin/google-chrome), `E2E_SECONDS` (default 35).

The smoke fails unless the avatar's first frame, a relayed agent reply and an `agent:`
transcript line all appear. It saves `test-results/smoke.png`, which shows the App ID and
pipeline ID, so do not share it.

## Cleanup and cost

Stop closes both upstream sessions. A closed tab sends a beacon to do the same; if that is
lost, ConvoAI stops after 60 s alone in the channel and Vivix closes 60 s after its control
connection drops (sessions are capped at 20 minutes).

## ⚠️ Demo only

The backend binds 127.0.0.1 and has no authentication or rate limiting. Do not expose it
publicly as is.

`01-agora-player/` is the Vivix Agora guide built as documented; `02-convoai-spike/` is the
throwaway spike that proved the relay.
