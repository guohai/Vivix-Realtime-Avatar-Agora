// Start: mic capture and POST /api/session run in parallel; then channel A, channel B and the
// Vivix control socket are joined in parallel. Stop tears down locally, then closes upstream.
import AgoraRTC, { type IAgoraRTCClient, type IMicrophoneAudioTrack, type IRemoteAudioTrack } from "agora-rtc-sdk-ng";
import { startSession, stopSession, interruptAgent, beaconStop, type StartResponse, type StopBody } from "./api";
import { toSessionBody, type Credentials } from "./config";
import { joinConvo } from "./convo";
import { joinAvatar, type AvatarLink } from "./avatar";
import { startRelay, type Relay } from "./relay";
import { applyMessage, visibleLines, TurnRevealer, type Line } from "./transcript";
import { Timeline, OnsetTracker, type TurnTiming } from "./metrics";

export interface SessionEvents {
  status(text: string): void;
  mark(label: string, ms: number): void;
  latency(turn: TurnTiming): void;
  transcript(lines: Line[]): void;
  autoplayBlocked(): void;
  ended(reason: string): void;
}

export class CancelledError extends Error {
  constructor() { super("Cancelled"); this.name = "CancelledError"; }
}

AgoraRTC.setLogLevel(3); // warnings and errors only

const REVEAL_FALLBACK_MS = 8000;

export class Session {
  private started?: StartResponse;
  private convo?: IAgoraRTCClient;
  private avatar?: AvatarLink;
  private mic?: IMicrophoneAudioTrack;
  private relay?: Relay;
  private relayChain: Promise<void> = Promise.resolve();
  private agentAudio?: IRemoteAudioTrack;
  private avatarAudio?: IRemoteAudioTrack;
  private lines: Line[] = [];
  // Agent turns whose text may be shown: revealed when the avatar starts speaking, or after
  // REVEAL_FALLBACK_MS if it never does (interrupted, or the avatar failed).
  private revealer = new TurnRevealer();
  private revealTimers = new Map<number, number>();
  private sampler?: number;
  private timeline = new Timeline();
  private onset = new OnsetTracker();
  private stopping = false;
  private stopSent = false;
  private wantMuted = false;
  private micId = ""; // "" = system default

  constructor(private creds: Credentials, private videoEl: HTMLElement, private ev: SessionEvents) {}

  get active(): boolean { return !!this.started && !this.stopping; }

  private mark(label: string) { this.ev.mark(label, this.timeline.mark(label)); }

  private check() { if (this.stopping) throw new CancelledError(); }

  async start(): Promise<void> {
    try { await this.run(); }
    catch (err) {
      // Once Stop has been pressed any failure (e.g. the POST or publish dying because of the
      // teardown) is just the cancellation, and must not be reported as a start failure.
      const e = this.stopping && !(err instanceof CancelledError) ? new CancelledError() : err;
      if (e instanceof CancelledError) {
        // stop() ran while we were starting: tear down whatever got created since, and close
        // upstream with IDs that only arrived after stop() had none.
        const body = this.stopSent ? null : this.stopBody();
        if (body) this.stopSent = true;
        const [, up] = await Promise.allSettled([this.teardownLocal(), body ? stopSession(body) : undefined]);
        if (up.status === "rejected") this.ev.status(`Upstream close failed: ${(up.reason as Error).message}`);
      }
      throw e;
    }
  }

