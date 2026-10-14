# Vivix × Agora ConvoAI Web Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A streamlined, low-latency web demo where an Agora ConvoAI agent (console `pipeline_id`) drives a Vivix streaming avatar, with the customer typing Agora and Vivix credentials into the page.

**Architecture:** A stateless Node backend creates a Vivix passthrough session and joins a ConvoAI agent in parallel, returning both credential sets. The browser runs two Agora clients: it publishes the mic into the customer's ConvoAI channel, and republishes the agent's TTS track into the Vivix-provisioned channel, where Vivix renders the avatar it streams back. Proven in `02-convoai-spike/`.

**Tech Stack:** Node ≥ 20.6 (built-in `http`, `fetch`), `agora-token`, `agora-rtc-sdk-ng` 4.24, Vite 6 + TypeScript 5.9 (vanilla, no framework), Vitest 3, `playwright-core` with system Chrome for the e2e smoke.

**Spec:** `docs/superpowers/specs/2026-10-14-vivix-convoai-demo-design.md`

## Global Constraints

- Runs on the machine's default Node v20.17.0: do not use Vite ≥ 7, Vitest ≥ 4 or anything else requiring Node ≥ 20.19.
- Backend runtime dependency: `agora-token` only. No web framework on either side.
- Backend is stateless: credentials arrive in each request body; never written to disk, never logged, never echoed. Upstream error text is passed through only after every submitted secret is replaced by `<redacted>`.
- Backend binds `127.0.0.1:8787` by default (`HOST` / `PORT` override). Vite dev server on 5180 (5173 is taken on this machine), proxying `/api` and `/health` to 8787.
- Vivix create body must include `pipeline_config.tts_config.tts_voice_id` (Vivix returns HTTP 500 / code 50001 in passthrough without it).
- The agent's raw audio is never played; only the avatar's audio is.
- New app lives at the repo root (`server/`, `web/`, `e2e/`); leave `01-agora-player/` and `02-convoai-spike/` untouched.
- Commit messages end with `🤖 Built with SMT <smt@agora.build>`.

## File Structure

```
package.json              scripts: dev:web, build, start, test, e2e
vitest.config.mjs         one runner for server/*.test.mjs and web/src/*.test.ts
server/
  upstream.mjs            UpstreamError, redact(), postJson() with timeout
  vivix.mjs               Vivix create body, createSession, closeSession
  agora.mjs               UIDs + tokens, REST auth, join/leave/interrupt body + calls
  validate.mjs            HttpError, request-body credential validation
  app.mjs                 createApp(deps): routes + static web/dist
  index.mjs               wires real deps, listens
  *.test.mjs              unit tests (fake fetch / fake deps)
web/
  vite.config.ts  tsconfig.json  index.html
  src/
    config.ts             Credentials type, localStorage load/save, validation, request body
    api.ts                typed fetch wrappers + sendBeacon stop
    transcript.ts         datastream chunk assembler + pure transcript reducer
    metrics.ts            Timeline + OnsetTracker (relay+render latency)
    convo.ts              channel A client (mic, agent audio, datastream)
    avatar.ts             channel B client + Vivix control WebSocket
    relay.ts              agent track → custom track → publish on channel B
    session.ts            orchestration: start / stop / interrupt / mute
    main.ts               DOM wiring
    style.css
    *.test.ts             unit tests for config, transcript, metrics
e2e/smoke.mjs             headless Chrome, fake mic, Start → reply relayed → Stop
README.md
```

---

### Task 1: Scaffold + shared upstream helpers

**Files:**
- Create: `package.json`, `vitest.config.mjs`, `server/upstream.mjs`, `server/upstream.test.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `class UpstreamError extends Error { service: string; status: number }`; `redact(text: string, secrets: string[]) => string`; `postJson(url, { headers, body, secrets, service, fetchImpl, okStatuses? }) => Promise<{ status: number, data: any }>` — throws `UpstreamError` when `!res.ok` and status ∉ `okStatuses`; `REQUEST_TIMEOUT_MS = 20000`.

- [ ] **Step 1: Write `package.json` and `vitest.config.mjs`, install**

```json
{
  "name": "vivix-convoai-demo",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20.6" },
  "scripts": {
    "dev:web": "vite web",
    "build": "tsc -p web && vite build web",
    "start": "node server/index.mjs",
    "test": "vitest run",
    "e2e": "node e2e/smoke.mjs"
  },
  "dependencies": {
    "agora-token": "^2.0.7"
  },
  "devDependencies": {
    "agora-rtc-sdk-ng": "^4.24.9",
    "playwright-core": "^1.57.0",
    "typescript": "~5.9.3",
    "vite": "^6.4.4",
    "vitest": "^3.2.7"
  }
}
```

```js
// vitest.config.mjs
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["server/**/*.test.mjs", "web/src/**/*.test.ts"], environment: "node" },
});
```

Run: `npm install`
Expected: `found 0 vulnerabilities` (or only advisories), `node_modules/` created. `.gitignore` already covers `node_modules/`, `web/dist/`, `.env`; append `test-results/`.

- [ ] **Step 2: Write the failing test `server/upstream.test.mjs`**

```js
import { describe, it, expect } from "vitest";
import { redact, postJson, UpstreamError } from "./upstream.mjs";

const fakeFetch = (status, payload) => {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status });
  };
  impl.calls = calls;
  return impl;
};

describe("redact", () => {
  it("replaces every occurrence of every secret", () => {
    expect(redact("key sk-1 and sk-1 and cert abc", ["sk-1", "abc", ""])).toBe(
      "key <redacted> and <redacted> and cert <redacted>");
  });
});

