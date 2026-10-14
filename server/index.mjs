import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.mjs";
import { createSession, closeSession } from "./vivix.mjs";
import { joinAgent, leaveAgent, interruptAgent } from "./agora.mjs";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT) || 8787;
// Browsers only open the microphone in a secure context, so reaching the demo from another
// machine needs HTTPS: set TLS_CERT and TLS_KEY to PEM files (see README).
const tls = process.env.TLS_CERT && process.env.TLS_KEY
  ? { cert: readFileSync(process.env.TLS_CERT), key: readFileSync(process.env.TLS_KEY) }
  : null;
const publicHost = process.env.PUBLIC_HOST || (host === "0.0.0.0" ? "localhost" : host);
const staticDir = fileURLToPath(new URL("../web/dist", import.meta.url));
const app = createApp({ createSession, closeSession, joinAgent, leaveAgent, interruptAgent, staticDir });

(tls ? https.createServer(tls, app) : http.createServer(app)).listen(port, host, function () {
  console.log(`Vivix × ConvoAI demo on ${tls ? "https" : "http"}://${publicHost}:${this.address().port}`);
});
