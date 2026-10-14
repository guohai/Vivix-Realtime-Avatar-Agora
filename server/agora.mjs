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

const restToken = creds => rtcToken(creds, "", 1, REST_TOKEN_TTL_SECONDS);

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
    turn_detection: {
      config: {
        start_of_speech: { mode: "vad", vad_config: { interrupt_duration_ms: 160, prefix_padding_ms: 800 } },
        // Semantic end of turn: 320 ms of silence instead of VAD's 640 ms (English and Chinese;
        // other languages fall back to VAD).
        end_of_speech: { mode: "semantic", semantic_config: { silence_duration_ms: 320, max_wait_ms: 3000 } },
      },
    },
    // Transcripts over the RTC datastream, so the browser needs no RTM SDK.
    parameters: { data_channel: "datastream", enable_error_message: true },
  };
  // In pipeline mode `llm` is an optional override: system_messages alone leaves the
  // agent's model and params as published.
  if (persona?.trim()) properties.llm = { system_messages: [{ role: "system", content: persona.trim() }] };
  return { name: ids.channel, pipeline_id: pipelineId, properties };
}

// Upstream errors may echo anything we sent, so every derived token is redacted too.
const call = (creds, path, body, fetchImpl, okStatuses, derivedSecrets = []) => {
  const token = restToken(creds);
  return postJson(`${CONVOAI_API}/projects/${creds.appId}/${path}`, {
    service: "ConvoAI", headers: { Authorization: `agora token="${token}"` }, body,
    secrets: [creds.certificate, token, ...derivedSecrets], fetchImpl, okStatuses,
  });
};

export async function joinAgent({ appId, certificate, pipelineId, persona }, fetchImpl = fetch) {
  const creds = { appId, certificate };
  const ids = mintIdentities(creds);
  const { data } = await call(creds, "join", buildJoinBody({ pipelineId, persona }, ids), fetchImpl, [], [ids.agentToken, ids.userToken]);
  if (typeof data?.agent_id !== "string" || !data.agent_id) throw new Error("ConvoAI: no agent id returned");
  return { agentId: data.agent_id, appId, channel: ids.channel, uid: ids.userUid, token: ids.userToken, agentUid: ids.agentUid };
}

export async function leaveAgent({ appId, certificate, agentId }, fetchImpl = fetch) {
  await call({ appId, certificate }, `agents/${encodeURIComponent(agentId)}/leave`, {}, fetchImpl, [404]);
}

export async function interruptAgent({ appId, certificate, agentId }, fetchImpl = fetch) {
  await call({ appId, certificate }, `agents/${encodeURIComponent(agentId)}/interrupt`, {}, fetchImpl);
}
