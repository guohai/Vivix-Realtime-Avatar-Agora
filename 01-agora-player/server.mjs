import http from "node:http";
import { readFile } from "node:fs/promises";
const key = process.env.VIVIX_API_KEY;
if (!key) throw new Error("Set VIVIX_API_KEY");
const responseFile = process.env.SESSION_RESPONSE_FILE;
const config = responseFile ? null : JSON.parse(await readFile("session.json", "utf8"));
let imported = false;
let sessionId;
let starting = false;
async function api(path, body) {
  const res = await fetch(`https://api.vivix.ai/v1/${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok || data.code !== 0) throw new Error(data.message || `HTTP ${res.status}`);
  return data.data;
}
http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/session") {
      if (starting || sessionId) { res.writeHead(409); return res.end("Close the current session first"); }
      starting = true;
      try {
        let s;
        if (responseFile) {
          if (imported) throw new Error("This saved session has already been used. Create a new session to restart.");
          const envelope = JSON.parse(await readFile(responseFile, "utf8"));
          if (envelope.code !== 0 || !envelope.data?.session_id) throw new Error("Expected a successful Create Session response");
          s = envelope.data;
          imported = true;
        } else {
          s = await api("realtime-avatar/sessions", config);
        }
        sessionId = s.session_id;
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify(s));
      } finally { starting = false; }
    }
    if (req.method === "POST" && req.url === "/close") {
      if (sessionId) {
        const result = await api(`realtime-avatar/sessions/${encodeURIComponent(sessionId)}/close`, {});
        if (!["closing", "closed"].includes(result.status)) throw new Error(`Session status: ${result.status}`);
      }
      sessionId = undefined;
      return res.end("Session closure requested");
    }
    const files = { "/": ["index.html", "text/html"], "/app.js": ["app.js", "text/javascript"] };
    const file = req.method === "GET" && files[req.url];
    if (!file) { res.writeHead(404); return res.end(); }
    res.setHeader("Content-Type", file[1]);
    res.end(await readFile(file[0]));
  } catch (e) { res.writeHead(500); res.end(String(e.message)); }
}).listen(Number(process.env.PORT) || 3000, "127.0.0.1", function () { console.log(`http://localhost:${this.address().port}`); });
