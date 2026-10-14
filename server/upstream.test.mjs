import { describe, it, expect } from "vitest";
import { redact, postJson, UpstreamError } from "./upstream.mjs";

const fakeFetch = (status, payload) => {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status });
  };
  impl.calls = calls;
  return impl;
};

describe("redact", () => {
  it("replaces every occurrence of every secret", () => {
    expect(redact("key sk-1 and sk-1 and cert abc", ["sk-1", "abc", ""])).toBe(
      "key <redacted> and <redacted> and cert <redacted>");
  });
});

describe("postJson", () => {
  it("returns status and parsed data on success", async () => {
    const f = fakeFetch(200, { ok: 1 });
    const r = await postJson("https://x/y", { service: "X", body: { a: 1 }, headers: { h: "1" }, secrets: [], fetchImpl: f });
    expect(r).toEqual({ status: 200, data: { ok: 1 } });
    expect(f.calls[0].init.method).toBe("POST");
    expect(f.calls[0].init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(f.calls[0].init.body)).toEqual({ a: 1 });
    expect(f.calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws UpstreamError with redacted detail on failure", async () => {
    const f = fakeFetch(400, { detail: "bad token SECRET123" });
    const err = await postJson("https://x", { service: "ConvoAI", body: {}, headers: {}, secrets: ["SECRET123"], fetchImpl: f }).catch(e => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(400);
    expect(err.message).toBe("ConvoAI: bad token <redacted>");
  });

  it("falls back to HTTP status when the body has no message", async () => {
    const err = await postJson("https://x", { service: "Vivix", body: {}, headers: {}, secrets: [], fetchImpl: fakeFetch(502, "<html>") }).catch(e => e);
    expect(err.message).toBe("Vivix: HTTP 502");
  });

  it("accepts statuses listed in okStatuses", async () => {
    const r = await postJson("https://x", { service: "X", body: {}, headers: {}, secrets: [], okStatuses: [404], fetchImpl: fakeFetch(404, {}) });
    expect(r.status).toBe(404);
  });
});
