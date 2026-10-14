import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, applyDefaults } from "./app.mjs";
import { UpstreamError } from "./upstream.mjs";

const HEX = "0123456789abcdef0123456789abcdef";
const SENTINEL = "SENTINEL-OUTSIDE-STATIC-DIR";
const body = { agora: { appId: HEX, certificate: HEX, pipelineId: "pipe" }, vivix: { apiKey: "vk" } };
const vivixSession = { sessionId: "s-1", control: { url: "wss://c", clientSecret: "cs" }, media: {} };
const convoSession = { agentId: "ag-1", appId: HEX, channel: "ch", uid: 1, token: "t", agentUid: 2 };

let server, base, calls, deps;
beforeEach(async () => {
  calls = [];
  // staticDir is <root>/site, so <root>/secret.txt sits outside the served tree.
  const root = mkdtempSync(join(tmpdir(), "vx-static-"));
  const dir = join(root, "site");
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(root, "secret.txt"), SENTINEL);
  writeFileSync(join(dir, "index.html"), "<h1>demo</h1>");
  writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
  deps = {
    staticDir: dir,
    createSession: async a => { calls.push(["create", a]); return vivixSession; },
    closeSession: async a => { calls.push(["close", a]); return "closed"; },
    joinAgent: async a => { calls.push(["join", a]); return convoSession; },
    leaveAgent: async a => { calls.push(["leave", a]); },
    interruptAgent: async a => { calls.push(["interrupt", a]); },
  };
  server = http.createServer((req, res) => createApp(deps)(req, res));
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => new Promise(r => server.close(r)));

const post = (path, b) => fetch(base + path, { method: "POST", body: typeof b === "string" ? b : JSON.stringify(b) });

// Raw request: fetch would normalize dot segments and %2e before sending.
const rawGet = path => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port: server.address().port, path, method: "GET" }, res => {
    let data = "";
    res.setEncoding("utf8");
    res.on("data", c => { data += c; });
    res.on("end", () => resolve({ status: res.statusCode, body: data }));
  });
  req.on("error", reject);
  req.end();
});

describe("POST /api/session", () => {
  it("creates both sides and reports timings", async () => {
    const res = await post("/api/session", { ...body, agora: { ...body.agora, persona: "hi" }, vivix: { apiKey: "vk", imageUrl: "https://x/y.jpg" } });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.vivix).toEqual(vivixSession);
    expect(j.convo).toEqual(convoSession);
    expect(typeof j.timings.vivixCreateMs).toBe("number");
    expect(typeof j.timings.convoJoinMs).toBe("number");
    expect(calls).toContainEqual(["create", { apiKey: "vk", imageUrl: "https://x/y.jpg" }]);
    expect(calls).toContainEqual(["join", { appId: HEX, certificate: HEX, pipelineId: "pipe", persona: "hi" }]);
  });

  it("rejects a malformed App ID with the field name", async () => {
    const res = await post("/api/session", { ...body, agora: { ...body.agora, appId: "nope" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Agora App ID must be 32 hex characters", field: "agora.appId" });
    expect(calls).toEqual([]);
  });

  it("rejects a non-https image URL", async () => {
    const res = await post("/api/session", { ...body, vivix: { apiKey: "vk", imageUrl: "file:///etc/passwd" } });
    expect((await res.json()).field).toBe("vivix.imageUrl");
  });

  it("rolls back the Vivix session when the ConvoAI join fails", async () => {
    deps.joinAgent = async () => { throw new UpstreamError("ConvoAI", "properties: tts.addon not found", 400); };
    const res = await post("/api/session", body);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("ConvoAI: properties: tts.addon not found");
    expect(calls).toContainEqual(["close", { apiKey: "vk", sessionId: "s-1" }]);
  });

  it("rolls back the agent when the Vivix create fails", async () => {
    deps.createSession = async () => { throw new UpstreamError("Vivix", "bad image", 400); };
    const res = await post("/api/session", body);
    expect(res.status).toBe(502);
    expect(calls).toContainEqual(["leave", { appId: HEX, certificate: HEX, agentId: "ag-1" }]);
  });

  it("logs a failed rollback close with the session ID and still returns the join error", async () => {
    deps.joinAgent = async () => { throw new UpstreamError("ConvoAI", "nope", 400); };
    deps.closeSession = async () => { throw new UpstreamError("Vivix", "down", 500); };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await post("/api/session", body);
      expect(res.status).toBe(502);
      expect((await res.json()).error).toBe("ConvoAI: nope");
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("Vivix session s-1"));
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects invalid JSON and oversized bodies", async () => {
    expect((await post("/api/session", "{")).status).toBe(400);
    expect((await post("/api/session", "x".repeat(70_000))).status).toBe(413);
  });
});

describe("POST /api/session/stop", () => {
  it("stops both sides in parallel and accepts text/plain beacons", async () => {
    const res = await fetch(base + "/api/session/stop", { method: "POST", headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ ...body, agentId: "ag-1", vivixSessionId: "s-1" }) });
    expect(res.status).toBe(200);
    expect(calls.map(c => c[0]).sort()).toEqual(["close", "leave"]);
  });

  it("still closes Vivix when leave fails, then reports the failure", async () => {
    deps.leaveAgent = async () => { throw new UpstreamError("ConvoAI", "boom", 500); };
    const res = await post("/api/session/stop", { ...body, agentId: "ag-1", vivixSessionId: "s-1" });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("ConvoAI: boom");
    expect(calls.map(c => c[0])).toEqual(["close"]);
  });

  it("reports every failure when both sides fail", async () => {
    deps.leaveAgent = async () => { throw new UpstreamError("ConvoAI", "boom", 500); };
    deps.closeSession = async () => { throw new UpstreamError("Vivix", "gone", 500); };
    const res = await post("/api/session/stop", { ...body, agentId: "ag-1", vivixSessionId: "s-1" });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("ConvoAI: boom; Vivix: gone");
  });
});