  private async run(): Promise<void> {
    this.timeline.reset();
    this.ev.status("Starting…");
    const micReady = AgoraRTC.createMicrophoneAudioTrack({ AEC: true, ANS: true, AGC: true, ...(this.micId ? { microphoneId: this.micId } : {}) });
    // A mic granted after Stop is closed the moment it arrives; never awaited by stop().
    micReady.then(t => { this.mic = t; if (this.stopping) t.close(); }, () => {});
    const s = await startSession(toSessionBody(this.creds));
    this.started = s;
    this.check();
    // Every entry is time since Start; the two server calls ran in parallel inside this one.
    this.mark(`Sessions created (Vivix ${s.timings.vivixCreateMs} ms ‖ ConvoAI ${s.timings.convoJoinMs} ms)`);

    // Channel B's RTC join is all publishing needs; avatarJoin also waits for the control socket.
    let rtcJoined!: (c: IAgoraRTCClient) => void;
    const clientB = new Promise<IAgoraRTCClient>(resolve => { rtcJoined = resolve; });
    const avatarJoin = joinAvatar(s.vivix, this.videoEl, {
      firstFrame: () => { this.mark("Avatar first frame"); this.ev.status("Live — speak to the avatar."); },
      audio: track => { this.avatarAudio = track; },
      autoplayBlocked: () => this.ev.autoplayBlocked(),
      controlLost: () => { if (!this.stopping) this.ev.ended("Vivix control connection closed."); },
      error: m => this.ev.status(m),
    }, rtcJoined).then(a => { this.avatar = a; this.mark("Joined Vivix channel"); return a; });

    const convoJoin =
      joinConvo(s.convo, {
        agentJoined: () => this.mark("Agent joined"),
        agentLeft: () => { if (!this.stopping) this.ev.ended("The agent left the channel (idle timeout or error)."); },
        agentAudio: track => {
          this.agentAudio = track;
          // Relay once channel B's RTC join completes; chained so a republish replaces the old relay in order.
          this.relayChain = this.relayChain.then(async () => {
            const client = await clientB;
            if (this.stopping) return;
            await this.relay?.close();
            const relay = await startRelay(track, client);
            if (this.stopping) { await relay.close().catch(() => {}); return; }
            this.relay = relay;
            this.mark("Relay to Vivix ready");
          }).catch(e => { if (!this.stopping) this.ev.status(`Relay failed: ${e.message}`); });
        },
        message: msg => {
          this.lines = applyMessage(this.lines, msg);
          const turn = msg.turn_id ?? -1;
          if (msg.object === "assistant.transcription" && this.revealer.agentTurn(turn)) {
            this.revealTimers.set(turn, window.setTimeout(() => this.reveal(turn), REVEAL_FALLBACK_MS));
          }
          this.showTranscript();
        },
        error: m => this.ev.status(m),
      }).then(c => { this.convo = c; this.mark("Joined ConvoAI channel"); return c; });
    let convo: IAgoraRTCClient;
    try { [convo] = await Promise.all([convoJoin, avatarJoin]); }
    catch (e) { await Promise.allSettled([convoJoin, avatarJoin]); throw e; } // so teardown can close whichever joined
    this.check();

    let mic: IMicrophoneAudioTrack;
    try { mic = await micReady; }
    catch (e) { this.check(); throw new Error(`Microphone unavailable: ${(e as Error).message}`); }
    this.mic = mic;
    if (this.stopping) { mic.close(); throw new CancelledError(); }
    if (this.wantMuted) await mic.setMuted(true);
    this.check();
    await convo.publish(mic);
    this.check();
    this.mark("Mic live");

    this.sampler = window.setInterval(() => {
      const now = performance.now();
      const ms = this.onset.sample(this.agentAudio?.getVolumeLevel() ?? 0, this.avatarAudio?.getVolumeLevel() ?? 0, now);
      if (ms !== null) {
        this.ev.latency({
          renderMs: ms,
          videoNetworkMs: this.avatar?.videoDelayMs() ?? null,
        });
        // The avatar just started speaking: its text may show now.
        this.revealer.avatarStarted();
        this.showTranscript();
      }
    }, 50);
  }

  private reveal(turn: number) {
    this.revealer.force(turn);
    this.showTranscript();
  }

  private showTranscript() {
    if (!this.stopping) this.ev.transcript(visibleLines(this.lines, this.revealer.revealed));
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

  // Idempotent, safe from any point: each resource is taken (cleared) before it is closed.
  private async teardownLocal(): Promise<void> {
    window.clearInterval(this.sampler);
    this.sampler = undefined;
    for (const t of this.revealTimers.values()) window.clearTimeout(t);
    this.revealTimers.clear();
    const relay = this.relay, mic = this.mic, convo = this.convo, avatar = this.avatar;
    this.relay = this.mic = this.convo = this.avatar = undefined;
    const attempt = async (f: () => unknown) => { try { await f(); } catch { /* best effort */ } };
    await Promise.all([
      attempt(() => relay?.close()),
      attempt(() => mic?.close()),
      attempt(() => convo?.leave()),
      attempt(() => avatar?.close()),
    ]);
    convo?.removeAllListeners();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const body = this.stopSent ? null : this.stopBody();
    if (body) this.stopSent = true;
    // Upstream close never waits on local teardown.
    const [, up] = await Promise.allSettled([this.teardownLocal(), body ? stopSession(body) : undefined]);
    if (up.status === "rejected") { this.stopSent = false; throw up.reason; } // allow a retry
  }

  stopOnUnload(): void {
    const body = this.stopBody();
    if (body && !this.stopping) { this.stopping = true; this.stopSent = true; beaconStop(body); }
  }

  async interrupt(): Promise<void> {
    if (!this.started) return;
    await interruptAgent({
      agora: { appId: this.creds.agoraAppId.trim(), certificate: this.creds.agoraCertificate.trim() },
      agentId: this.started.convo.agentId,
    });
  }

  async setMuted(muted: boolean): Promise<void> { this.wantMuted = muted; await this.mic?.setMuted(muted); }

  /** Picks the microphone: used when the mic is created, or switched live if it already is. */
  async setMicrophone(id: string): Promise<void> {
    this.micId = id;
    await this.mic?.setDevice(id || "default");
  }

  resumeAudio(): void { this.avatarAudio?.play(); }
}
