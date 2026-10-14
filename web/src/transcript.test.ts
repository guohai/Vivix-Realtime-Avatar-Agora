import { describe, it, expect } from "vitest";
import { createAssembler, applyMessage, type Line } from "./transcript";

const enc = (s: string) => new TextEncoder().encode(s);
const b64 = (obj: unknown) => {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  return btoa(String.fromCharCode(...bytes));
};

describe("createAssembler", () => {
  it("decodes a single-part message, including UTF-8", () => {
    const next = createAssembler();
    expect(next(enc(`m1|1|1|${b64({ object: "user.transcription", text: "你好 café", final: true, turn_id: 1 })}`)))
      .toEqual({ object: "user.transcription", text: "你好 café", final: true, turn_id: 1 });
  });

  it("reassembles parts that arrive out of order", () => {
    const next = createAssembler();
    const whole = b64({ object: "assistant.transcription", text: "Hello there", turn_id: 2, turn_status: 1 });
    const [a, b, c] = [whole.slice(0, 5), whole.slice(5, 11), whole.slice(11)];
    expect(next(enc(`m2|3|3|${c}`))).toBeNull();
    expect(next(enc(`m2|1|3|${a}`))).toBeNull();
    expect(next(enc(`m2|2|3|${b}`))?.text).toBe("Hello there");
  });

  it("ignores malformed chunks", () => {
    const next = createAssembler();
    expect(next(enc("garbage"))).toBeNull();
    expect(next(enc("m3|1|1|!!!notbase64"))).toBeNull();
  });
});

describe("applyMessage", () => {
  it("upserts partial then final lines per role and turn", () => {
    let lines: Line[] = [];
    lines = applyMessage(lines, { object: "user.transcription", text: "Hi th", final: false, turn_id: 1 });
    lines = applyMessage(lines, { object: "user.transcription", text: "Hi there", final: true, turn_id: 1 });
    lines = applyMessage(lines, { object: "assistant.transcription", text: "Hello", turn_id: 1, turn_status: 0 });
    lines = applyMessage(lines, { object: "assistant.transcription", text: "Hello!", turn_id: 1, turn_status: 1 });
    expect(lines).toEqual([
      { role: "user", turnId: 1, text: "Hi there", final: true },
      { role: "agent", turnId: 1, text: "Hello!", final: true },
    ]);
  });

  it("marks interrupted agent turns final and ignores other objects", () => {
    let lines = applyMessage([], { object: "assistant.transcription", text: "Cut", turn_id: 4, turn_status: 2 });
    expect(lines[0].final).toBe(true);
    lines = applyMessage(lines, { object: "message.metrics", text: "x" });
    expect(lines).toHaveLength(1);
  });
});
