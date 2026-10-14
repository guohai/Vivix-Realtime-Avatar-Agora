# 03 — ConvoAI text → Vivix scripted speech spike (throwaway)

Question: is it faster to send ConvoAI's reply *text* to Vivix (`response.create` with
`script.vocal.speech`, standard session, Vivix's own voice) than to relay ConvoAI's TTS audio
in passthrough mode?

```bash
PORT=3202 node --env-file=<agora .env> --env-file=../01-agora-player/.env server.mjs
# open http://localhost:3202/?mode=sentence   (or ?mode=final)
```

Findings (2026-10-14, headless Chrome, fake English mic, `sentence` mode), times from the end
of the user's speech:

| Turn | First reply text | ConvoAI TTS audio | Vivix render.started | Avatar voice |
|---|---|---|---|---|
| 2 | 2914 ms | 3000 ms | 4856 ms | 5300 ms |
| 3 | 1915 ms | 2100 ms | 3976 ms | 4450 ms |

- ConvoAI emits the reply text in step with its TTS audio (first text ≈ 0.1–0.2 s before the
  audio), not ahead of it, so text gives no head start.
- Vivix takes ~2.4–2.5 s from receiving text to speaking it — the same as passthrough
  (2.4–2.9 s from receiving audio). The delay is Vivix's render start, whatever the input.
- Net gain over passthrough ≈ 0.3–0.5 s (n=2), at the cost of losing the pipeline's voice.
  Not worth switching.
