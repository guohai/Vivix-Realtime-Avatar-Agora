// Startup timeline and per-turn relay + render latency: from the moment the agent's TTS audio
// becomes audible to the moment the avatar's audio does, sampled from track volume levels.
export class Timeline {
  private start = 0;
  readonly entries: { label: string; ms: number }[] = [];
  constructor(private now: () => number = () => performance.now()) {}
  reset(): void { this.start = this.now(); this.entries.length = 0; }
  mark(label: string): number {
    const ms = Math.round(this.now() - this.start);
    this.entries.push({ label, ms });
    return ms;
  }
}

type State = { kind: "idle" } | { kind: "waiting"; onset: number } | { kind: "speaking"; quietSince: number | null };

export class OnsetTracker {
  private state: State = { kind: "idle" };
  private threshold: number; private quiet: number; private quietMs: number; private giveUpMs: number;
  constructor({ threshold = 0.05, quiet = 0.01, quietMs = 600, giveUpMs = 8000 } = {}) {
    this.threshold = threshold; this.quiet = quiet; this.quietMs = quietMs; this.giveUpMs = giveUpMs;
  }

  sample(agent: number, avatar: number, now: number): number | null {
    const s = this.state;
    if (s.kind === "idle") {
      if (agent > this.threshold) this.state = { kind: "waiting", onset: now };
      return null;
    }
    if (s.kind === "waiting") {
      if (avatar > this.threshold) { this.state = { kind: "speaking", quietSince: null }; return Math.round(now - s.onset); }
      if (now - s.onset > this.giveUpMs) this.state = { kind: "idle" };
      return null;
    }
    const silent = agent < this.quiet && avatar < this.quiet;
    if (!silent) s.quietSince = null;
    else if (s.quietSince === null) s.quietSince = now;
    else if (now - s.quietSince >= this.quietMs) this.state = { kind: "idle" };
    return null;
  }
}


/** One spoken turn's timings, reported when the avatar starts speaking it. */
export interface TurnTiming {
  /** Agent audio from Agora → avatar audio and video from Vivix. */
  renderMs: number;
  /** Agora's end-to-end delay of the avatar video, Vivix → this browser. */
  videoNetworkMs: number | null;
}

