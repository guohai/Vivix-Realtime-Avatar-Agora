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
