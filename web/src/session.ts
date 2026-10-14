// Start: mic capture and POST /api/session run in parallel; then channel A, channel B and the
// Vivix control socket are joined in parallel. Stop tears down locally, then closes upstream.
import AgoraRTC, { type IAgoraRTCClient, type IMicrophoneAudioTrack, type IRemoteAudioTrack } from "agora-rtc-sdk-ng";
import { startSession, stopSession, interruptAgent, beaconStop, type StartResponse, type StopBody } from "./api";
import { toSessionBody, type Credentials } from "./config";
import { joinConvo } from "./convo";
import { joinAvatar, type AvatarLink } from "./avatar";
import { startRelay, type Relay } from "./relay";
import { applyMessage, type Line } from "./transcript";
import { Timeline, OnsetTracker } from "./metrics";

export interface SessionEvents {
  status(text: string): void;
  mark(label: string, ms: number): void;
  latency(ms: number): void;
  transcript(lines: Line[]): void;
  autoplayBlocked(): void;
  ended(reason: string): void;
}

AgoraRTC.setLogLevel(3); // warnings and errors only

export class Session {
  private started?: StartResponse;
  private convo?: IAgoraRTCClient;
  private avatar?: AvatarLink;
  private mic?: IMicrophoneAudioTrack;
  private micPending?: Promise<IMicrophoneAudioTrack>;
  private relay?: Relay;
  private relayChain: Promise<void> = Promise.resolve();
  private agentAudio?: IRemoteAudioTrack;
  private avatarAudio?: IRemoteAudioTrack;
  private lines: Line[] = [];
  private sampler?: number;
  private timeline = new Timeline();
  private onset = new OnsetTracker();
  private stopping = false;

  constructor(private creds: Credentials, private videoEl: HTMLElement, private ev: SessionEvents) {}

  get active(): boolean { return !!this.started && !this.stopping; }

  private mark(label: string) { this.ev.mark(label, this.timeline.mark(label)); }

  async start(): Promise<void> {
    this.timeline.reset();
    this.ev.status("Starting…");
    const micReady = AgoraRTC.createMicrophoneAudioTrack({ AEC: true, ANS: true, AGC: true });
    micReady.catch(() => {}); // surfaced below; avoid an unhandled rejection if the session fails first
    this.micPending = micReady; // stop() closes it even when start fails part-way
    const s = await startSession(toSessionBody(this.creds));
    this.started = s;
    this.ev.mark("Vivix session created", s.timings.vivixCreateMs);
    this.ev.mark("ConvoAI agent started", s.timings.convoJoinMs);
    this.mark("Sessions ready");

    const avatarJoin = joinAvatar(s.vivix, this.videoEl, {
      firstFrame: () => { this.mark("Avatar first frame"); this.ev.status("Live — speak to the avatar."); },
      audio: track => { this.avatarAudio = track; },
      autoplayBlocked: () => this.ev.autoplayBlocked(),
      controlLost: () => { if (!this.stopping) this.ev.ended("Vivix control connection closed."); },
      error: m => this.ev.status(m),
    }).then(a => { this.avatar = a; this.mark("Joined Vivix channel"); return a; });

    const convoJoin =
      joinConvo(s.convo, {
        agentJoined: () => this.mark("Agent joined"),
        agentLeft: () => { if (!this.stopping) this.ev.ended("The agent left the channel (idle timeout or error)."); },
        agentAudio: track => {
          this.agentAudio = track;
          // Relay once channel B is joined; chained so a republish replaces the old relay in order.
          this.relayChain = this.relayChain.then(async () => {
            const link = await avatarJoin;
            await this.relay?.close();
            this.relay = await startRelay(track, link.client);
            this.mark("Agent audio relayed");
          }).catch(e => this.ev.status(`Relay failed: ${e.message}`));
        },
        message: msg => { this.lines = applyMessage(this.lines, msg); this.ev.transcript(this.lines); },
        error: m => this.ev.status(m),
      }).then(c => { this.convo = c; this.mark("Joined ConvoAI channel"); return c; });
    let convo: IAgoraRTCClient;
    try { [convo] = await Promise.all([convoJoin, avatarJoin]); }
    catch (e) { await Promise.allSettled([convoJoin, avatarJoin]); throw e; } // so stop() can close whichever joined

    try { this.mic = await micReady; }
    catch (e) { throw new Error(`Microphone unavailable: ${(e as Error).message}`); }
    await convo.publish(this.mic);
    this.mark("Mic live");

    this.sampler = window.setInterval(() => {
      const ms = this.onset.sample(this.agentAudio?.getVolumeLevel() ?? 0, this.avatarAudio?.getVolumeLevel() ?? 0, performance.now());
      if (ms !== null) this.ev.latency(ms);
    }, 50);
  }

  private stopBody(): StopBody | null {
    if (!this.started) return null;
    return {
      agora: { appId: this.creds.agoraAppId.trim(), certificate: this.creds.agoraCertificate.trim() },
      vivix: { apiKey: this.creds.vivixApiKey.trim() },
      agentId: this.started.convo.agentId,
      vivixSessionId: this.started.vivix.sessionId,
    };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    window.clearInterval(this.sampler);
    await this.relayChain;
    await Promise.allSettled([this.relay?.close()]);
    try { (this.mic ?? (await this.micPending?.catch(() => undefined)))?.close(); } catch { /* keep going to stopSession */ }
    await Promise.allSettled([this.convo?.leave(), this.avatar?.close()]);
    this.convo?.removeAllListeners();
    const body = this.stopBody();
    if (body) await stopSession(body);
    this.started = undefined;
  }

  stopOnUnload(): void {
    const body = this.stopBody();
    if (body && !this.stopping) { this.stopping = true; beaconStop(body); }
  }

  async interrupt(): Promise<void> {
    if (!this.started) return;
    await interruptAgent({
      agora: { appId: this.creds.agoraAppId.trim(), certificate: this.creds.agoraCertificate.trim() },
      agentId: this.started.convo.agentId,
    });
  }

  async setMuted(muted: boolean): Promise<void> { await this.mic?.setMuted(muted); }

  resumeAudio(): void { this.avatarAudio?.play(); }
}
