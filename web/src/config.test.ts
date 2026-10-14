import { describe, it, expect } from "vitest";
import { loadCredentials, saveCredentials, validate, toSessionBody, STORAGE_KEY, type Credentials } from "./config";

const HEX = "0123456789abcdef0123456789abcdef";
const full: Credentials = { agoraAppId: HEX, agoraCertificate: HEX, pipelineId: "p", persona: "", vivixApiKey: "vk", imageUrl: "" };
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
};

describe("credential storage", () => {
  it("round-trips when remembered and forgets otherwise", () => {
    const s = memory();
    saveCredentials(s, full, true);
    expect(loadCredentials(s)).toEqual({ creds: full, remembered: true });
    saveCredentials(s, full, false);
    expect(s.m.has(STORAGE_KEY)).toBe(false);
    expect(loadCredentials(s).remembered).toBe(false);
  });

  it("ignores corrupt or partial storage", () => {
    const s = memory();
    s.setItem(STORAGE_KEY, "{not json");
    expect(loadCredentials(s).creds.agoraAppId).toBe("");
    s.setItem(STORAGE_KEY, JSON.stringify({ agoraAppId: HEX, extra: 1 }));
    expect(loadCredentials(s).creds).toEqual({ ...full, agoraCertificate: "", pipelineId: "", vivixApiKey: "", agoraAppId: HEX });
  });
});

describe("validate", () => {
  it("accepts a complete set", () => expect(validate(full)).toEqual({}));
  it("flags each problem by field", () => {
    expect(validate({ ...full, agoraAppId: "xyz", vivixApiKey: " ", imageUrl: "http://a/b.jpg" })).toEqual({
      agoraAppId: "32 hex characters", vivixApiKey: "Required", imageUrl: "Must be an https URL" });
  });
});

describe("toSessionBody", () => {
  it("trims and omits empty optionals", () => {
    expect(toSessionBody({ ...full, pipelineId: " p ", persona: "  " })).toEqual({
      agora: { appId: HEX, certificate: HEX, pipelineId: "p" }, vivix: { apiKey: "vk" } });
    expect(toSessionBody({ ...full, persona: "Be brief", imageUrl: "https://a/b.png" })).toEqual({
      agora: { appId: HEX, certificate: HEX, pipelineId: "p", persona: "Be brief" }, vivix: { apiKey: "vk", imageUrl: "https://a/b.png" } });
  });
});

describe("validate with server defaults", () => {
  it("does not require fields the server covers, but still checks typed ones", () => {
    const blank: Credentials = { ...full, agoraAppId: "", agoraCertificate: "", pipelineId: "", vivixApiKey: "" };
    const all = { agoraAppId: true, agoraCertificate: true, pipelineId: true, vivixApiKey: true };
    expect(validate(blank, all)).toEqual({});
    expect(validate({ ...blank, agoraAppId: "xyz" }, all)).toEqual({ agoraAppId: "32 hex characters" });
    expect(validate(blank, { vivixApiKey: true })).toEqual({ agoraAppId: "Required", agoraCertificate: "Required", pipelineId: "Required" });
  });
});
