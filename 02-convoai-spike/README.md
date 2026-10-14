# 02 — ConvoAI → Vivix passthrough spike (throwaway)

Proves the design: mic → Agora ConvoAI channel (customer App ID, `pipeline_id`);
the agent's TTS track is republished from the browser into the Vivix-provisioned channel
(`a2a_config: passthrough`); the avatar video + audio are played, the agent's raw audio is not.

```bash
PORT=3201 node --env-file=<agora .env> --env-file=../01-agora-player/.env server.mjs
```
Needs `VIVIX_API_KEY`, `AGORA_APP_ID`, `AGORA_APP_CERTIFICATE`, `AGORA_PIPELINE_ID`.

Findings (2026-10-14, headless Chrome, fake mic):
- Works end to end; ConvoAI transcripts arrive over the RTC datastream.
- Vivix passthrough create returns HTTP 500 / code 50001 unless
  `pipeline_config.tts_config.tts_voice_id` is also set (request id
  8e620d98-3e00-431d-966c-9b2bfa4fdc67).
- Agent audio onset → avatar audio onset: 2.25 / 2.55 / 2.85 s. Startup to first avatar frame 3.8 s.
