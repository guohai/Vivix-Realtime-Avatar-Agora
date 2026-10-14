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

// Which fields the server fills when left blank (GET /api/defaults). Values never reach the page.
export type Covered = Partial<Record<keyof Credentials, boolean>>;

export function validate(c: Credentials, covered: Covered = {}): Partial<Record<keyof Credentials, string>> {
  const errors: Partial<Record<keyof Credentials, string>> = {};
  for (const f of FIELDS) if (!f.optional && !covered[f.key] && !c[f.key].trim()) errors[f.key] = "Required";
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
