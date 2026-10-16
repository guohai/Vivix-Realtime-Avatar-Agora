import { describe, it, expect } from "vitest";
import { Timeline, OnsetTracker } from "./metrics";

describe("Timeline", () => {
  it("records ms since reset", () => {
    let t = 1000;
    const tl = new Timeline(() => t);
    tl.reset();
    t = 1250; expect(tl.mark("a")).toBe(250);
    t = 1900; tl.mark("b");
    expect(tl.entries).toEqual([{ label: "a", ms: 250 }, { label: "b", ms: 900 }]);
    tl.reset();
    expect(tl.entries).toEqual([]);
  });
});

describe("OnsetTracker", () => {
  it("reports agent→avatar onset once per turn, then re-arms after quiet", () => {
    const o = new OnsetTracker({ threshold: 0.05, quiet: 0.01, quietMs: 600 });
    expect(o.sample(0, 0, 0)).toBeNull();
    expect(o.sample(0.3, 0, 100)).toBeNull();      // agent starts
    expect(o.sample(0.4, 0.02, 1000)).toBeNull();  // avatar below threshold
    expect(o.sample(0.4, 0.2, 2350)).toBe(2250);   // avatar starts
    expect(o.sample(0.4, 0.3, 2400)).toBeNull();   // same turn: no repeat
    expect(o.sample(0, 0, 5000)).toBeNull();       // quiet begins
    expect(o.sample(0, 0, 5700)).toBeNull();       // quiet long enough → idle
    expect(o.sample(0.2, 0, 6000)).toBeNull();     // next turn
    expect(o.sample(0.2, 0.1, 8500)).toBe(2500);
  });

  it("does not re-arm on a short pause between words", () => {
    const o = new OnsetTracker({ quietMs: 600 });
    o.sample(0.3, 0, 0);
    expect(o.sample(0.3, 0.3, 2000)).toBe(2000);
    o.sample(0, 0, 2100);
    o.sample(0.3, 0.3, 2300);                      // speech resumes before 600 ms of quiet
    expect(o.sample(0.3, 0.3, 2400)).toBeNull();
  });

  it("gives up when the avatar never speaks", () => {
    const o = new OnsetTracker({ giveUpMs: 8000 });
    o.sample(0.3, 0, 0);
    expect(o.sample(0.3, 0, 9000)).toBeNull();     // abandoned
    expect(o.sample(0.3, 0, 9100)).toBeNull();     // new onset
    expect(o.sample(0.3, 0.2, 10100)).toBe(1000);
  });
});