describe("POST /api/session/interrupt", () => {
  it("requires an agent id", async () => {
    expect((await post("/api/session/interrupt", { agora: body.agora })).status).toBe(400);
    expect((await post("/api/session/interrupt", { agora: body.agora, agentId: "ag-1" })).status).toBe(200);
  });
});

describe("static and health", () => {
  it("serves health, index, assets, and refuses traversal", async () => {
    expect(await (await fetch(base + "/health")).json()).toEqual({ ok: true });
    const index = await fetch(base + "/");
    expect(await index.text()).toBe("<h1>demo</h1>");
    expect(index.headers.get("cache-control")).toBe("no-cache");
    const asset = await fetch(base + "/assets/app.js");
    expect(asset.headers.get("content-type")).toBe("text/javascript");
    expect(asset.headers.get("cache-control")).toMatch(/immutable/);
    expect((await fetch(base + "/missing.js")).status).toBe(404);
  });

  it("refuses traversal to a file outside the static dir", async () => {
    // "/..%2fsecret.txt" decodes to "/../secret.txt" and reaches the guard; it must not be served.
    for (const path of ["/..%2f..%2fsecret.txt", "/..%2fsecret.txt", "/../secret.txt"]) {
      const res = await rawGet(path);
      expect(res.status, path).toBe(404);
      expect(res.body, path).not.toContain(SENTINEL);
    }
  });
});

describe("server credential defaults", () => {
  const OTHER = "fedcba9876543210fedcba9876543210";
  const defaults = { agora: { appId: HEX, certificate: "c".repeat(32), pipelineId: "dpipe" }, vivix: { apiKey: "dvk" } };

  it("fills blank fields and keeps typed ones", () => {
    expect(applyDefaults({ agora: { appId: "", pipelineId: "mine" }, vivix: {} }, defaults)).toEqual({
      agora: { appId: HEX, certificate: "c".repeat(32), pipelineId: "mine" }, vivix: { apiKey: "dvk" } });
  });

  it("never pairs a typed App ID with the default project's certificate or pipeline", () => {
    const out = applyDefaults({ agora: { appId: OTHER }, vivix: { apiKey: "vk" } }, defaults);
    expect(out.agora).toEqual({ appId: OTHER });
    expect(out.vivix).toEqual({ apiKey: "vk" });
  });

  it("is a no-op without defaults", () => {
    expect(applyDefaults({ agora: { appId: "" }, vivix: {} })).toEqual({ agora: { appId: "" }, vivix: {} });
  });

  it("starts and stops a session from an empty form", async () => {
    deps.defaults = defaults;
    expect((await post("/api/session", { agora: {}, vivix: {} })).status).toBe(200);
    expect(calls).toContainEqual(["create", { apiKey: "dvk" }]);
    expect(calls).toContainEqual(["join", { appId: HEX, certificate: "c".repeat(32), pipelineId: "dpipe" }]);
    expect((await post("/api/session/stop", { agentId: "ag-1", vivixSessionId: "s-1" })).status).toBe(200);
    expect(calls).toContainEqual(["close", { apiKey: "dvk", sessionId: "s-1" }]);
  });

  it("reports which fields are covered without revealing values", async () => {
    deps.defaults = defaults;
    const res = await fetch(base + "/api/defaults");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ agoraAppId: true, agoraCertificate: true, pipelineId: true, vivixApiKey: true });
    for (const secret of [HEX, "c".repeat(32), "dpipe", "dvk"]) expect(text).not.toContain(secret);
    deps.defaults = {};
    expect(await (await fetch(base + "/api/defaults")).json()).toEqual(
      { agoraAppId: false, agoraCertificate: false, pipelineId: false, vivixApiKey: false });
  });
});
