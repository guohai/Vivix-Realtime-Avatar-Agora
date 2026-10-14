// Spike: Agora ConvoAI (pipeline_id) drives a Vivix avatar in passthrough mode.
// One session at a time, like the doc player. Credentials come from the environment.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes, randomInt } from "node:crypto";
import agoraToken from "agora-token";

const { RtcTokenBuilder, RtcRole } = agoraToken;
const env = name => {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Set ${name}`);
  return v;
};
const VIVIX_API_KEY = env("VIVIX_API_KEY");
const AGORA_APP_ID = env("AGORA_APP_ID");
const AGORA_APP_CERTIFICATE = env("AGORA_APP_CERTIFICATE");
const AGORA_PIPELINE_ID = env("AGORA_PIPELINE_ID");
const TTL = 30 * 60;
const AGORA_REST = `https://api.agora.io/api/conversational-ai-agent/v2/projects/${AGORA_APP_ID}`;

const vivixSession = {
  model: "vivix-a1-stream",
  output: { aspect_ratio: "9:16", resolution: "720p" },
  avatars: [{
    avatar_id: "host",
    persona: "A warm, attentive conversation companion. Small smiles and gentle nods; hands rest while listening.",
    visual: { source_images: [{
      source_image_id: "portrait",
      url: "https://static.vivi-x.ai/images/2026/08/03/650665979f5d095f.jpg",
      media_type: "image/jpeg",
    }] },
  }],
  // Vivix 500s (code 50001) on passthrough without a tts voice, though it never speaks with it.
  pipeline_config: { tts_config: { tts_voice_id: "longanhuan_v3.6" }, a2a_config: { enable_a2a: true, provider: "passthrough" } },
  delivery: { media: { transport: "agora" } },
  max_duration_seconds: 1200,
  auto_close: { disconnected_timeout_seconds: 60 },
};

async function vivix(path, body) {
  const res = await fetch(`https://api.vivix.ai/v1/${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${VIVIX_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.code !== 0) throw new Error(`Vivix: ${data.message || `HTTP ${res.status}`}`);
  return data.data;
}

const rtcToken = (channel, uid) => RtcTokenBuilder.buildTokenWithUid(
  AGORA_APP_ID, AGORA_APP_CERTIFICATE, channel, uid, RtcRole.PUBLISHER, TTL, TTL);
// REST auth signed from App ID + certificate, as in spatius-scenario-demo/backend/agora.py.
const agoraAuth = () => `agora token="${RtcTokenBuilder.buildTokenWithUid(
  AGORA_APP_ID, AGORA_APP_CERTIFICATE, "", 1, RtcRole.PUBLISHER, 300, 300)}"`;

async function agora(path, body) {
  const res = await fetch(`${AGORA_REST}/${path}`, {
    method: "POST", headers: { Authorization: agoraAuth(), "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok && !(path.endsWith("/leave") && res.status === 404)) {
    throw new Error(`ConvoAI: ${data?.detail || data?.reason || `HTTP ${res.status}`}`);
  }
  return data;
}

async function joinAgent() {
  const channel = `vivix-${randomBytes(8).toString("hex")}`;
  const userUid = randomInt(100_000, 600_000);
  const agentUid = randomInt(600_000, 800_000);
  const data = await agora("join", {
    name: channel,
    pipeline_id: AGORA_PIPELINE_ID,
    properties: {
      channel,
      token: rtcToken(channel, agentUid),
      agent_rtc_uid: String(agentUid),
      remote_rtc_uids: [String(userUid)],
      idle_timeout: 60,
      turn_detection: { interrupt_mode: "interrupt" },
      parameters: { data_channel: "datastream", enable_error_message: true },
    },
  });
  return { agentId: data.agent_id, appId: AGORA_APP_ID, channel, uid: userUid, token: rtcToken(channel, userUid), agentUid };
}

const timed = async (label, timings, fn) => {
  const t = performance.now();
  try { return await fn(); } finally { timings[label] = Math.round(performance.now() - t); }
};

let current, starting = false;

async function closeAll(s) {
  const results = await Promise.allSettled([
    s.convo && agora(`agents/${s.convo.agentId}/leave`),
    s.vivix && vivix(`realtime-avatar/sessions/${encodeURIComponent(s.vivix.session_id)}/close`, {}),
  ]);
  const failed = results.filter(r => r.status === "rejected").map(r => r.reason.message);
  if (failed.length) throw new Error(failed.join("; "));
}

http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/session") {
      if (starting || current) { res.writeHead(409); return res.end("Close the current session first"); }
      starting = true;
      try {
        const timings = {};
        const [v, c] = await Promise.allSettled([
          timed("vivixCreateMs", timings, () => vivix("realtime-avatar/sessions", vivixSession)),
          timed("convoJoinMs", timings, joinAgent),
        ]);
        if (v.status === "rejected" || c.status === "rejected") {
          await closeAll({ vivix: v.value, convo: c.value }).catch(() => {});
          throw (v.reason || c.reason);
        }
        current = { vivix: v.value, convo: c.value };
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ ...current, timings }));
      } finally { starting = false; }
    }
    if (req.method === "POST" && req.url === "/close") {
      if (current) { await closeAll(current); current = undefined; }
      return res.end("Session closure requested");
    }
    if (req.method === "POST" && req.url === "/interrupt") {
      if (current) await agora(`agents/${current.convo.agentId}/interrupt`, {});
      return res.end("ok");
    }
    const files = { "/": ["index.html", "text/html"], "/app.js": ["app.js", "text/javascript"] };
    const file = req.method === "GET" && files[req.url];
    if (!file) { res.writeHead(404); return res.end(); }
    res.setHeader("Content-Type", file[1]);
    res.end(await readFile(file[0]));
  } catch (e) { res.writeHead(500); res.end(String(e.message)); }
}).listen(Number(process.env.PORT) || 3000, "127.0.0.1", function () { console.log(`http://localhost:${this.address().port}`); });
