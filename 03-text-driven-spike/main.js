// Spike: ConvoAI (customer App ID, pipeline_id) does turn detection, ASR and the LLM. Its reply
// text is sent over the Vivix control socket as scripted speech, so Vivix synthesizes the voice
// and renders the avatar together. ConvoAI's own TTS audio is subscribed (to time it) but never
// played or relayed.
//   ?mode=final     send the whole reply when ConvoAI marks the turn done
//   ?mode=sentence  send each finished sentence as soon as it appears in the streaming text
import AgoraRTC from "agora-rtc-sdk-ng";

const $ = s => document.querySelector(s);
const status = $("#status");
const MODE = new URLSearchParams(location.search).get("mode") === "final" ? "final" : "sentence";
const t0 = performance.now();
const now = () => performance.now() - t0;
const log = msg => {
  const line = `+${(now() / 1000).toFixed(2)}s ${msg}`;
  $("#log").textContent += line + "\n";
  console.log("[ev] " + line);
};
const numeric = v => (/^\d+$/.test(String(v)) && Number.isSafeInteger(Number(v)) ? Number(v) : String(v));

let convo, avatar, ws, mic, stopping = false;
const remote = {};
const turnLog = []; // one record per user turn, for the summary

async function post(path) {
  const r = await fetch(path, { method: "POST" });
  if (!r.ok) throw new Error(await r.text());
  return path === "/session" ? r.json() : null;
}

// ---- Vivix: standard session, driven by response.create scripts --------------------------
const queue = [];      // sentences waiting for the single "after_current_response" slot
let busy = false;      // a response is active or pending on the Vivix side
let pending = 0;       // after_current_response requests accepted but not yet started

function speak(text, policy) {
  ws.send(JSON.stringify({
    type: "response.create",
    response: { conversation: "none", scheduling_policy: policy, script: { vocal: { type: "speech", text } } },
  }));
  log(`→ vivix speak (${policy}) "${text.slice(0, 60)}"`);
}

function enqueue(text, firstOfTurn) {
  if (firstOfTurn) { queue.length = 0; pending = 0; busy = true; speak(text, "interrupt"); return; }
  if (pending === 0) { pending = 1; speak(text, "after_current_response"); } else queue.push(text);
}

function onVivixEvent(e) {
  if (/delta$/.test(e.type)) return;
  if (e.type === "response.render.started") {
    if (pending > 0) pending--;
    const next = queue.shift();
    if (next !== undefined) { pending = 1; speak(next, "after_current_response"); }
    const t = turnLog.at(-1);
    if (t && t.renderStarted == null) t.renderStarted = now();
  }
  if (e.type === "response.done" && pending === 0 && queue.length === 0) busy = false;
  if (e.type === "error") log(`vivix error ${JSON.stringify(e.error ?? e).slice(0, 200)}`);
  else log(`vivix ${e.type}`);
}

function openControl(s) {
  const url = new URL(s.control.url);
  url.searchParams.set("token", s.control.client_secret);
  ws = new WebSocket(url);
  ws.onmessage = ({ data }) => onVivixEvent(JSON.parse(data));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error("Control timeout")); }, 15000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = ws.onclose = () => { clearTimeout(timer); if (!stopping) reject(new Error("Control failed")); };
  });
}

async function joinAvatar(s) {
  const m = s.delivery.media.agora;
  avatar = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
  AgoraRTC.onAutoplayFailed = () => { $("#sound").hidden = false; };
  $("#sound").onclick = () => { $("#sound").hidden = true; remote.avatarAudio?.play(); };
  avatar.on("user-published", async (user, type) => {
    if (String(user.uid) !== String(m.publisher_user_id)) return;
    await avatar.subscribe(user, type);
    if (type === "video") {
      user.videoTrack.on("first-frame-decoded", () => { log("avatar first frame"); status.textContent = "Video playing"; });
      user.videoTrack.play("video", { fit: "contain" });
    } else {
      remote.avatarAudio = user.audioTrack;
      user.audioTrack.play();
    }
  });
  await avatar.join(m.app_id, m.channel_name, m.token || null, numeric(m.user_id));
  log("joined vivix channel");
}

// ---- ConvoAI: mic in, reply text out ------------------------------------------------------
const parts = {};
const sent = new Map(); // turn_id → characters of the reply already sent to Vivix
let lastVoice = null;

