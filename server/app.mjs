// Routes. Stateless: each request carries the credentials it needs.
import { readFile } from "node:fs/promises";
import { join, normalize, sep, extname } from "node:path";
import { HttpError, sessionRequest, stopRequest, interruptRequest } from "./validate.mjs";
import { UpstreamError } from "./upstream.mjs";

const MAX_BODY_BYTES = 64 * 1024;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".wav": "audio/wav", ".json": "application/json" };

async function readBody(req) {
  let size = 0;
  const chunks = [];
  // Drain the whole body before rejecting, so the client sees the 413 rather than a reset.
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw new HttpError(400, "Request body must be JSON"); }
}

const send = (res, status, payload) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
};

async function timed(timings, key, fn) {
  const t = performance.now();
  try { return await fn(); } finally { timings[key] = Math.round(performance.now() - t); }
}

// Runs fn and turns a synchronous throw into a rejection, so every side is attempted.
const attempt = fn => (async () => fn())();

// Several sides failed: report all of them, joined. Still an UpstreamError, so it maps to 502.
class UpstreamFailures extends UpstreamError {
  constructor(messages) {
    super("Session", "", 502);
    this.message = messages.join("; ");
  }
}

// allSettled so a failure on one side never leaves the other running unobserved.
async function settleAll(tasks) {
  const failures = (await Promise.allSettled(tasks.filter(Boolean)))
    .filter(r => r.status === "rejected")
    .map(r => r.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new UpstreamFailures(failures.map(e => String(e?.message ?? e)));
}

export function createApp(deps) {
  const { createSession, closeSession, joinAgent, leaveAgent, interruptAgent, staticDir } = deps;
  const root = normalize(staticDir + sep);

  async function startSession(body) {
    const { agora, vivix } = sessionRequest(body);
    const timings = {};
    const [v, c] = await Promise.allSettled([
      timed(timings, "vivixCreateMs", () => createSession(vivix)),
      timed(timings, "convoJoinMs", () => joinAgent(agora)),
    ]);
    if (v.status === "rejected" || c.status === "rejected") {
      const rollbacks = [];
      if (v.status === "fulfilled") {
        rollbacks.push({ label: `Vivix session ${v.value.sessionId}`,
          run: () => closeSession({ apiKey: vivix.apiKey, sessionId: v.value.sessionId }) });
      }
      if (c.status === "fulfilled") {
        rollbacks.push({ label: `ConvoAI agent ${c.value.agentId}`,
          run: () => leaveAgent({ appId: agora.appId, certificate: agora.certificate, agentId: c.value.agentId }) });
      }
      const results = await Promise.allSettled(rollbacks.map(r => attempt(r.run)));
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          console.error(`Rollback failed: ${rollbacks[i].label} left open: ${String(r.reason?.message ?? r.reason)}`);
        }
      });
      throw v.status === "rejected" ? v.reason : c.reason;
    }
    return { vivix: v.value, convo: c.value, timings };
  }

  async function stopSession(body) {
    const r = stopRequest(body);
    await settleAll([
      r.agentId && attempt(() => leaveAgent({ ...r.agora, agentId: r.agentId })),
      r.vivixSessionId && attempt(() => closeSession({ apiKey: r.vivixApiKey, sessionId: r.vivixSessionId })),
    ]);
    return { ok: true };
  }

  async function serveStatic(req, res) {
    let path;
    try { path = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { path = ""; }
    if (path === "/") path = "/index.html";
    const file = normalize(join(root, path));
    if (!path || !file.startsWith(root)) return send(res, 404, { error: "Not found" });
    try {
      const data = await readFile(file);
      res.writeHead(200, {
        "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
        "Cache-Control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      });
      res.end(data);
    } catch { send(res, 404, { error: "Not found" }); }
  }

  const routes = {
    "POST /api/session": startSession,
    "POST /api/session/stop": stopSession,
    "POST /api/session/interrupt": async body => { await interruptAgent(interruptRequest(body)); return { ok: true }; },
  };

  return async (req, res) => {
    try {
      const route = routes[`${req.method} ${req.url}`];
      if (route) return send(res, 200, await route(await readBody(req)));
      if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });
      if (req.method === "GET") return await serveStatic(req, res);
      send(res, 404, { error: "Not found" });
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.field && { field: e.field }) });
      if (e instanceof UpstreamError) return send(res, 502, { error: e.message });
      const msg = String(e?.message ?? "");
      console.error(e);
      send(res, 500, { error: msg.startsWith("ConvoAI:") ? msg : "Internal error" });
    }
  };
}