describe("postJson", () => {
  it("returns status and parsed data on success", async () => {
    const f = fakeFetch(200, { ok: 1 });
    const r = await postJson("https://x/y", { service: "X", body: { a: 1 }, headers: { h: "1" }, secrets: [], fetchImpl: f });
    expect(r).toEqual({ status: 200, data: { ok: 1 } });
    expect(f.calls[0].init.method).toBe("POST");
    expect(f.calls[0].init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(f.calls[0].init.body)).toEqual({ a: 1 });
    expect(f.calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws UpstreamError with redacted detail on failure", async () => {
    const f = fakeFetch(400, { detail: "bad token SECRET123" });
    const err = await postJson("https://x", { service: "ConvoAI", body: {}, headers: {}, secrets: ["SECRET123"], fetchImpl: f }).catch(e => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(400);
    expect(err.message).toBe("ConvoAI: bad token <redacted>");
  });

  it("falls back to HTTP status when the body has no message", async () => {
    const err = await postJson("https://x", { service: "Vivix", body: {}, headers: {}, secrets: [], fetchImpl: fakeFetch(502, "<html>") }).catch(e => e);
    expect(err.message).toBe("Vivix: HTTP 502");
  });

  it("accepts statuses listed in okStatuses", async () => {
    const r = await postJson("https://x", { service: "X", body: {}, headers: {}, secrets: [], okStatuses: [404], fetchImpl: fakeFetch(404, {}) });
    expect(r.status).toBe(404);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run server/upstream.test.mjs`
Expected: FAIL — cannot find module `./upstream.mjs`.

- [ ] **Step 4: Implement `server/upstream.mjs`**

```js
// Shared plumbing for the two upstream APIs. Upstream errors can echo request content,
// so their text is only passed on after every submitted secret has been redacted.
export const REQUEST_TIMEOUT_MS = 20_000;

export class UpstreamError extends Error {
  constructor(service, message, status) {
    super(`${service}: ${message}`);
    this.service = service;
    this.status = status;
  }
}

export function redact(text, secrets) {
  let out = String(text);
  for (const s of secrets) if (s) out = out.split(s).join("<redacted>");
  return out;
}

function upstreamDetail(data) {
  if (!data || typeof data !== "object") return "";
  for (const key of ["detail", "message", "reason"]) {
    if (typeof data[key] === "string" && data[key]) return data[key];
  }
  return "";
}

export async function postJson(url, { service, headers, body, secrets, fetchImpl = fetch, okStatuses = [] }) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok && !okStatuses.includes(res.status)) {
    const detail = upstreamDetail(data) || `HTTP ${res.status}`;
    throw new UpstreamError(service, redact(detail, secrets).slice(0, 300), res.status);
  }
  return { status: res.status, data };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run server/upstream.test.mjs`
Expected: 5 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.mjs .gitignore server/upstream.mjs server/upstream.test.mjs
git commit -m "Scaffold demo app with shared upstream helpers

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 2: Vivix client

**Files:**
- Create: `server/vivix.mjs`, `server/vivix.test.mjs`

**Interfaces:**
- Consumes: `postJson`, `UpstreamError` from `server/upstream.mjs`.
- Produces:
  - `DEFAULT_IMAGE_URL`, `DEFAULT_VOICE_ID = "longanhuan_v3.6"`
  - `buildCreateBody({ imageUrl? }) => object`
  - `createSession({ apiKey, imageUrl? }, fetchImpl?) => Promise<VivixSession>` where `VivixSession = { sessionId: string, control: { url: string, clientSecret: string }, media: { appId: string, channel: string, token: string, uid: string, publisherUid: string } }`
  - `closeSession({ apiKey, sessionId }, fetchImpl?) => Promise<"closing" | "closed">`

- [ ] **Step 1: Write the failing test `server/vivix.test.mjs`**

```js
import { describe, it, expect } from "vitest";
import { buildCreateBody, createSession, closeSession, DEFAULT_IMAGE_URL, DEFAULT_VOICE_ID } from "./vivix.mjs";

const respond = (status, payload) => {
  const calls = [];
  const impl = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(payload), { status }); };
  impl.calls = calls;
  return impl;
};

const created = {
  code: 0,
  data: {
    session_id: "s-1",
    control: { url: "wss://ctl/v1?session_id=s-1", client_secret: "cs" },
    delivery: { media: { transport: "agora", agora: {
      app_id: "vapp", channel_name: "vch", token: "vtok", user_id: "42", publisher_user_id: "99" } } },
  },
};

describe("buildCreateBody", () => {
  it("requests an Agora passthrough session with a TTS voice and auto close", () => {
    const b = buildCreateBody({});
    expect(b.model).toBe("vivix-a1-stream");
    expect(b.delivery).toEqual({ media: { transport: "agora" } });
    expect(b.pipeline_config).toEqual({
      tts_config: { tts_voice_id: DEFAULT_VOICE_ID },
      a2a_config: { enable_a2a: true, provider: "passthrough" },
    });
    expect(b.auto_close).toEqual({ disconnected_timeout_seconds: 60 });
    expect(b.max_duration_seconds).toBe(1200);
    expect(b.avatars[0].visual.source_images[0].url).toBe(DEFAULT_IMAGE_URL);
  });

  it("uses a custom image and infers png", () => {
    const img = buildCreateBody({ imageUrl: "https://cdn.example/me.png" }).avatars[0].visual.source_images[0];
    expect(img.url).toBe("https://cdn.example/me.png");
    expect(img.media_type).toBe("image/png");
  });
});

describe("createSession", () => {
  it("posts with the bearer key and normalizes the response", async () => {
    const f = respond(200, created);
    const s = await createSession({ apiKey: "vk" }, f);
    expect(f.calls[0].url).toBe("https://api.vivix.ai/v1/realtime-avatar/sessions");
    expect(f.calls[0].init.headers.Authorization).toBe("Bearer vk");
    expect(s).toEqual({
      sessionId: "s-1",
      control: { url: "wss://ctl/v1?session_id=s-1", clientSecret: "cs" },
      media: { appId: "vapp", channel: "vch", token: "vtok", uid: "42", publisherUid: "99" },
    });
  });

  it("treats a non-zero code as failure even on HTTP 200", async () => {
    const err = await createSession({ apiKey: "vk" }, respond(200, { code: 40001, message: "bad image" })).catch(e => e);
    expect(err.message).toBe("Vivix: bad image");
  });

  it("redacts the api key from upstream messages", async () => {
    const err = await createSession({ apiKey: "vk-secret" }, respond(401, { code: 401, message: "invalid api key vk-secret" })).catch(e => e);
    expect(err.message).toBe("Vivix: invalid api key <redacted>");
  });

  it("rejects a session without Agora media", async () => {
    const trtc = structuredClone(created);
    trtc.data.delivery.media = { transport: "trtc", trtc: {} };
    await expect(createSession({ apiKey: "vk" }, respond(200, trtc))).rejects.toThrow("no Agora media");
  });
});

describe("closeSession", () => {
  it("accepts closing and closed", async () => {
    const f = respond(200, { code: 0, data: { session_id: "s-1", status: "closing" } });
    expect(await closeSession({ apiKey: "vk", sessionId: "s/1" }, f)).toBe("closing");
    expect(f.calls[0].url).toBe("https://api.vivix.ai/v1/realtime-avatar/sessions/s%2F1/close");
  });

  it("rejects failed", async () => {
    await expect(closeSession({ apiKey: "vk", sessionId: "s" }, respond(200, { code: 0, data: { status: "failed" } })))
      .rejects.toThrow("close status: failed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/vivix.test.mjs`
Expected: FAIL — cannot find module `./vivix.mjs`.

- [ ] **Step 3: Implement `server/vivix.mjs`**

```js
// Vivix streaming avatar in pure rendering mode: it animates whatever audio the browser
// publishes into the Vivix-provisioned Agora channel. The voice and dialogue come from ConvoAI.
import { postJson, UpstreamError } from "./upstream.mjs";

export const VIVIX_API = "https://api.vivix.ai/v1";
export const DEFAULT_IMAGE_URL = "https://static.vivi-x.ai/images/2026/08/03/650665979f5d095f.jpg";
// Required even though passthrough never speaks with it: without tts_config the create
// request fails with HTTP 500 / code 50001.
export const DEFAULT_VOICE_ID = "longanhuan_v3.6";
const PERSONA = "A warm, attentive conversation companion. Small smiles and gentle nods; hands rest while listening.";

const mediaType = url => (/\.png(\?|$)/i.test(url) ? "image/png" : /\.webp(\?|$)/i.test(url) ? "image/webp" : "image/jpeg");

export function buildCreateBody({ imageUrl } = {}) {
  const url = imageUrl || DEFAULT_IMAGE_URL;
  return {
    model: "vivix-a1-stream",
    output: { aspect_ratio: "9:16", resolution: "720p" },
    avatars: [{
      avatar_id: "host",
      persona: PERSONA,
      visual: { source_images: [{ source_image_id: "portrait", url, media_type: mediaType(url) }] },
    }],
    pipeline_config: {
      tts_config: { tts_voice_id: DEFAULT_VOICE_ID },
      a2a_config: { enable_a2a: true, provider: "passthrough" },
    },
    delivery: { media: { transport: "agora" } },
    max_duration_seconds: 1200,
    auto_close: { disconnected_timeout_seconds: 60 },
  };
}

async function call(apiKey, path, body, fetchImpl) {
  const { status, data } = await postJson(`${VIVIX_API}/${path}`, {
    service: "Vivix", headers: { Authorization: `Bearer ${apiKey}` }, body, secrets: [apiKey], fetchImpl,
  });
  if (data?.code !== 0) {
    throw new UpstreamError("Vivix", (data?.message || `code ${data?.code}`).split(apiKey).join("<redacted>"), status);
  }
  return data.data;
}

export async function createSession({ apiKey, imageUrl }, fetchImpl = fetch) {
  const d = await call(apiKey, "realtime-avatar/sessions", buildCreateBody({ imageUrl }), fetchImpl);
  const m = d?.delivery?.media?.agora;
  if (!d?.session_id || !d.control?.url || !m) throw new UpstreamError("Vivix", "session has no Agora media details", 502);
  return {
    sessionId: d.session_id,
    control: { url: d.control.url, clientSecret: d.control.client_secret },
    media: {
      appId: String(m.app_id), channel: String(m.channel_name), token: String(m.token ?? ""),
      uid: String(m.user_id), publisherUid: String(m.publisher_user_id),
    },
  };
}

export async function closeSession({ apiKey, sessionId }, fetchImpl = fetch) {
  const d = await call(apiKey, `realtime-avatar/sessions/${encodeURIComponent(sessionId)}/close`, {}, fetchImpl);
  if (!["closing", "closed"].includes(d?.status)) throw new UpstreamError("Vivix", `close status: ${d?.status}`, 502);
  return d.status;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/vivix.test.mjs`
Expected: 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/vivix.mjs server/vivix.test.mjs
git commit -m "Add Vivix passthrough session client

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 3: Agora ConvoAI client

**Files:**
- Create: `server/agora.mjs`, `server/agora.test.mjs`

**Interfaces:**
- Consumes: `postJson` from `server/upstream.mjs`.
- Produces:
  - `mintIdentities({ appId, certificate }) => { channel, userUid: number, userToken, agentUid: number, agentToken }`
  - `buildJoinBody({ pipelineId, persona? }, ids) => object`
  - `joinAgent({ appId, certificate, pipelineId, persona? }, fetchImpl?) => Promise<ConvoSession>` where `ConvoSession = { agentId: string, appId: string, channel: string, uid: number, token: string, agentUid: number }`
  - `leaveAgent({ appId, certificate, agentId }, fetchImpl?) => Promise<void>` (404 = already gone = ok)
  - `interruptAgent({ appId, certificate, agentId }, fetchImpl?) => Promise<void>`

- [ ] **Step 1: Write the failing test `server/agora.test.mjs`**

```js
import { describe, it, expect } from "vitest";
import { mintIdentities, buildJoinBody, joinAgent, leaveAgent, interruptAgent } from "./agora.mjs";

const creds = { appId: "a".repeat(32), certificate: "b".repeat(32) };
const respond = (status, payload) => {
  const calls = [];
  const impl = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(payload), { status }); };
  impl.calls = calls;
  return impl;
};

describe("mintIdentities", () => {
  it("mints a fresh channel, non-overlapping uids and AccessToken2 tokens", () => {
    const ids = mintIdentities(creds);
    expect(ids.channel).toMatch(/^vivix-[0-9a-f]{16}$/);
    expect(ids.userUid).toBeGreaterThanOrEqual(100_000);
    expect(ids.userUid).toBeLessThan(600_000);
    expect(ids.agentUid).toBeGreaterThanOrEqual(600_000);
    expect(ids.agentUid).toBeLessThan(800_000);
    expect(ids.userToken.startsWith("007")).toBe(true);
    expect(ids.agentToken.startsWith("007")).toBe(true);
    expect(ids.userToken).not.toBe(ids.agentToken);
  });
});

describe("buildJoinBody", () => {
  const ids = { channel: "vivix-1", userUid: 111111, agentUid: 666666, agentToken: "atok", userToken: "utok" };

  it("references the pipeline and streams transcripts over the datastream", () => {
    const b = buildJoinBody({ pipelineId: "pipe" }, ids);
    expect(b.name).toBe("vivix-1");
    expect(b.pipeline_id).toBe("pipe");
    expect(b.properties).toEqual({
      channel: "vivix-1",
      token: "atok",
      agent_rtc_uid: "666666",
      remote_rtc_uids: ["111111"],
      idle_timeout: 60,
      turn_detection: { interrupt_mode: "interrupt" },
      parameters: { data_channel: "datastream", enable_error_message: true },
    });
  });

  it("overrides the persona only when one is given", () => {
    const b = buildJoinBody({ pipelineId: "pipe", persona: "  Be brief.  " }, ids);
    expect(b.properties.llm).toEqual({ system_messages: [{ role: "system", content: "Be brief." }] });
    expect(buildJoinBody({ pipelineId: "pipe", persona: "   " }, ids).properties.llm).toBeUndefined();
  });
});

describe("joinAgent", () => {
  it("joins with REST auth signed from the certificate and returns the client's identity", async () => {
    const f = respond(200, { agent_id: "ag-1", status: "RUNNING" });
    const s = await joinAgent({ ...creds, pipelineId: "pipe" }, f);
    expect(f.calls[0].url).toBe(`https://api.agora.io/api/conversational-ai-agent/v2/projects/${creds.appId}/join`);
    expect(f.calls[0].init.headers.Authorization).toMatch(/^agora token="007.+"$/);
    const sent = JSON.parse(f.calls[0].init.body);
    expect(s).toEqual({ agentId: "ag-1", appId: creds.appId, channel: sent.name,
      uid: Number(sent.properties.remote_rtc_uids[0]), token: s.token, agentUid: Number(sent.properties.agent_rtc_uid) });
    expect(s.token).not.toBe(sent.properties.token);
  });

  it("surfaces the upstream detail with the certificate redacted", async () => {
    const f = respond(400, { detail: `properties: tts.addon not found for ${creds.certificate}` });
    await expect(joinAgent({ ...creds, pipelineId: "nope" }, f)).rejects.toThrow("ConvoAI: properties: tts.addon not found for <redacted>");
  });

  it("fails when no agent id comes back", async () => {
    await expect(joinAgent({ ...creds, pipelineId: "p" }, respond(200, {}))).rejects.toThrow("no agent id");
  });
});

describe("leaveAgent / interruptAgent", () => {
  it("treats 404 on leave as already stopped", async () => {
    const f = respond(404, { detail: "not found" });
    await expect(leaveAgent({ ...creds, agentId: "ag-1" }, f)).resolves.toBeUndefined();
    expect(f.calls[0].url).toBe(`https://api.agora.io/api/conversational-ai-agent/v2/projects/${creds.appId}/agents/ag-1/leave`);
  });

  it("calls interrupt", async () => {
    const f = respond(200, {});
    await interruptAgent({ ...creds, agentId: "ag-1" }, f);
    expect(f.calls[0].url.endsWith("/agents/ag-1/interrupt")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/agora.test.mjs`
Expected: FAIL — cannot find module `./agora.mjs`.

- [ ] **Step 3: Implement `server/agora.mjs`**

```js
// Agora Conversational AI: the agent configured by a console pipeline_id runs ASR → LLM → TTS
// in the customer's channel. REST auth is signed from App ID + certificate on the fly (as in
// spatius-scenario-demo/backend/agora.py), so no Customer ID / Secret is needed.
import { randomBytes, randomInt } from "node:crypto";
import agoraToken from "agora-token";
import { postJson } from "./upstream.mjs";

const { RtcTokenBuilder, RtcRole } = agoraToken;
export const CONVOAI_API = "https://api.agora.io/api/conversational-ai-agent/v2";
const TOKEN_TTL_SECONDS = 30 * 60;
const REST_TOKEN_TTL_SECONDS = 5 * 60;
// ConvoAI stops the agent after this long with no remote user — a backstop for closed tabs.
const IDLE_TIMEOUT_SECONDS = 60;

const rtcToken = ({ appId, certificate }, channel, uid, ttl = TOKEN_TTL_SECONDS) =>
  RtcTokenBuilder.buildTokenWithUid(appId, certificate, channel, uid, RtcRole.PUBLISHER, ttl, ttl);

const restAuth = creds => `agora token="${rtcToken(creds, "", 1, REST_TOKEN_TTL_SECONDS)}"`;

export function mintIdentities(creds) {
  const channel = `vivix-${randomBytes(8).toString("hex")}`;
  const userUid = randomInt(100_000, 600_000);
  const agentUid = randomInt(600_000, 800_000);
  return {
    channel,
    userUid, userToken: rtcToken(creds, channel, userUid),
    agentUid, agentToken: rtcToken(creds, channel, agentUid),
  };
}

export function buildJoinBody({ pipelineId, persona }, ids) {
  const properties = {
    channel: ids.channel,
    token: ids.agentToken,
    agent_rtc_uid: String(ids.agentUid),
    remote_rtc_uids: [String(ids.userUid)],
    idle_timeout: IDLE_TIMEOUT_SECONDS,
    turn_detection: { interrupt_mode: "interrupt" },
    // Transcripts over the RTC datastream, so the browser needs no RTM SDK.
    parameters: { data_channel: "datastream", enable_error_message: true },
  };
  // In pipeline mode `llm` is an optional override: system_messages alone leaves the
  // agent's model and params as published.
  if (persona?.trim()) properties.llm = { system_messages: [{ role: "system", content: persona.trim() }] };
  return { name: ids.channel, pipeline_id: pipelineId, properties };
}

const call = (creds, path, body, fetchImpl, okStatuses) => postJson(`${CONVOAI_API}/projects/${creds.appId}/${path}`, {
  service: "ConvoAI", headers: { Authorization: restAuth(creds) }, body,
  secrets: [creds.certificate], fetchImpl, okStatuses,
});

export async function joinAgent({ appId, certificate, pipelineId, persona }, fetchImpl = fetch) {
  const creds = { appId, certificate };
  const ids = mintIdentities(creds);
  const { data } = await call(creds, "join", buildJoinBody({ pipelineId, persona }, ids), fetchImpl);
  if (typeof data?.agent_id !== "string" || !data.agent_id) throw new Error("ConvoAI: no agent id returned");
  return { agentId: data.agent_id, appId, channel: ids.channel, uid: ids.userUid, token: ids.userToken, agentUid: ids.agentUid };
}

export async function leaveAgent({ appId, certificate, agentId }, fetchImpl = fetch) {
  await call({ appId, certificate }, `agents/${encodeURIComponent(agentId)}/leave`, {}, fetchImpl, [404]);
}

export async function interruptAgent({ appId, certificate, agentId }, fetchImpl = fetch) {
  await call({ appId, certificate }, `agents/${encodeURIComponent(agentId)}/interrupt`, {}, fetchImpl);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/agora.test.mjs`
Expected: 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/agora.mjs server/agora.test.mjs
git commit -m "Add Agora ConvoAI client with pipeline join

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 4: HTTP app — validation, routes, rollback, static files

**Files:**
- Create: `server/validate.mjs`, `server/app.mjs`, `server/index.mjs`, `server/app.test.mjs`

**Interfaces:**
- Consumes: `createSession`, `closeSession` (Task 2); `joinAgent`, `leaveAgent`, `interruptAgent` (Task 3); `UpstreamError` (Task 1).
- Produces (HTTP, consumed by `web/src/api.ts` in Task 6):
  - `POST /api/session` body `{ agora: { appId, certificate, pipelineId, persona? }, vivix: { apiKey, imageUrl? } }` → `200 { vivix: VivixSession, convo: ConvoSession, timings: { vivixCreateMs: number, convoJoinMs: number } }`
  - `POST /api/session/stop` body `{ agora: {appId, certificate}, vivix: {apiKey}, agentId?, vivixSessionId? }` → `200 { ok: true }`
  - `POST /api/session/interrupt` body `{ agora: {appId, certificate}, agentId }` → `200 { ok: true }`
  - `GET /health` → `{ ok: true }`
  - Errors: `{ error: string, field?: string }` with 400 (validation), 502 (upstream), 404, 413.
  - JS: `createApp(deps: { createSession, closeSession, joinAgent, leaveAgent, interruptAgent, staticDir: string }) => (req, res) => Promise<void>`

- [ ] **Step 1: Write the failing test `server/app.test.mjs`**

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.mjs";
import { UpstreamError } from "./upstream.mjs";

const HEX = "0123456789abcdef0123456789abcdef";
const body = { agora: { appId: HEX, certificate: HEX, pipelineId: "pipe" }, vivix: { apiKey: "vk" } };
const vivixSession = { sessionId: "s-1", control: { url: "wss://c", clientSecret: "cs" }, media: {} };
const convoSession = { agentId: "ag-1", appId: HEX, channel: "ch", uid: 1, token: "t", agentUid: 2 };

let server, base, calls, deps;
beforeEach(async () => {
  calls = [];
  const dir = mkdtempSync(join(tmpdir(), "vx-static-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<h1>demo</h1>");
  writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
  deps = {
    staticDir: dir,
    createSession: async a => { calls.push(["create", a]); return vivixSession; },
    closeSession: async a => { calls.push(["close", a]); return "closed"; },
    joinAgent: async a => { calls.push(["join", a]); return convoSession; },
    leaveAgent: async a => { calls.push(["leave", a]); },
    interruptAgent: async a => { calls.push(["interrupt", a]); },
  };
  server = http.createServer((req, res) => createApp(deps)(req, res));
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => new Promise(r => server.close(r)));

const post = (path, b) => fetch(base + path, { method: "POST", body: typeof b === "string" ? b : JSON.stringify(b) });

describe("POST /api/session", () => {
  it("creates both sides and reports timings", async () => {
    const res = await post("/api/session", { ...body, agora: { ...body.agora, persona: "hi" }, vivix: { apiKey: "vk", imageUrl: "https://x/y.jpg" } });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.vivix).toEqual(vivixSession);
    expect(j.convo).toEqual(convoSession);
    expect(typeof j.timings.vivixCreateMs).toBe("number");
    expect(typeof j.timings.convoJoinMs).toBe("number");
    expect(calls).toContainEqual(["create", { apiKey: "vk", imageUrl: "https://x/y.jpg" }]);
    expect(calls).toContainEqual(["join", { appId: HEX, certificate: HEX, pipelineId: "pipe", persona: "hi" }]);
  });

  it("rejects a malformed App ID with the field name", async () => {
    const res = await post("/api/session", { ...body, agora: { ...body.agora, appId: "nope" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Agora App ID must be 32 hex characters", field: "agora.appId" });
    expect(calls).toEqual([]);
  });

  it("rejects a non-https image URL", async () => {
    const res = await post("/api/session", { ...body, vivix: { apiKey: "vk", imageUrl: "file:///etc/passwd" } });
    expect((await res.json()).field).toBe("vivix.imageUrl");
  });

  it("rolls back the Vivix session when the ConvoAI join fails", async () => {
    deps.joinAgent = async () => { throw new UpstreamError("ConvoAI", "properties: tts.addon not found", 400); };
    const res = await post("/api/session", body);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("ConvoAI: properties: tts.addon not found");
    expect(calls).toContainEqual(["close", { apiKey: "vk", sessionId: "s-1" }]);
  });

  it("rolls back the agent when the Vivix create fails", async () => {
    deps.createSession = async () => { throw new UpstreamError("Vivix", "bad image", 400); };
    const res = await post("/api/session", body);
    expect(res.status).toBe(502);
    expect(calls).toContainEqual(["leave", { appId: HEX, certificate: HEX, agentId: "ag-1" }]);
  });

  it("rejects invalid JSON and oversized bodies", async () => {
    expect((await post("/api/session", "{")).status).toBe(400);
    expect((await post("/api/session", "x".repeat(70_000))).status).toBe(413);
  });
});

describe("POST /api/session/stop", () => {
  it("stops both sides in parallel and accepts text/plain beacons", async () => {
    const res = await fetch(base + "/api/session/stop", { method: "POST", headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ ...body, agentId: "ag-1", vivixSessionId: "s-1" }) });
    expect(res.status).toBe(200);
    expect(calls.map(c => c[0]).sort()).toEqual(["close", "leave"]);
  });

  it("still closes Vivix when leave fails, then reports the failure", async () => {
    deps.leaveAgent = async () => { throw new UpstreamError("ConvoAI", "boom", 500); };
    const res = await post("/api/session/stop", { ...body, agentId: "ag-1", vivixSessionId: "s-1" });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("ConvoAI: boom");
    expect(calls.map(c => c[0])).toEqual(["close"]);
  });
});

describe("POST /api/session/interrupt", () => {
  it("requires an agent id", async () => {
    expect((await post("/api/session/interrupt", { agora: body.agora })).status).toBe(400);
    expect((await post("/api/session/interrupt", { agora: body.agora, agentId: "ag-1" })).status).toBe(200);
  });
});

describe("static and health", () => {
  it("serves health, index, assets, and refuses traversal", async () => {
    expect(await (await fetch(base + "/health")).json()).toEqual({ ok: true });
    const index = await fetch(base + "/");
    expect(await index.text()).toBe("<h1>demo</h1>");
    expect(index.headers.get("cache-control")).toBe("no-cache");
    const asset = await fetch(base + "/assets/app.js");
    expect(asset.headers.get("content-type")).toBe("text/javascript");
    expect(asset.headers.get("cache-control")).toMatch(/immutable/);
    expect((await fetch(base + "/%2e%2e/%2e%2e/etc/passwd")).status).toBe(404);
    expect((await fetch(base + "/missing.js")).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/app.test.mjs`
Expected: FAIL — cannot find module `./app.mjs`.

- [ ] **Step 3: Implement `server/validate.mjs`**

```js
// Request-body validation. Messages name the field, never echo the value.
export class HttpError extends Error {
  constructor(status, message, field) { super(message); this.status = status; this.field = field; }
}

const HEX32 = /^[0-9a-f]{32}$/i;
const str = v => (typeof v === "string" ? v.trim() : "");

function need(value, field, label, { max = 512, pattern, patternMessage } = {}) {
  if (!value) throw new HttpError(400, `${label} is required`, field);
  if (value.length > max) throw new HttpError(400, `${label} is too long`, field);
  if (pattern && !pattern.test(value)) throw new HttpError(400, patternMessage, field);
  return value;
}

export function agoraAuth(body) {
  const a = body?.agora ?? {};
  return {
    appId: need(str(a.appId), "agora.appId", "Agora App ID", { pattern: HEX32, patternMessage: "Agora App ID must be 32 hex characters" }),
    certificate: need(str(a.certificate), "agora.certificate", "Agora App Certificate", { pattern: HEX32, patternMessage: "Agora App Certificate must be 32 hex characters" }),
  };
}

export function sessionRequest(body) {
  const auth = agoraAuth(body);
  const pipelineId = need(str(body.agora.pipelineId), "agora.pipelineId", "Agora pipeline ID", { max: 128 });
  const persona = str(body.agora.persona);
  if (persona.length > 4000) throw new HttpError(400, "Persona is too long", "agora.persona");
  const apiKey = need(str(body?.vivix?.apiKey), "vivix.apiKey", "Vivix API key");
  const imageUrl = str(body.vivix.imageUrl);
  if (imageUrl) {
    let ok = false;
    try { ok = new URL(imageUrl).protocol === "https:"; } catch { /* invalid */ }
    if (!ok || imageUrl.length > 2048) throw new HttpError(400, "Avatar image must be an https URL", "vivix.imageUrl");
  }
  return {
    agora: { ...auth, pipelineId, ...(persona && { persona }) },
    vivix: { apiKey, ...(imageUrl && { imageUrl }) },
  };
}

export function stopRequest(body) {
  const agentId = str(body?.agentId);
  const vivixSessionId = str(body?.vivixSessionId);
  return {
    agora: agentId ? agoraAuth(body) : null,
    vivixApiKey: vivixSessionId ? need(str(body?.vivix?.apiKey), "vivix.apiKey", "Vivix API key") : null,
    agentId, vivixSessionId,
  };
}

export function interruptRequest(body) {
  const auth = agoraAuth(body);
  return { ...auth, agentId: need(str(body?.agentId), "agentId", "Agent ID", { max: 128 }) };
}
```

- [ ] **Step 4: Implement `server/app.mjs`**

```js
// Routes. Stateless: each request carries the credentials it needs.
import { readFile } from "node:fs/promises";
import { join, normalize, sep, extname } from "node:path";
import { HttpError, sessionRequest, stopRequest, interruptRequest } from "./validate.mjs";
import { UpstreamError } from "./upstream.mjs";

const MAX_BODY_BYTES = 64 * 1024;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".wav": "audio/wav", ".json": "application/json" };

async function readBody(req) {
  let size = 0;
  const chunks = [];
  // Drain the whole body before rejecting, so the client sees the 413 rather than a reset.
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw new HttpError(400, "Request body must be JSON"); }
}

const send = (res, status, payload) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
};

async function timed(timings, key, fn) {
  const t = performance.now();
  try { return await fn(); } finally { timings[key] = Math.round(performance.now() - t); }
}

// allSettled so a failure on one side never leaves the other running unobserved.
async function settleAll(tasks) {
  const results = await Promise.allSettled(tasks.filter(Boolean));
  const failed = results.find(r => r.status === "rejected");
  if (failed) throw failed.reason;
}

export function createApp(deps) {
  const { createSession, closeSession, joinAgent, leaveAgent, interruptAgent, staticDir } = deps;
  const root = normalize(staticDir + sep);

  async function startSession(body) {
    const { agora, vivix } = sessionRequest(body);
    const timings = {};
    const [v, c] = await Promise.allSettled([
      timed(timings, "vivixCreateMs", () => createSession(vivix)),
      timed(timings, "convoJoinMs", () => joinAgent(agora)),
    ]);
    if (v.status === "rejected" || c.status === "rejected") {
      await Promise.allSettled([
        v.status === "fulfilled" && closeSession({ apiKey: vivix.apiKey, sessionId: v.value.sessionId }),
        c.status === "fulfilled" && leaveAgent({ appId: agora.appId, certificate: agora.certificate, agentId: c.value.agentId }),
      ]);
      throw v.status === "rejected" ? v.reason : c.reason;
    }
    return { vivix: v.value, convo: c.value, timings };
  }

  async function stopSession(body) {
    const r = stopRequest(body);
    await settleAll([
      r.agentId && leaveAgent({ ...r.agora, agentId: r.agentId }),
      r.vivixSessionId && closeSession({ apiKey: r.vivixApiKey, sessionId: r.vivixSessionId }),
    ]);
    return { ok: true };
  }

  async function serveStatic(req, res) {
    let path;
    try { path = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { path = ""; }
    if (path === "/") path = "/index.html";
    const file = normalize(join(root, path));
    if (!path || !file.startsWith(root)) return send(res, 404, { error: "Not found" });
    try {
      const data = await readFile(file);
      res.writeHead(200, {
        "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
        "Cache-Control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      });
      res.end(data);
    } catch { send(res, 404, { error: "Not found" }); }
  }

  const routes = {
    "POST /api/session": startSession,
    "POST /api/session/stop": stopSession,
    "POST /api/session/interrupt": async body => { await interruptAgent(interruptRequest(body)); return { ok: true }; },
  };

  return async (req, res) => {
    try {
      const route = routes[`${req.method} ${req.url}`];
      if (route) return send(res, 200, await route(await readBody(req)));
      if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });
      if (req.method === "GET") return await serveStatic(req, res);
      send(res, 404, { error: "Not found" });
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.field && { field: e.field }) });
      if (e instanceof UpstreamError) return send(res, 502, { error: e.message });
      console.error(e);
      send(res, 500, { error: e.message?.startsWith("ConvoAI:") ? e.message : "Internal error" });
    }
  };
}
```

Note: `joinAgent` throws a plain `Error("ConvoAI: no agent id returned")`; the 500 branch above passes that message through because it carries no secret.

- [ ] **Step 5: Implement `server/index.mjs`**

```js
import http from "node:http";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.mjs";
import { createSession, closeSession } from "./vivix.mjs";
import { joinAgent, leaveAgent, interruptAgent } from "./agora.mjs";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT) || 8787;
const staticDir = fileURLToPath(new URL("../web/dist", import.meta.url));
const app = createApp({ createSession, closeSession, joinAgent, leaveAgent, interruptAgent, staticDir });

http.createServer(app).listen(port, host, function () {
  console.log(`Vivix × ConvoAI demo on http://${host === "0.0.0.0" ? "localhost" : host}:${this.address().port}`);
});
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run server/`
Expected: all server tests PASS (upstream 5, vivix 8, agora 8, app 10).

- [ ] **Step 7: Smoke the real server**

Run: `PORT=8787 node server/index.mjs & sleep 1; curl -s localhost:8787/health; curl -s -X POST localhost:8787/api/session -d '{}'; kill %1`
Expected: `{"ok":true}` then `{"error":"Agora App ID is required","field":"agora.appId"}`.

- [ ] **Step 8: Commit**

```bash
git add server/
git commit -m "Add stateless HTTP app with parallel start and rollback

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 5: Web scaffold + credentials config

**Files:**
- Create: `web/vite.config.ts`, `web/tsconfig.json`, `web/index.html`, `web/src/style.css`, `web/src/main.ts` (placeholder that only imports the CSS; replaced in Task 9), `web/src/config.ts`, `web/src/config.test.ts`

**Interfaces:**
- Produces:
  - `interface Credentials { agoraAppId: string; agoraCertificate: string; pipelineId: string; persona: string; vivixApiKey: string; imageUrl: string }`
  - `FIELDS: { key: keyof Credentials; label: string; secret: boolean; optional: boolean; placeholder: string; multiline?: boolean }[]`
  - `STORAGE_KEY = "vivix-convoai-demo.credentials"`
  - `loadCredentials(storage: Pick<Storage, "getItem">) => { creds: Credentials; remembered: boolean }`
  - `saveCredentials(storage: Pick<Storage, "setItem" | "removeItem">, creds: Credentials, remember: boolean) => void`
  - `validate(c: Credentials) => Partial<Record<keyof Credentials, string>>`
  - `toSessionBody(c: Credentials) => SessionBody` and `type SessionBody = { agora: { appId; certificate; pipelineId; persona? }, vivix: { apiKey; imageUrl? } }`
  - `SERVER_FIELD: Record<string, keyof Credentials>` mapping server `field` names (`agora.appId`, …) to form keys.

- [ ] **Step 1: Write the Vite/TS config, HTML shell and CSS**

```ts
// web/vite.config.ts
import { defineConfig } from "vite";
// Run as `vite web` / `vite build web`, so the root is this directory.
export default defineConfig({
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  server: {
    port: 5180,
    proxy: { "/api": "http://127.0.0.1:8787", "/health": "http://127.0.0.1:8787" },
  },
});
```

```json
// web/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"], "strict": true, "noEmit": true,
    "skipLibCheck": true, "types": ["vite/client"]
  },
  "include": ["src"]
}
```

```html
<!-- web/index.html -->
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Vivix × Agora ConvoAI</title>
</head>
<body>
  <main class="app">
    <section class="panel" id="setup">
      <h1>Vivix × Agora ConvoAI</h1>
      <form id="creds" autocomplete="off"></form>
      <label class="remember"><input type="checkbox" id="remember"> Remember on this device</label>
      <div class="controls">
        <button id="start" class="primary">Start</button>
        <button id="stop" disabled>Stop</button>
        <button id="mute" disabled>Mute mic</button>
        <button id="interrupt" disabled>Interrupt</button>
      </div>
      <p id="status" role="status">Enter credentials and press Start.</p>
    </section>
    <section class="stage">
      <div id="video"></div>
      <button id="sound" hidden>Enable sound</button>
    </section>
    <section class="panel side">
      <h2>Transcript</h2>
      <ol id="transcript"></ol>
      <h2>Latency</h2>
      <dl id="timeline"></dl>
      <p id="latency" class="muted">Relay + render: —</p>
    </section>
  </main>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

```css
/* web/src/style.css */
:root { color-scheme: dark; --bg: #0d0f12; --panel: #161a20; --line: #262c35; --text: #e7eaee;
  --muted: #8a94a3; --accent: #4f8cff; --bad: #ff6b6b; font: 14px/1.45 system-ui, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); }
.app { display: grid; grid-template-columns: 320px auto 320px; gap: 16px; padding: 16px; min-height: 100vh; justify-content: center; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px; overflow: auto; }
h1 { font-size: 16px; margin: 0 0 12px; } h2 { font-size: 13px; margin: 16px 0 8px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
form { display: grid; gap: 10px; }
label { display: grid; gap: 4px; font-size: 12px; color: var(--muted); }
input, textarea { background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 7px 9px; font: inherit; }
textarea { min-height: 64px; resize: vertical; }
.invalid input, .invalid textarea { border-color: var(--bad); }
.error { color: var(--bad); font-size: 12px; }
.remember { display: flex; grid-template-columns: none; align-items: center; gap: 6px; margin: 12px 0; }
.controls { display: flex; flex-wrap: wrap; gap: 8px; }
button { background: var(--line); color: var(--text); border: 0; border-radius: 6px; padding: 8px 12px; font: inherit; cursor: pointer; }
button.primary { background: var(--accent); } button:disabled { opacity: .45; cursor: default; }
#status { color: var(--muted); min-height: 2.9em; }
.stage { position: relative; height: calc(100vh - 32px); aspect-ratio: 9 / 16; background: #000; border-radius: 10px; overflow: hidden; }
#video { position: absolute; inset: 0; }
#sound { position: absolute; left: 50%; bottom: 24px; transform: translateX(-50%); }
#transcript { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
#transcript li { padding: 6px 9px; border-radius: 8px; background: var(--bg); }
#transcript li.agent { border-left: 3px solid var(--accent); } #transcript li.user { border-left: 3px solid var(--muted); }
#transcript li.partial { opacity: .6; }
#timeline { display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; margin: 0; font-variant-numeric: tabular-nums; }
#timeline dd { margin: 0; text-align: right; }
.muted { color: var(--muted); }
@media (max-width: 1100px) { .app { grid-template-columns: 1fr; } .stage { height: auto; width: min(100%, 420px); margin: 0 auto; } }
```

```ts
// web/src/main.ts (placeholder until Task 9)
import "./style.css";
```

- [ ] **Step 2: Write the failing test `web/src/config.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { loadCredentials, saveCredentials, validate, toSessionBody, STORAGE_KEY, type Credentials } from "./config";

const HEX = "0123456789abcdef0123456789abcdef";
const full: Credentials = { agoraAppId: HEX, agoraCertificate: HEX, pipelineId: "p", persona: "", vivixApiKey: "vk", imageUrl: "" };
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
};

describe("credential storage", () => {
  it("round-trips when remembered and forgets otherwise", () => {
    const s = memory();
    saveCredentials(s, full, true);
    expect(loadCredentials(s)).toEqual({ creds: full, remembered: true });
    saveCredentials(s, full, false);
    expect(s.m.has(STORAGE_KEY)).toBe(false);
    expect(loadCredentials(s).remembered).toBe(false);
  });

  it("ignores corrupt or partial storage", () => {
    const s = memory();
    s.setItem(STORAGE_KEY, "{not json");
    expect(loadCredentials(s).creds.agoraAppId).toBe("");
    s.setItem(STORAGE_KEY, JSON.stringify({ agoraAppId: HEX, extra: 1 }));
    expect(loadCredentials(s).creds).toEqual({ ...full, agoraCertificate: "", pipelineId: "", vivixApiKey: "", agoraAppId: HEX });
  });
});

describe("validate", () => {
  it("accepts a complete set", () => expect(validate(full)).toEqual({}));
  it("flags each problem by field", () => {
    expect(validate({ ...full, agoraAppId: "xyz", vivixApiKey: " ", imageUrl: "http://a/b.jpg" })).toEqual({
      agoraAppId: "32 hex characters", vivixApiKey: "Required", imageUrl: "Must be an https URL" });
  });
});

describe("toSessionBody", () => {
  it("trims and omits empty optionals", () => {
    expect(toSessionBody({ ...full, pipelineId: " p ", persona: "  " })).toEqual({
      agora: { appId: HEX, certificate: HEX, pipelineId: "p" }, vivix: { apiKey: "vk" } });
    expect(toSessionBody({ ...full, persona: "Be brief", imageUrl: "https://a/b.png" })).toEqual({
      agora: { appId: HEX, certificate: HEX, pipelineId: "p", persona: "Be brief" }, vivix: { apiKey: "vk", imageUrl: "https://a/b.png" } });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run web/src/config.test.ts`
Expected: FAIL — cannot resolve `./config`.

- [ ] **Step 4: Implement `web/src/config.ts`**

```ts
// Credentials typed by the customer. Kept in memory unless "remember" is ticked, then in
// localStorage on this device only. They go to our own backend per request, never elsewhere.
export interface Credentials {
  agoraAppId: string; agoraCertificate: string; pipelineId: string; persona: string;
  vivixApiKey: string; imageUrl: string;
}

export type SessionBody = {
  agora: { appId: string; certificate: string; pipelineId: string; persona?: string };
  vivix: { apiKey: string; imageUrl?: string };
};

export const STORAGE_KEY = "vivix-convoai-demo.credentials";

export const FIELDS: { key: keyof Credentials; label: string; secret: boolean; optional: boolean; placeholder: string; multiline?: boolean }[] = [
  { key: "agoraAppId", label: "Agora App ID", secret: false, optional: false, placeholder: "32 hex characters" },
  { key: "agoraCertificate", label: "Agora App Certificate", secret: true, optional: false, placeholder: "Primary certificate" },
  { key: "pipelineId", label: "ConvoAI pipeline ID", secret: false, optional: false, placeholder: "Console → Agents → Code panel" },
  { key: "vivixApiKey", label: "Vivix API key", secret: true, optional: false, placeholder: "From the Vivix console" },
  { key: "imageUrl", label: "Avatar image URL (optional)", secret: false, optional: true, placeholder: "https://… (default: Vivix Quickstart image)" },
  { key: "persona", label: "Persona override (optional)", secret: false, optional: true, placeholder: "Empty = the agent's published prompt", multiline: true },
];

export const SERVER_FIELD: Record<string, keyof Credentials> = {
  "agora.appId": "agoraAppId", "agora.certificate": "agoraCertificate", "agora.pipelineId": "pipelineId",
  "agora.persona": "persona", "vivix.apiKey": "vivixApiKey", "vivix.imageUrl": "imageUrl",
};

const empty = (): Credentials => ({ agoraAppId: "", agoraCertificate: "", pipelineId: "", persona: "", vivixApiKey: "", imageUrl: "" });

export function loadCredentials(storage: Pick<Storage, "getItem">): { creds: Credentials; remembered: boolean } {
  const creds = empty();
  let stored: unknown;
  try { stored = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null"); } catch { stored = null; }
  if (!stored || typeof stored !== "object") return { creds, remembered: false };
  for (const k of Object.keys(creds) as (keyof Credentials)[]) {
    const v = (stored as Record<string, unknown>)[k];
    if (typeof v === "string") creds[k] = v;
  }
  return { creds, remembered: true };
}

export function saveCredentials(storage: Pick<Storage, "setItem" | "removeItem">, creds: Credentials, remember: boolean): void {
  if (remember) storage.setItem(STORAGE_KEY, JSON.stringify(creds));
  else storage.removeItem(STORAGE_KEY);
}

const HEX32 = /^[0-9a-f]{32}$/i;

export function validate(c: Credentials): Partial<Record<keyof Credentials, string>> {
  const errors: Partial<Record<keyof Credentials, string>> = {};
  for (const f of FIELDS) if (!f.optional && !c[f.key].trim()) errors[f.key] = "Required";
  for (const k of ["agoraAppId", "agoraCertificate"] as const) {
    if (c[k].trim() && !HEX32.test(c[k].trim())) errors[k] = "32 hex characters";
  }
  const url = c.imageUrl.trim();
  if (url) {
    let ok = false;
    try { ok = new URL(url).protocol === "https:"; } catch { /* invalid */ }
    if (!ok) errors.imageUrl = "Must be an https URL";
  }
  return errors;
}

export function toSessionBody(c: Credentials): SessionBody {
  const persona = c.persona.trim(), imageUrl = c.imageUrl.trim();
  return {
    agora: { appId: c.agoraAppId.trim(), certificate: c.agoraCertificate.trim(), pipelineId: c.pipelineId.trim(), ...(persona ? { persona } : {}) },
    vivix: { apiKey: c.vivixApiKey.trim(), ...(imageUrl ? { imageUrl } : {}) },
  };
}
```

- [ ] **Step 5: Run tests and the type check**

Run: `npx vitest run web/src/config.test.ts && npx tsc -p web && npx vite build web`
Expected: 5 tests PASS; `tsc` silent; Vite writes `web/dist/index.html` and `web/dist/assets/*.css`.

- [ ] **Step 6: Commit**

```bash
git add web/
git commit -m "Add web scaffold and credentials config

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 6: API client + transcript assembler

**Files:**
- Create: `web/src/api.ts`, `web/src/transcript.ts`, `web/src/transcript.test.ts`

**Interfaces:**
- Consumes: `SessionBody` (Task 5); HTTP contract (Task 4).
- Produces:
  - `api.ts`: `interface AgoraMedia { appId: string; channel: string; token: string; uid: string; publisherUid: string }`, `interface VivixSession { sessionId: string; control: { url: string; clientSecret: string }; media: AgoraMedia }`, `interface ConvoSession { agentId: string; appId: string; channel: string; uid: number; token: string; agentUid: number }`, `interface StartResponse { vivix: VivixSession; convo: ConvoSession; timings: { vivixCreateMs: number; convoJoinMs: number } }`, `class ApiError extends Error { field?: string }`, `startSession(body: SessionBody): Promise<StartResponse>`, `stopSession(body: StopBody): Promise<void>`, `interruptAgent(body: InterruptBody): Promise<void>`, `beaconStop(body: StopBody): boolean`, `type StopBody = { agora: { appId; certificate }; vivix: { apiKey }; agentId: string; vivixSessionId: string }`, `type InterruptBody = { agora: { appId; certificate }; agentId: string }`.
  - `transcript.ts`: `interface ConvoMessage { object?: string; text?: string; final?: boolean; turn_id?: number; turn_status?: number }`, `createAssembler(): (data: Uint8Array) => ConvoMessage | null`, `interface Line { role: "user" | "agent"; turnId: number; text: string; final: boolean }`, `applyMessage(lines: Line[], msg: ConvoMessage): Line[]`.

- [ ] **Step 1: Write `web/src/api.ts`** (thin I/O wrapper; covered by the e2e smoke in Task 10)

```ts
import type { SessionBody } from "./config";

export interface AgoraMedia { appId: string; channel: string; token: string; uid: string; publisherUid: string }
export interface VivixSession { sessionId: string; control: { url: string; clientSecret: string }; media: AgoraMedia }
export interface ConvoSession { agentId: string; appId: string; channel: string; uid: number; token: string; agentUid: number }
export interface StartResponse { vivix: VivixSession; convo: ConvoSession; timings: { vivixCreateMs: number; convoJoinMs: number } }
type AgoraAuth = { appId: string; certificate: string };
export type StopBody = { agora: AgoraAuth; vivix: { apiKey: string }; agentId: string; vivixSessionId: string };
export type InterruptBody = { agora: AgoraAuth; agentId: string };

export class ApiError extends Error {
  constructor(message: string, readonly field?: string) { super(message); }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `HTTP ${res.status}`, data.field);
  return data as T;
}

export const startSession = (body: SessionBody) => post<StartResponse>("/api/session", body);
export const stopSession = (body: StopBody) => post<void>("/api/session/stop", body);
export const interruptAgent = (body: InterruptBody) => post<void>("/api/session/interrupt", body);

// For pagehide: survives the page going away. text/plain keeps it a simple request.
export const beaconStop = (body: StopBody) =>
  navigator.sendBeacon("/api/session/stop", new Blob([JSON.stringify(body)], { type: "text/plain" }));
```

- [ ] **Step 2: Write the failing test `web/src/transcript.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { createAssembler, applyMessage, type Line } from "./transcript";

const enc = (s: string) => new TextEncoder().encode(s);
const b64 = (obj: unknown) => {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  return btoa(String.fromCharCode(...bytes));
};

describe("createAssembler", () => {
  it("decodes a single-part message, including UTF-8", () => {
    const next = createAssembler();
    expect(next(enc(`m1|1|1|${b64({ object: "user.transcription", text: "你好 café", final: true, turn_id: 1 })}`)))
      .toEqual({ object: "user.transcription", text: "你好 café", final: true, turn_id: 1 });
  });

  it("reassembles parts that arrive out of order", () => {
    const next = createAssembler();
    const whole = b64({ object: "assistant.transcription", text: "Hello there", turn_id: 2, turn_status: 1 });
    const [a, b, c] = [whole.slice(0, 5), whole.slice(5, 11), whole.slice(11)];
    expect(next(enc(`m2|3|3|${c}`))).toBeNull();
    expect(next(enc(`m2|1|3|${a}`))).toBeNull();
    expect(next(enc(`m2|2|3|${b}`))?.text).toBe("Hello there");
  });

  it("ignores malformed chunks", () => {
    const next = createAssembler();
    expect(next(enc("garbage"))).toBeNull();
    expect(next(enc("m3|1|1|!!!notbase64"))).toBeNull();
  });
});

describe("applyMessage", () => {
  it("upserts partial then final lines per role and turn", () => {
    let lines: Line[] = [];
    lines = applyMessage(lines, { object: "user.transcription", text: "Hi th", final: false, turn_id: 1 });
    lines = applyMessage(lines, { object: "user.transcription", text: "Hi there", final: true, turn_id: 1 });
    lines = applyMessage(lines, { object: "assistant.transcription", text: "Hello", turn_id: 1, turn_status: 0 });
    lines = applyMessage(lines, { object: "assistant.transcription", text: "Hello!", turn_id: 1, turn_status: 1 });
    expect(lines).toEqual([
      { role: "user", turnId: 1, text: "Hi there", final: true },
      { role: "agent", turnId: 1, text: "Hello!", final: true },
    ]);
  });

  it("marks interrupted agent turns final and ignores other objects", () => {
    let lines = applyMessage([], { object: "assistant.transcription", text: "Cut", turn_id: 4, turn_status: 2 });
    expect(lines[0].final).toBe(true);
    lines = applyMessage(lines, { object: "message.metrics", text: "x" });
    expect(lines).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run web/src/transcript.test.ts`
Expected: FAIL — cannot resolve `./transcript`.

- [ ] **Step 4: Implement `web/src/transcript.ts`**

```ts
// ConvoAI publishes transcripts over the RTC datastream as "<id>|<part>|<total>|<base64 JSON>"
// chunks. User lines carry `final`; agent lines carry `turn_status` (0 in progress, 1 done,
// 2 interrupted).
export interface ConvoMessage { object?: string; text?: string; final?: boolean; turn_id?: number; turn_status?: number }
export interface Line { role: "user" | "agent"; turnId: number; text: string; final: boolean }

export function createAssembler(): (data: Uint8Array) => ConvoMessage | null {
  const pending = new Map<string, string[]>();
  const decoder = new TextDecoder();
  return data => {
    const parts = decoder.decode(data).split("|");
    if (parts.length !== 4) return null;
    const [id, idx, total, chunk] = parts;
    const i = Number(idx), n = Number(total);
    if (!(i >= 1 && i <= n && n <= 1000)) return null;
    const chunks = pending.get(id) ?? new Array<string>(n);
    chunks[i - 1] = chunk;
    pending.set(id, chunks);
    if (chunks.filter(c => c !== undefined).length < n) return null;
    pending.delete(id);
    try {
      const bytes = Uint8Array.from(atob(chunks.join("")), ch => ch.charCodeAt(0));
      return JSON.parse(decoder.decode(bytes)) as ConvoMessage;
    } catch { return null; }
  };
}

export function applyMessage(lines: Line[], msg: ConvoMessage): Line[] {
  const role = msg.object === "user.transcription" ? "user" : msg.object === "assistant.transcription" ? "agent" : null;
  if (!role || typeof msg.text !== "string") return lines;
  const turnId = msg.turn_id ?? -1;
  const final = role === "user" ? msg.final === true : msg.turn_status !== undefined && msg.turn_status !== 0;
  const line: Line = { role, turnId, text: msg.text, final };
  const at = lines.findIndex(l => l.role === role && l.turnId === turnId);
  if (at === -1) return [...lines, line];
  return lines.map((l, i) => (i === at ? line : l));
}
```

- [ ] **Step 5: Run tests and type check**

Run: `npx vitest run web/src/transcript.test.ts && npx tsc -p web`
Expected: 5 tests PASS; `tsc` silent.

- [ ] **Step 6: Commit**

```bash
git add web/src/api.ts web/src/transcript.ts web/src/transcript.test.ts
git commit -m "Add API client and ConvoAI transcript assembler

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 7: Latency metrics

**Files:**
- Create: `web/src/metrics.ts`, `web/src/metrics.test.ts`

**Interfaces:**
- Produces:
  - `class Timeline { constructor(now?: () => number); reset(): void; mark(label: string): number; readonly entries: { label: string; ms: number }[] }` — `ms` is since the last `reset()`.
  - `class OnsetTracker { constructor(opts?: { threshold?: number; quiet?: number; quietMs?: number; giveUpMs?: number }); sample(agent: number, avatar: number, now: number): number | null }` — returns the agent-onset → avatar-onset latency in ms exactly once per turn.

- [ ] **Step 1: Write the failing test `web/src/metrics.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { Timeline, OnsetTracker } from "./metrics";

describe("Timeline", () => {
  it("records ms since reset", () => {
    let t = 1000;
    const tl = new Timeline(() => t);
    tl.reset();
    t = 1250; expect(tl.mark("a")).toBe(250);
    t = 1900; tl.mark("b");
    expect(tl.entries).toEqual([{ label: "a", ms: 250 }, { label: "b", ms: 900 }]);
    tl.reset();
    expect(tl.entries).toEqual([]);
  });
});

describe("OnsetTracker", () => {
  it("reports agent→avatar onset once per turn, then re-arms after quiet", () => {
    const o = new OnsetTracker({ threshold: 0.05, quiet: 0.01, quietMs: 600 });
    expect(o.sample(0, 0, 0)).toBeNull();
    expect(o.sample(0.3, 0, 100)).toBeNull();      // agent starts
    expect(o.sample(0.4, 0.02, 1000)).toBeNull();  // avatar below threshold
    expect(o.sample(0.4, 0.2, 2350)).toBe(2250);   // avatar starts
    expect(o.sample(0.4, 0.3, 2400)).toBeNull();   // same turn: no repeat
    expect(o.sample(0, 0, 5000)).toBeNull();       // quiet begins
    expect(o.sample(0, 0, 5700)).toBeNull();       // quiet long enough → idle
    expect(o.sample(0.2, 0, 6000)).toBeNull();     // next turn
    expect(o.sample(0.2, 0.1, 8500)).toBe(2500);
  });

  it("does not re-arm on a short pause between words", () => {
    const o = new OnsetTracker({ quietMs: 600 });
    o.sample(0.3, 0, 0);
    expect(o.sample(0.3, 0.3, 2000)).toBe(2000);
    o.sample(0, 0, 2100);
    o.sample(0.3, 0.3, 2300);                      // speech resumes before 600 ms of quiet
    expect(o.sample(0.3, 0.3, 2400)).toBeNull();
  });

  it("gives up when the avatar never speaks", () => {
    const o = new OnsetTracker({ giveUpMs: 8000 });
    o.sample(0.3, 0, 0);
    expect(o.sample(0.3, 0, 9000)).toBeNull();     // abandoned
    expect(o.sample(0.3, 0, 9100)).toBeNull();     // new onset
    expect(o.sample(0.3, 0.2, 10100)).toBe(1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run web/src/metrics.test.ts`
Expected: FAIL — cannot resolve `./metrics`.

- [ ] **Step 3: Implement `web/src/metrics.ts`**

```ts
// Startup timeline and per-turn relay + render latency: from the moment the agent's TTS audio
// becomes audible to the moment the avatar's audio does, sampled from track volume levels.
export class Timeline {
  private start = 0;
  readonly entries: { label: string; ms: number }[] = [];
  constructor(private now: () => number = () => performance.now()) {}
  reset(): void { this.start = this.now(); this.entries.length = 0; }
  mark(label: string): number {
    const ms = Math.round(this.now() - this.start);
    this.entries.push({ label, ms });
    return ms;
  }
}

type State = { kind: "idle" } | { kind: "waiting"; onset: number } | { kind: "speaking"; quietSince: number | null };

export class OnsetTracker {
  private state: State = { kind: "idle" };
  private threshold: number; private quiet: number; private quietMs: number; private giveUpMs: number;
  constructor({ threshold = 0.05, quiet = 0.01, quietMs = 600, giveUpMs = 8000 } = {}) {
    this.threshold = threshold; this.quiet = quiet; this.quietMs = quietMs; this.giveUpMs = giveUpMs;
  }

  sample(agent: number, avatar: number, now: number): number | null {
    const s = this.state;
    if (s.kind === "idle") {
      if (agent > this.threshold) this.state = { kind: "waiting", onset: now };
      return null;
    }
    if (s.kind === "waiting") {
      if (avatar > this.threshold) { this.state = { kind: "speaking", quietSince: null }; return Math.round(now - s.onset); }
      if (now - s.onset > this.giveUpMs) this.state = { kind: "idle" };
      return null;
    }
    const silent = agent < this.quiet && avatar < this.quiet;
    if (!silent) s.quietSince = null;
    else if (s.quietSince === null) s.quietSince = now;
    else if (now - s.quietSince >= this.quietMs) this.state = { kind: "idle" };
    return null;
  }
}
```

- [ ] **Step 4: Run tests and type check**

Run: `npx vitest run web/src/metrics.test.ts && npx tsc -p web`
Expected: 4 tests PASS; `tsc` silent.

- [ ] **Step 5: Commit**

```bash
git add web/src/metrics.ts web/src/metrics.test.ts
git commit -m "Add startup timeline and relay latency tracker

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 8: RTC layer — ConvoAI channel, Vivix channel, relay

These wrap the Agora Web SDK and a WebSocket; they are verified by the e2e smoke in Task 10, not unit tests. Code follows the proven `02-convoai-spike/main.js`.

**Files:**
- Create: `web/src/convo.ts`, `web/src/avatar.ts`, `web/src/relay.ts`

**Interfaces:**
- Consumes: `ConvoSession`, `VivixSession` (Task 6); `ConvoMessage`, `createAssembler` (Task 6).
- Produces:
  - `convo.ts`: `interface ConvoHandlers { agentJoined(): void; agentAudio(track: IRemoteAudioTrack): void; agentLeft(): void; message(msg: ConvoMessage): void }`; `joinConvo(s: ConvoSession, h: ConvoHandlers): Promise<IAgoraRTCClient>`
  - `avatar.ts`: `interface AvatarHandlers { firstFrame(): void; audio(track: IRemoteAudioTrack): void; autoplayBlocked(): void; controlLost(): void }`; `interface AvatarLink { client: IAgoraRTCClient; ws: WebSocket; close(): Promise<void> }`; `joinAvatar(s: VivixSession, videoEl: HTMLElement, h: AvatarHandlers): Promise<AvatarLink>`
  - `relay.ts`: `interface Relay { close(): Promise<void> }`; `startRelay(agentTrack: IRemoteAudioTrack, target: IAgoraRTCClient): Promise<Relay>`

- [ ] **Step 1: Implement `web/src/convo.ts`**

```ts
// Channel A — the customer's Agora project. We publish the mic and take the agent's TTS track,
// which is relayed, never played: the avatar's audio is the only thing the user hears.
import AgoraRTC, { type IAgoraRTCClient, type IRemoteAudioTrack } from "agora-rtc-sdk-ng";
import type { ConvoSession } from "./api";
import { createAssembler, type ConvoMessage } from "./transcript";

export interface ConvoHandlers {
  agentJoined(): void;
  agentAudio(track: IRemoteAudioTrack): void;
  agentLeft(): void;
  message(msg: ConvoMessage): void;
}

export async function joinConvo(s: ConvoSession, h: ConvoHandlers): Promise<IAgoraRTCClient> {
  const client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
  const isAgent = (uid: unknown) => String(uid) === String(s.agentUid);
  const assemble = createAssembler();

  client.on("user-joined", u => { if (isAgent(u.uid)) h.agentJoined(); });
  client.on("user-left", u => { if (isAgent(u.uid)) h.agentLeft(); });
  client.on("user-published", async (user, type) => {
    if (!isAgent(user.uid) || type !== "audio") return;
    await client.subscribe(user, "audio");
    if (user.audioTrack) h.agentAudio(user.audioTrack);
  });
  client.on("stream-message", (uid, data) => {
    if (!isAgent(uid)) return;
    const msg = assemble(data);
    if (msg) h.message(msg);
  });

  await client.join(s.appId, s.channel, s.token, s.uid);
  return client;
}
```

- [ ] **Step 2: Implement `web/src/avatar.ts`**

```ts
// Channel B — provisioned by Vivix. We subscribe only to the avatar publisher and keep the
// control WebSocket open; Vivix's auto_close counts that connection, not RTC presence.
import AgoraRTC, { type IAgoraRTCClient, type IRemoteAudioTrack } from "agora-rtc-sdk-ng";
import type { VivixSession } from "./api";

export interface AvatarHandlers {
  firstFrame(): void;
  audio(track: IRemoteAudioTrack): void;
  autoplayBlocked(): void;
  controlLost(): void;
}

export interface AvatarLink { client: IAgoraRTCClient; ws: WebSocket; close(): Promise<void> }

const CONTROL_TIMEOUT_MS = 15_000;
const asUid = (v: string) => (/^\d+$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : v);

function openControl(control: VivixSession["control"], lost: () => void): Promise<WebSocket> {
  const url = new URL(control.url);
  url.searchParams.set("token", control.clientSecret);
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error("Vivix control connection timed out")); }, CONTROL_TIMEOUT_MS);
    ws.onopen = () => {
      clearTimeout(timer);
      ws.onclose = ws.onerror = () => lost();
      resolve(ws);
    };
    ws.onerror = ws.onclose = () => { clearTimeout(timer); reject(new Error("Vivix control connection failed")); };
  });
}

export async function joinAvatar(s: VivixSession, videoEl: HTMLElement, h: AvatarHandlers): Promise<AvatarLink> {
  const m = s.media;
  const client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
  AgoraRTC.onAutoplayFailed = () => h.autoplayBlocked();

  client.on("user-published", async (user, type) => {
    if (String(user.uid) !== m.publisherUid) return;
    await client.subscribe(user, type);
    if (type === "video" && user.videoTrack) {
      let seen = false;
      user.videoTrack.on("first-frame-decoded", () => { if (!seen) { seen = true; h.firstFrame(); } });
      user.videoTrack.play(videoEl, { fit: "contain" });
    }
    if (type === "audio" && user.audioTrack) {
      user.audioTrack.play();
      h.audio(user.audioTrack);
    }
  });

  let closing = false;
  let ws: WebSocket;
  try {
    [ws] = await Promise.all([
      openControl(s.control, () => { if (!closing) h.controlLost(); }),
      client.join(m.appId, m.channel, m.token || null, asUid(m.uid)),
    ]);
  } catch (e) {
    closing = true;
    await client.leave().catch(() => {});
    throw e;
  }

  return {
    client, ws,
    async close() {
      closing = true;
      AgoraRTC.onAutoplayFailed = undefined;
      ws.close();
      await client.leave();
      client.removeAllListeners();
    },
  };
}
```

- [ ] **Step 3: Implement `web/src/relay.ts`**

```ts
// Republish the agent's decoded TTS track into the Vivix channel unchanged. Vivix's listener
// subscribes to it and renders the avatar from it (pure rendering / passthrough mode).
import AgoraRTC, { type IAgoraRTCClient, type IRemoteAudioTrack } from "agora-rtc-sdk-ng";

export interface Relay { close(): Promise<void> }

export async function startRelay(agentTrack: IRemoteAudioTrack, target: IAgoraRTCClient): Promise<Relay> {
  const source = agentTrack.getMediaStreamTrack();
  // Chrome only pulls audio through a remote WebRTC track that has a sink; a muted element is
  // enough and keeps the agent inaudible.
  const sink = new Audio();
  sink.muted = true;
  sink.srcObject = new MediaStream([source]);
  sink.play().catch(() => {});

  const track = AgoraRTC.createCustomAudioTrack({ mediaStreamTrack: source });
  await target.publish(track);
  return {
    async close() {
      try { await target.unpublish(track); } catch { /* channel already left */ }
      track.close();
      sink.srcObject = null;
    },
  };
}
```

- [ ] **Step 4: Type check**

Run: `npx tsc -p web`
Expected: silent. If `client.on("stream-message")` types the payload as `Uint8Array`, no cast is needed; if the installed SDK version types it differently, adapt the parameter type to match the SDK's declaration rather than casting to `any`.

- [ ] **Step 5: Commit**

```bash
git add web/src/convo.ts web/src/avatar.ts web/src/relay.ts
git commit -m "Add RTC layer: ConvoAI channel, Vivix channel, audio relay

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 9: Session orchestration + UI wiring

**Files:**
- Create: `web/src/session.ts`
- Modify: `web/src/main.ts` (replace the Task 5 placeholder entirely)

**Interfaces:**
- Consumes: everything from Tasks 5–8.
- Produces:
  - `interface SessionEvents { status(text: string): void; mark(label: string, ms: number): void; latency(ms: number): void; transcript(lines: Line[]): void; autoplayBlocked(): void; ended(reason: string): void }`
  - `class Session { constructor(creds: Credentials, videoEl: HTMLElement, events: SessionEvents); start(): Promise<void>; stop(): Promise<void>; interrupt(): Promise<void>; setMuted(muted: boolean): Promise<void>; resumeAudio(): void; stopOnUnload(): void; readonly active: boolean }`

- [ ] **Step 1: Implement `web/src/session.ts`**

```ts
// Start: mic capture and POST /api/session run in parallel; then channel A, channel B and the
// Vivix control socket are joined in parallel. Stop tears down locally, then closes upstream.
import AgoraRTC, { type IAgoraRTCClient, type IMicrophoneAudioTrack, type IRemoteAudioTrack } from "agora-rtc-sdk-ng";
import { startSession, stopSession, interruptAgent, beaconStop, type StartResponse, type StopBody } from "./api";
import { toSessionBody, type Credentials } from "./config";
import { joinConvo } from "./convo";
import { joinAvatar, type AvatarLink } from "./avatar";
import { startRelay, type Relay } from "./relay";
import { applyMessage, type Line } from "./transcript";
import { Timeline, OnsetTracker } from "./metrics";

export interface SessionEvents {
  status(text: string): void;
  mark(label: string, ms: number): void;
  latency(ms: number): void;
  transcript(lines: Line[]): void;
  autoplayBlocked(): void;
  ended(reason: string): void;
}

AgoraRTC.setLogLevel(3); // warnings and errors only

export class Session {
  private started?: StartResponse;
  private convo?: IAgoraRTCClient;
  private avatar?: AvatarLink;
  private mic?: IMicrophoneAudioTrack;
  private micPending?: Promise<IMicrophoneAudioTrack>;
  private relay?: Relay;
  private relayChain: Promise<void> = Promise.resolve();
  private agentAudio?: IRemoteAudioTrack;
  private avatarAudio?: IRemoteAudioTrack;
  private lines: Line[] = [];
  private sampler?: number;
  private timeline = new Timeline();
  private onset = new OnsetTracker();
  private stopping = false;

  constructor(private creds: Credentials, private videoEl: HTMLElement, private ev: SessionEvents) {}

  get active(): boolean { return !!this.started && !this.stopping; }

  private mark(label: string) { this.ev.mark(label, this.timeline.mark(label)); }

  async start(): Promise<void> {
    this.timeline.reset();
    this.ev.status("Starting…");
    const micReady = AgoraRTC.createMicrophoneAudioTrack({ AEC: true, ANS: true, AGC: true });
    micReady.catch(() => {}); // surfaced below; avoid an unhandled rejection if the session fails first
    this.micPending = micReady; // stop() closes it even when start fails part-way
    const s = await startSession(toSessionBody(this.creds));
    this.started = s;
    this.ev.mark("Vivix session created", s.timings.vivixCreateMs);
    this.ev.mark("ConvoAI agent started", s.timings.convoJoinMs);
    this.mark("Sessions ready");

    const avatarJoin = joinAvatar(s.vivix, this.videoEl, {
      firstFrame: () => { this.mark("Avatar first frame"); this.ev.status("Live — speak to the avatar."); },
      audio: track => { this.avatarAudio = track; },
      autoplayBlocked: () => this.ev.autoplayBlocked(),
      controlLost: () => { if (!this.stopping) this.ev.ended("Vivix control connection closed."); },
    }).then(a => { this.avatar = a; this.mark("Joined Vivix channel"); return a; });

    const [convo] = await Promise.all([
      joinConvo(s.convo, {
        agentJoined: () => this.mark("Agent joined"),
        agentLeft: () => { if (!this.stopping) this.ev.ended("The agent left the channel (idle timeout or error)."); },
        agentAudio: track => {
          this.agentAudio = track;
          // Relay once channel B is joined; chained so a republish replaces the old relay in order.
          this.relayChain = this.relayChain.then(async () => {
            const link = await avatarJoin;
            await this.relay?.close();
            this.relay = await startRelay(track, link.client);
            this.mark("Agent audio relayed");
          }).catch(e => this.ev.status(`Relay failed: ${e.message}`));
        },
        message: msg => { this.lines = applyMessage(this.lines, msg); this.ev.transcript(this.lines); },
      }).then(c => { this.convo = c; this.mark("Joined ConvoAI channel"); return c; }),
      avatarJoin,
    ]);

    try { this.mic = await micReady; }
    catch (e) { throw new Error(`Microphone unavailable: ${(e as Error).message}`); }
    await convo.publish(this.mic);
    this.mark("Mic live");

    this.sampler = window.setInterval(() => {
      const ms = this.onset.sample(this.agentAudio?.getVolumeLevel() ?? 0, this.avatarAudio?.getVolumeLevel() ?? 0, performance.now());
      if (ms !== null) this.ev.latency(ms);
    }, 50);
  }

  private stopBody(): StopBody | null {
    if (!this.started) return null;
    return {
      agora: { appId: this.creds.agoraAppId.trim(), certificate: this.creds.agoraCertificate.trim() },
      vivix: { apiKey: this.creds.vivixApiKey.trim() },
      agentId: this.started.convo.agentId,
      vivixSessionId: this.started.vivix.sessionId,
    };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    window.clearInterval(this.sampler);
    await this.relayChain;
    await Promise.allSettled([this.relay?.close()]);
    (this.mic ?? (await this.micPending?.catch(() => undefined)))?.close();
    await Promise.allSettled([this.convo?.leave(), this.avatar?.close()]);
    this.convo?.removeAllListeners();
    const body = this.stopBody();
    if (body) await stopSession(body);
    this.started = undefined;
  }

  stopOnUnload(): void {
    const body = this.stopBody();
    if (body && !this.stopping) { this.stopping = true; beaconStop(body); }
  }

  async interrupt(): Promise<void> {
    if (!this.started) return;
    await interruptAgent({
      agora: { appId: this.creds.agoraAppId.trim(), certificate: this.creds.agoraCertificate.trim() },
      agentId: this.started.convo.agentId,
    });
  }

  async setMuted(muted: boolean): Promise<void> { await this.mic?.setMuted(muted); }

  resumeAudio(): void { this.avatarAudio?.play(); }
}
```

- [ ] **Step 2: Implement `web/src/main.ts`**

```ts
import "./style.css";
import { FIELDS, SERVER_FIELD, loadCredentials, saveCredentials, validate, type Credentials } from "./config";
import { ApiError } from "./api";
import { Session } from "./session";
import type { Line } from "./transcript";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const form = $<HTMLFormElement>("#creds");
const remember = $<HTMLInputElement>("#remember");
const startBtn = $<HTMLButtonElement>("#start"), stopBtn = $<HTMLButtonElement>("#stop");
const muteBtn = $<HTMLButtonElement>("#mute"), interruptBtn = $<HTMLButtonElement>("#interrupt");
const soundBtn = $<HTMLButtonElement>("#sound"), status = $("#status");
const transcript = $("#transcript"), timeline = $("#timeline"), latency = $("#latency");

const { creds: initial, remembered } = loadCredentials(localStorage);
remember.checked = remembered;
const inputs = {} as Record<keyof Credentials, HTMLInputElement | HTMLTextAreaElement>;
for (const f of FIELDS) {
  const label = document.createElement("label");
  label.dataset.field = f.key;
  const input = f.multiline ? document.createElement("textarea") : document.createElement("input");
  if (input instanceof HTMLInputElement) input.type = f.secret ? "password" : "text";
  input.placeholder = f.placeholder;
  input.value = initial[f.key];
  input.spellcheck = false;
  const err = document.createElement("span");
  err.className = "error";
  label.append(f.label, input, err);
  form.append(label);
  inputs[f.key] = input;
}

const read = (): Credentials => Object.fromEntries(FIELDS.map(f => [f.key, inputs[f.key].value])) as unknown as Credentials;
function showErrors(errors: Partial<Record<keyof Credentials, string>>) {
  for (const f of FIELDS) {
    const label = form.querySelector<HTMLElement>(`[data-field="${f.key}"]`)!;
    label.classList.toggle("invalid", !!errors[f.key]);
    label.querySelector(".error")!.textContent = errors[f.key] ?? "";
  }
}

let session: Session | undefined;
let muted = false;
const latencies: number[] = [];

function setRunning(running: boolean) {
  startBtn.disabled = running;
  stopBtn.disabled = !running;
  muteBtn.disabled = interruptBtn.disabled = !running;
  for (const el of Object.values(inputs)) el.disabled = running;
}

function renderTranscript(lines: Line[]) {
  transcript.replaceChildren(...lines.map(l => {
    const li = document.createElement("li");
    li.className = `${l.role}${l.final ? "" : " partial"}`;
    li.textContent = l.text;
    return li;
  }));
  transcript.lastElementChild?.scrollIntoView({ block: "nearest" });
}

async function stop(reason?: string) {
  const s = session;
  if (!s) return;
  session = undefined;
  stopBtn.disabled = true;
  status.textContent = "Stopping…";
  try { await s.stop(); status.textContent = reason ?? "Stopped."; }
  catch (e) { status.textContent = `Stopped locally; upstream close failed: ${(e as Error).message}`; }
  setRunning(false);
  soundBtn.hidden = true;
}

startBtn.onclick = async () => {
  const creds = read();
  const errors = validate(creds);
  showErrors(errors);
  if (Object.keys(errors).length) { status.textContent = "Fix the highlighted fields."; return; }
  saveCredentials(localStorage, creds, remember.checked);

  timeline.replaceChildren(); transcript.replaceChildren(); latencies.length = 0;
  latency.textContent = "Relay + render: —";
  muted = false; muteBtn.textContent = "Mute mic";
  setRunning(true);
  session = new Session(creds, $("#video"), {
    status: t => { status.textContent = t; },
    mark: (label, ms) => {
      const dt = document.createElement("dt"), dd = document.createElement("dd");
      dt.textContent = label; dd.textContent = `${ms} ms`;
      timeline.append(dt, dd);
    },
    latency: ms => {
      latencies.push(ms);
      const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
      latency.textContent = `Relay + render: last ${ms} ms · avg ${avg} ms (${latencies.length} turns)`;
    },
    transcript: renderTranscript,
    autoplayBlocked: () => { soundBtn.hidden = false; },
    ended: reason => void stop(reason),
  });
  try { await session.start(); }
  catch (e) {
    const err = e as ApiError;
    if (err.field && SERVER_FIELD[err.field]) showErrors({ [SERVER_FIELD[err.field]]: err.message });
    await stop(`Start failed: ${err.message}`);
  }
};

stopBtn.onclick = () => void stop();
interruptBtn.onclick = () => session?.interrupt().catch(e => { status.textContent = `Interrupt failed: ${e.message}`; });
muteBtn.onclick = async () => {
  muted = !muted;
  await session?.setMuted(muted);
  muteBtn.textContent = muted ? "Unmute mic" : "Mute mic";
};
soundBtn.onclick = () => { soundBtn.hidden = true; session?.resumeAudio(); };
remember.onchange = () => saveCredentials(localStorage, read(), remember.checked);
addEventListener("pagehide", () => session?.stopOnUnload());
```

- [ ] **Step 3: Type check, unit tests, build**

Run: `npx tsc -p web && npm test && npm run build`
Expected: `tsc` silent; all unit tests PASS; `web/dist/index.html` + `web/dist/assets/*.js` written.

- [ ] **Step 4: Manual sanity check without credentials**

Run: `npm start & sleep 1; curl -s localhost:8787/ | grep -c 'Vivix × Agora ConvoAI'; kill %1`
Expected: `1`.

- [ ] **Step 5: Commit**

```bash
git add web/src/session.ts web/src/main.ts
git commit -m "Wire session orchestration and UI

🤖 Built with SMT <smt@agora.build>"
```

---

### Task 10: End-to-end smoke + README

**Files:**
- Create: `e2e/smoke.mjs`, `README.md`

**Interfaces:**
- Consumes: the built app (Task 9) served by `npm start`; DOM ids from `web/index.html` (`#creds` labels by `data-field`, `#start`, `#stop`, `#status`, `#timeline`, `#latency`, `#transcript`).
- Env: `VIVIX_API_KEY`, `AGORA_APP_ID`, `AGORA_APP_CERTIFICATE`, `AGORA_PIPELINE_ID`; optional `E2E_URL` (default `http://localhost:8787`), `E2E_WAV` (speech WAV for the fake mic), `CHROME_PATH` (default `/usr/bin/google-chrome`), `E2E_SECONDS` (default 35).

- [ ] **Step 1: Write `e2e/smoke.mjs`**

```js
// Drives the real app in headless Chrome: fills credentials, Start, waits for the avatar's
// first frame and at least one relayed agent reply, then Stop. Exits non-zero on failure.
import { chromium } from "playwright-core";

const need = k => { const v = process.env[k]; if (!v) { console.error(`Set ${k}`); process.exit(2); } return v; };
const creds = {
  agoraAppId: need("AGORA_APP_ID"), agoraCertificate: need("AGORA_APP_CERTIFICATE"),
  pipelineId: need("AGORA_PIPELINE_ID"), vivixApiKey: need("VIVIX_API_KEY"),
};
const url = process.env.E2E_URL || "http://localhost:8787";
const seconds = Number(process.env.E2E_SECONDS || 35);
const args = ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"];
if (process.env.E2E_WAV) args.push(`--use-file-for-fake-audio-capture=${process.env.E2E_WAV}`);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args });
let failed = false;
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["microphone"] })).newPage();
  page.on("console", m => { if (m.type() === "error" && !/favicon/.test(m.text())) console.log("[console]", m.text().slice(0, 200)); });
  await page.goto(url);
  for (const [k, v] of Object.entries(creds)) await page.fill(`[data-field="${k}"] input`, v);
  await page.click("#start");
  await page.waitForFunction(() => /Avatar first frame/.test(document.querySelector("#timeline").textContent), null, { timeout: 30_000 });
  await page.waitForFunction(() => /turns\)/.test(document.querySelector("#latency").textContent), null, { timeout: seconds * 1000 });
  await page.waitForTimeout(2000);
  const report = await page.evaluate(() => ({
    timeline: [...document.querySelectorAll("#timeline dt")].map(dt => `${dt.textContent}: ${dt.nextElementSibling.textContent}`),
    latency: document.querySelector("#latency").textContent,
    transcript: [...document.querySelectorAll("#transcript li")].map(li => `${li.className.split(" ")[0]}: ${li.textContent}`),
  }));
  console.log(report.timeline.join("\n"));
  console.log(report.latency);
  console.log(report.transcript.slice(0, 6).join("\n"));
  await page.screenshot({ path: "test-results/smoke.png" }).catch(() => {});
  await page.click("#stop");
  await page.waitForFunction(() => /^Stopped/.test(document.querySelector("#status").textContent), null, { timeout: 15_000 });
  console.log("status:", await page.textContent("#status"));
} catch (e) {
  failed = true;
  console.error("SMOKE FAILED:", e.message);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run the smoke against real services**

Credentials are read at runtime from the two existing `.env` files and never copied:

```bash
mkdir -p test-results
npm run build
npm start > /tmp/vx-app.log 2>&1 & SRV=$!; sleep 1
E2E_WAV=/tmp/pw-runner/speech-pad.wav node --env-file=$HOME/Dev/Convo/spatius-scenario-demo/backend/.env \
  --env-file=01-agora-player/.env e2e/smoke.mjs
kill $SRV; cat /tmp/vx-app.log
```

Expected: timeline lines including `Avatar first frame` and `Agent audio relayed`, a `Relay + render: last … ms` line, at least one `agent:` transcript line, then `status: Stopped.`; exit code 0. If `/tmp/pw-runner/speech-pad.wav` is missing, the agent's greeting alone still produces a relayed turn. Look at `test-results/smoke.png` to confirm the avatar is rendered.

- [ ] **Step 3: Write `README.md`**

````markdown
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
````

- [ ] **Step 4: Commit**

```bash
git add e2e/smoke.mjs README.md
git commit -m "Add end-to-end smoke test and README

🤖 Built with SMT <smt@agora.build>"
```
