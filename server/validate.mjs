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
