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
