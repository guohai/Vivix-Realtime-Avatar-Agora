import http from "node:http";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.mjs";
import { createSession, closeSession } from "./vivix.mjs";
import { joinAgent, leaveAgent, interruptAgent } from "./agora.mjs";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT) || 8787;
const staticDir = fileURLToPath(new URL("../web/dist", import.meta.url));
const app = createApp({ createSession, closeSession, joinAgent, leaveAgent, interruptAgent, staticDir });

http.createServer(app).listen(port, host, function () {
  console.log(`Vivix × ConvoAI demo on http://${host === "0.0.0.0" ? "localhost" : host}:${this.address().port}`);
});
