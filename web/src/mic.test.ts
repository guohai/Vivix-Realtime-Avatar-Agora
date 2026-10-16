import { describe, it, expect } from "vitest";
import { micOptions, labelsHidden, MIC_STORAGE_KEY } from "./mic";

const dev = (deviceId: string, label: string) => ({ deviceId, label });

describe("micOptions", () => {
  it("lists the system default first, then each device, keeping the saved choice", () => {
    expect(micOptions([dev("default", "Default - Headset"), dev("a", "Headset"), dev("b", "USB Mic")], "b")).toEqual({
      options: [{ id: "", label: "System default" }, { id: "a", label: "Headset" }, { id: "b", label: "USB Mic" }],
      selected: "b",
    });
  });

  it("falls back to the system default when the saved device is gone", () => {
    expect(micOptions([dev("a", "Headset")], "unplugged").selected).toBe("");
  });

  it("names unlabelled devices and drops entries without an id", () => {
    expect(micOptions([dev("", ""), dev("a", ""), dev("b", "")], "").options).toEqual([
      { id: "", label: "System default" }, { id: "a", label: "Microphone 1" }, { id: "b", label: "Microphone 2" }]);
  });

  it("drops Chrome's 'communications' alias alongside 'default'", () => {
    expect(micOptions([dev("communications", "Communications - X"), dev("a", "X")], "").options.map(o => o.id)).toEqual(["", "a"]);
  });
});

describe("labelsHidden", () => {
  it("is true before mic permission (no labels), false after", () => {
    expect(labelsHidden([dev("", "")])).toBe(true);
    expect(labelsHidden([])).toBe(true);
    expect(labelsHidden([dev("a", "Headset")])).toBe(false);
  });
});

it("uses a namespaced storage key", () => expect(MIC_STORAGE_KEY).toBe("vivix-convoai-demo.microphone"));
