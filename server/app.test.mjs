import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.mjs";
import { UpstreamError } from "./upstream.mjs";

const HEX = "0123456789abcdef0123456789abcdef";
const body = { agora: { appId: HEX, certificate: HEX, pipelineId: "pipe" }, vivix: { apiKey: "vk" } };
const vivixSession = { sessionId: "s-1", control: { url: "wss://c", clientSecret: "cs" }, media: {} };
const convoSession = { agentId: "ag-1", appId: HEX, channel: "ch", uid: 1, token: "t", agentUid: 2 };

let server, base, calls, deps;
beforeEach(async () => {
  calls = [];
  const dir = mkdtempSync(join(tmpdir(), "vx-static-"));
  mkdirSync(join(dir, "assets"));
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
    expect((await fetch(base + "/%2e%2e/%2e%2e/etc/passwd")).status).toBe(404);
    expect((await fetch(base + "/missing.js")).status).toBe(404);
  });
});
