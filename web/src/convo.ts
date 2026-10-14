// Channel A — the customer's Agora project. We publish the mic and take the agent's TTS track,
// which is relayed, never played: the avatar's audio is the only thing the user hears.
import AgoraRTC, { type IAgoraRTCClient, type IRemoteAudioTrack } from "agora-rtc-sdk-ng";
import type { ConvoSession } from "./api";
import { createAssembler, type ConvoMessage } from "./transcript";

export interface ConvoHandlers {
  agentJoined(): void;
  agentAudio(track: IRemoteAudioTrack): void;
  agentLeft(): void;
  message(msg: ConvoMessage): void;
  error(message: string): void;
}

export async function joinConvo(s: ConvoSession, h: ConvoHandlers): Promise<IAgoraRTCClient> {
  const client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
  const isAgent = (uid: unknown) => String(uid) === String(s.agentUid);
  const assemble = createAssembler();

  client.on("user-joined", u => { if (isAgent(u.uid)) h.agentJoined(); });
  client.on("user-left", u => { if (isAgent(u.uid)) h.agentLeft(); });
  client.on("user-published", async (user, type) => {
    if (!isAgent(user.uid) || type !== "audio") return;
    try {
      await client.subscribe(user, "audio");
      if (user.audioTrack) h.agentAudio(user.audioTrack);
    } catch (e) {
      h.error(`Could not subscribe to the agent's audio: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  client.on("stream-message", (uid, data) => {
    if (!isAgent(uid)) return;
    const msg = assemble(data);
    if (msg) h.message(msg);
  });

  await client.join(s.appId, s.channel, s.token, s.uid);
  return client;
}
