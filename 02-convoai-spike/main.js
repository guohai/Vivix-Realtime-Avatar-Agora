// Spike: mic → ConvoAI channel (customer App ID); agent TTS track → republished into the
// Vivix channel (passthrough); avatar video + audio played. The agent's raw audio is never played.
import AgoraRTC from "agora-rtc-sdk-ng";

const $ = s => document.querySelector(s);
const status = $("#status");
const t0 = performance.now();
const log = msg => {
  const line = `+${((performance.now() - t0) / 1000).toFixed(2)}s ${msg}`;
  $("#log").textContent += line + "\n";
  console.log("[ev] " + line);
};
const numeric = v => (/^\d+$/.test(String(v)) && Number.isSafeInteger(Number(v)) ? Number(v) : String(v));

let session, convo, avatar, ws, mic, relay, sink, stopping = false;
const remote = {};

async function post(path) {
  const r = await fetch(path, { method: "POST" });
  if (!r.ok) throw new Error(await r.text());
  return path === "/session" ? r.json() : null;
}

function openControl(s) {
  const url = new URL(s.control.url);
  url.searchParams.set("token", s.control.client_secret);
  ws = new WebSocket(url);
  ws.onmessage = ({ data }) => { const e = JSON.parse(data); if (!/delta$/.test(e.type)) log(`vivix ${e.type}`); };
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
  avatar.on("user-joined", u => log(`vivix channel: uid ${u.uid} joined`));
  await avatar.join(m.app_id, m.channel_name, m.token || null, numeric(m.user_id));
  log("joined vivix channel");
}

async function relayAgent(track) {
  // Keep the remote track flowing in Chrome without playing it out loud.
  sink = new Audio(); sink.muted = true; sink.srcObject = new MediaStream([track.getMediaStreamTrack()]); sink.play().catch(() => {});
  relay = AgoraRTC.createCustomAudioTrack({ mediaStreamTrack: track.getMediaStreamTrack() });
  await avatar.publish(relay);
  log("relay published into vivix channel");
}

const parts = {};
function onStreamMessage(_uid, data) {
  const [id, idx, total, b64] = new TextDecoder().decode(data).split("|");
  (parts[id] ||= [])[Number(idx) - 1] = b64;
  if (parts[id].filter(Boolean).length < Number(total)) return;
  const msg = JSON.parse(atob(parts[id].join(""))); delete parts[id];
  if (msg.final === false || msg.turn_status === 0) return;
  log(`convo ${msg.object} ${msg.text ?? ""}`.slice(0, 200));
}

async function joinConvo(c) {
  convo = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
  convo.on("user-joined", u => { if (String(u.uid) === String(c.agentUid)) log("agent joined"); });
  convo.on("stream-message", onStreamMessage);
  convo.on("user-published", async (user, type) => {
    if (String(user.uid) !== String(c.agentUid) || type !== "audio") return;
    await convo.subscribe(user, "audio");
    remote.agentAudio = user.audioTrack;
    log("agent audio subscribed");
    await relayAgent(user.audioTrack);
  });
  await convo.join(c.appId, c.channel, c.token, c.uid);
  log("joined convo channel");
}

function sampleLevels() {
  let agentOn = false, avatarOn = false, onsetAt = 0;
  return setInterval(() => {
    const a = remote.agentAudio?.getVolumeLevel() ?? 0, v = remote.avatarAudio?.getVolumeLevel() ?? 0;
    if (!agentOn && a > 0.05) { agentOn = true; onsetAt = performance.now(); log(`agent audio onset (${a.toFixed(2)})`); }
    if (agentOn && !avatarOn && v > 0.05) { avatarOn = true; log(`avatar audio onset (${v.toFixed(2)}) relay+render ${Math.round(performance.now() - onsetAt)} ms`); }
    if (agentOn && a < 0.01 && avatarOn && v < 0.01) agentOn = avatarOn = false;
  }, 50);
}

let sampler;
$("#start").onclick = async () => {
  stopping = false; $("#start").disabled = true; status.textContent = "Starting…";
  try {
    const micReady = AgoraRTC.createMicrophoneAudioTrack({ AEC: true, ANS: true, AGC: true });
    const s = await post("/session");
    session = s;
    log(`server: vivix create ${s.timings.vivixCreateMs} ms, convo join ${s.timings.convoJoinMs} ms`);
    await Promise.all([openControl(s.vivix), joinAvatar(s.vivix), joinConvo(s.convo)]);
    mic = await micReady;
    await convo.publish(mic);
    log("mic published into convo channel");
    sampler = sampleLevels();
    window.spike = { convo, avatar, ws, remote };
  } catch (e) { status.textContent = `${e.message}. Click Stop to release the session.`; log(`error ${e.message}`); }
};

$("#interrupt").onclick = () => post("/interrupt").then(() => log("interrupt sent"));

$("#stop").onclick = async () => {
  try {
    await post("/close"); stopping = true;
    clearInterval(sampler); ws?.close();
    mic?.close(); relay?.close(); if (sink) sink.srcObject = null;
    await Promise.all([convo?.leave(), avatar?.leave()]);
    status.textContent = "Stopped"; $("#start").disabled = false;
  } catch (e) { status.textContent = `Close failed: ${e.message}. Retry Stop.`; }
};
