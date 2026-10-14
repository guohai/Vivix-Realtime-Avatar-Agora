// Channel B — provisioned by Vivix. We subscribe only to the avatar publisher and keep the
// control WebSocket open; Vivix's auto_close counts that connection, not RTC presence.
import AgoraRTC, { type IAgoraRTCClient, type IRemoteAudioTrack } from "agora-rtc-sdk-ng";
import type { VivixSession } from "./api";

export interface AvatarHandlers {
  firstFrame(): void;
  audio(track: IRemoteAudioTrack): void;
  autoplayBlocked(): void;
  controlLost(): void;
  error(message: string): void;
}

export interface AvatarLink { client: IAgoraRTCClient; ws: WebSocket; close(): Promise<void> }

const CONTROL_TIMEOUT_MS = 15_000;
const asUid = (v: string) => (/^\d+$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : v);

// Returns the socket immediately so callers can always close it, even if it opens later.
function openControl(control: VivixSession["control"], lost: () => void): { ws: WebSocket; ready: Promise<void> } {
  const url = new URL(control.url);
  url.searchParams.set("token", control.clientSecret);
  const ws = new WebSocket(url);
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error("Vivix control connection timed out")); }, CONTROL_TIMEOUT_MS);
    ws.onopen = () => {
      clearTimeout(timer);
      ws.onclose = ws.onerror = () => lost();
      resolve();
    };
    ws.onerror = ws.onclose = () => { clearTimeout(timer); reject(new Error("Vivix control connection failed")); };
  });
  return { ws, ready };
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// `onJoined` fires as soon as the channel-B RTC join completes (publishing needs only that);
// the returned promise additionally waits for the control socket and rejects if it fails.
export async function joinAvatar(
  s: VivixSession, videoEl: HTMLElement, h: AvatarHandlers, onJoined?: (client: IAgoraRTCClient) => void,
): Promise<AvatarLink> {
  const m = s.media;
  const client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
  AgoraRTC.onAutoplayFailed = () => h.autoplayBlocked();

  client.on("user-published", async (user, type) => {
    if (String(user.uid) !== m.publisherUid) return;
    try {
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
    } catch (e) {
      h.error(`Could not subscribe to the avatar's ${type}: ${errMsg(e)}`);
    }
  });

  let closing = false;
  const { ws, ready } = openControl(s.control, () => { if (!closing) h.controlLost(); });
  const [control, joined] = await Promise.allSettled([
    ready,
    client.join(m.appId, m.channel, m.token || null, asUid(m.uid)).then(r => { onJoined?.(client); return r; }),
  ]);
  if (control.status === "rejected" || joined.status === "rejected") {
    closing = true;
    ws.close();
    AgoraRTC.onAutoplayFailed = undefined;
    if (joined.status === "fulfilled") await client.leave().catch(() => {});
    client.removeAllListeners();
    throw control.status === "rejected" ? control.reason : (joined as PromiseRejectedResult).reason;
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
