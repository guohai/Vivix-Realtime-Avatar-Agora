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
