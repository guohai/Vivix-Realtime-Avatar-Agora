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
