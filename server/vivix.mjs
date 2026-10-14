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
  if (!d?.session_id || !d.control?.url || !m) {
    // The session exists upstream but is unusable: close it so it is not left running.
    if (d?.session_id) await closeSession({ apiKey, sessionId: d.session_id }, fetchImpl).catch(() => {});
    throw new UpstreamError("Vivix", "session has no Agora media details", 502);
  }
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