function onAssistant(msg) {
  const turn = msg.turn_id ?? -1, text = msg.text ?? "";
  const done = msg.turn_status !== undefined && msg.turn_status !== 0;
  let t = turnLog.find(x => x.turn === turn);
  if (!t) { t = { turn, voiceEnd: turnLog.pendingVoiceEnd ?? null }; turnLog.pendingVoiceEnd = null; turnLog.push(t); }
  if (t.firstText == null) t.firstText = now();
  if (done && t.finalText == null) t.finalText = now();
  if (msg.turn_status === 2) { log(`turn ${turn} interrupted`); return; }

  const already = sent.get(turn) ?? 0;
  let upto = already;
  if (MODE === "sentence") {
    // Everything up to the last sentence end, or all of it once the turn is done.
    const re = /[.!?。！？]+["'”’)]?\s*/g;
    let m;
    while ((m = re.exec(text))) if (m.index + m[0].length > already) upto = m.index + m[0].length;
    if (done) upto = text.length;
  } else if (done) upto = text.length;

  const chunk = text.slice(already, upto).trim();
  if (!chunk) return;
  sent.set(turn, upto);
  if (t.firstSent == null) t.firstSent = now();
  enqueue(chunk, already === 0);
}

function onStreamMessage(_uid, data) {
  const [id, idx, total, b64] = new TextDecoder().decode(data).split("|");
  (parts[id] ||= [])[Number(idx) - 1] = b64;
  if (parts[id].filter(Boolean).length < Number(total)) return;
  const bytes = Uint8Array.from(atob(parts[id].join("")), c => c.charCodeAt(0));
  const msg = JSON.parse(new TextDecoder().decode(bytes)); delete parts[id];
  if (msg.object === "user.transcription" && msg.final) {
    turnLog.pendingVoiceEnd = lastVoice;
    log(`user: ${msg.text}`);
  }
  if (msg.object === "assistant.transcription") onAssistant(msg);
}

async function joinConvo(c) {
  convo = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
  convo.on("user-joined", u => { if (String(u.uid) === String(c.agentUid)) log("agent joined"); });
  convo.on("stream-message", onStreamMessage);
  convo.on("user-published", async (user, type) => {
    if (String(user.uid) !== String(c.agentUid) || type !== "audio") return;
    await convo.subscribe(user, "audio");
    // Kept flowing (muted sink) only to time ConvoAI's own TTS; never audible, never relayed.
    const sink = new Audio(); sink.muted = true;
    sink.srcObject = new MediaStream([user.audioTrack.getMediaStreamTrack()]); sink.play().catch(() => {});
    remote.agentAudio = user.audioTrack;
  });
  await convo.join(c.appId, c.channel, c.token, c.uid);
  log("joined convo channel");
}

// ---- Timing: mic voice end, ConvoAI TTS onset, avatar audio onset -------------------------
function sample() {
  let agentOn = false, avatarOn = false;
  return setInterval(() => {
    const t = now();
    if ((mic?.getVolumeLevel() ?? 0) > 0.05) lastVoice = t;
    const a = remote.agentAudio?.getVolumeLevel() ?? 0, v = remote.avatarAudio?.getVolumeLevel() ?? 0;
    const turn = turnLog.at(-1);
    if (!agentOn && a > 0.05) { agentOn = true; if (turn && turn.agentAudio == null) turn.agentAudio = t; }
    if (agentOn && a < 0.01) agentOn = false;
    if (!avatarOn && v > 0.05) {
      avatarOn = true;
      if (turn && turn.avatarAudio == null) { turn.avatarAudio = t; report(turn); }
    }
    if (avatarOn && v < 0.01) avatarOn = false;
  }, 50);
}

function report(t) {
  if (t.voiceEnd == null) { log(`turn ${t.turn}: no user speech (greeting) — avatar spoke ${ms(t.avatarAudio - t.firstText)} after first text`); return; }
  const rel = k => (t[k] == null ? "—" : `${ms(t[k] - t.voiceEnd)}`);
  log(`TURN ${t.turn} from end of speech: first text ${rel("firstText")}, first sent ${rel("firstSent")}, ` +
      `final text ${rel("finalText")}, ConvoAI TTS ${rel("agentAudio")}, vivix render ${rel("renderStarted")}, ` +
      `AVATAR VOICE ${rel("avatarAudio")}`);
}
const ms = x => `${Math.round(x)} ms`;

let sampler;
$("#start").onclick = async () => {
  stopping = false; $("#start").disabled = true; status.textContent = "Starting…";
  log(`mode: ${MODE}`);
  try {
    const micReady = AgoraRTC.createMicrophoneAudioTrack({ AEC: true, ANS: true, AGC: true });
    const s = await post("/session");
    log(`server: vivix create ${s.timings.vivixCreateMs} ms, convo join ${s.timings.convoJoinMs} ms`);
    await Promise.all([openControl(s.vivix), joinAvatar(s.vivix), joinConvo(s.convo)]);
    mic = await micReady;
    await convo.publish(mic);
    log("mic published into convo channel");
    sampler = sample();
  } catch (e) { status.textContent = `${e.message}. Click Stop to release the session.`; log(`error ${e.message}`); }
};

$("#interrupt").onclick = () => post("/interrupt").then(() => log("interrupt sent"));

$("#stop").onclick = async () => {
  try {
    await post("/close"); stopping = true;
    clearInterval(sampler); ws?.close(); mic?.close();
    await Promise.all([convo?.leave(), avatar?.leave()]);
    status.textContent = "Stopped"; $("#start").disabled = false;
  } catch (e) { status.textContent = `Close failed: ${e.message}. Retry Stop.`; }
};
