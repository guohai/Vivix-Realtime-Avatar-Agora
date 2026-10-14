// Republish the agent's decoded TTS track into the Vivix channel unchanged. Vivix's listener
// subscribes to it and renders the avatar from it (pure rendering / passthrough mode).
import AgoraRTC, { type IAgoraRTCClient, type IRemoteAudioTrack } from "agora-rtc-sdk-ng";

export interface Relay { close(): Promise<void> }

export async function startRelay(agentTrack: IRemoteAudioTrack, target: IAgoraRTCClient): Promise<Relay> {
  const source = agentTrack.getMediaStreamTrack();
  // Chrome only pulls audio through a remote WebRTC track that has a sink; a muted element is
  // enough and keeps the agent inaudible.
  const sink = new Audio();
  sink.muted = true;
  sink.srcObject = new MediaStream([source]);
  sink.play().catch(() => {});

  const track = AgoraRTC.createCustomAudioTrack({ mediaStreamTrack: source });
  await target.publish(track);
  return {
    async close() {
      try { await target.unpublish(track); } catch { /* channel already left */ }
      track.close();
      sink.srcObject = null;
    },
  };
}
