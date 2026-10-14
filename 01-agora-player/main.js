import AgoraRTC from "agora-rtc-sdk-ng";
async function connect(s) {
  const m = s.delivery.media.agora;
  if (!m) throw new Error("Expected Agora credentials");
  const rtc = AgoraRTC.createClient({mode: "rtc", codec: "vp8"});
  const sound = document.querySelector("#sound");
  let remoteAudio, remoteVideo;
  AgoraRTC.onAutoplayFailed = () => { sound.hidden = false; };
  sound.onclick = () => {
    sound.hidden = true;
    try {
      remoteAudio?.play();
      remoteVideo?.play("video", {fit: "contain"});
    } catch (e) { sound.hidden = false; status.textContent = e.message; }
  };
  cleanup = async () => {
    sound.hidden = true; sound.onclick = null;
    AgoraRTC.onAutoplayFailed = undefined;
    remoteAudio?.stop(); remoteVideo?.stop();
    await rtc.leave(); rtc.removeAllListeners();
  };
  rtc.on("user-published", async (user, type) => {
    if (String(user.uid) !== String(m.publisher_user_id)) return;
    try {
      await rtc.subscribe(user, type);
      if (type === "video") {
        remoteVideo = user.videoTrack;
        user.videoTrack.on("first-frame-decoded", () => { status.textContent = "Video playing"; });
        user.videoTrack.play("video", {fit: "contain"});
      }
      if (type === "audio") { remoteAudio = user.audioTrack; remoteAudio.play(); }
    } catch (e) { status.textContent = e.message; }
  });
  await control(s);
  const text = String(m.user_id);
  const uid = /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : text;
  await rtc.join(m.app_id, m.channel_name, m.token || null, uid);
  window.player = { ws, agora: rtc };
}
const status = document.querySelector("#status");
const start = document.querySelector("#start");
const stop = document.querySelector("#stop");
let ws, cleanup;
let stopping = false;
async function post(path) {
  const r = await fetch(path, { method: "POST" });
  if (!r.ok) throw new Error(await r.text());
  return path === "/session" ? r.json() : null;
}
async function control(s) {
  const url = new URL(s.control.url);
  url.searchParams.set("token", s.control.client_secret);
  ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error("Control timeout")); }, 15000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = ws.onclose = () => { clearTimeout(timer); reject(new Error("Control failed")); };
  });
  ws.onclose = () => { if (!stopping) status.textContent = "Control disconnected. Stop before starting again."; };
  ws.onerror = () => { if (!stopping) status.textContent = "Control error. Click Stop to release the session."; };
}
stop.onclick = async () => {
  stop.disabled = true;
  try { await post("/close"); stopping = true; ws?.close(); await stopMicrophone(); await cleanup?.(); cleanup = undefined; delete window.player; status.textContent = "Stopped"; start.disabled = false; }
  catch (e) { status.textContent = `Close failed: ${e.message}. Retry Stop.`; }
  finally { stop.disabled = false; }
};
start.onclick = async () => {
  stopping = false;
  start.disabled = true;
  stop.disabled = true;
  status.textContent = "Starting…";
  try {
    const s = await post("/session");
    status.textContent = "Connected; waiting for video";
    await connect(s);
  } catch (e) {
    status.textContent = `${e.message}. Click Stop to release the session.`;
  } finally { stop.disabled = false; }
};
// In the Agora player's main.js, which already imports AgoraRTC.
let microphone, microphoneClient;
let micBusy = false;
let desiredMic = false;
let micGeneration = 0;
const micOn = document.querySelector("#mic-on");
const micOff = document.querySelector("#mic-off");
micOn.onclick = async () => {
  if (microphone || micBusy) return;
  const client = window.player?.agora;
  if (!client) return;
  desiredMic = true;
  const generation = ++micGeneration;
  const stillWanted = () => desiredMic && generation === micGeneration
    && window.player?.agora === client;
  micBusy = true;
  let track;
  let published = false;
  try {
    track = await AgoraRTC.createMicrophoneAudioTrack();
    if (!stillWanted()) return;
    await client.publish([track]);
    published = true;
    if (!stillWanted()) return;
    microphone = track;
    microphoneClient = client;
    track = undefined; // Ownership passes to stopMicrophone().
  } catch (e) {
    document.querySelector("#status").textContent = e.message;
  } finally {
    try {
      if (track && published) await client.unpublish([track]);
    } catch (e) {
      document.querySelector("#status").textContent = e.message;
    } finally {
      track?.close();
      micBusy = false;
    }
  }
};
async function stopMicrophone() {
  desiredMic = false;
  ++micGeneration; // Also cancels capture awaiting permission or publication.
  const track = microphone;
  const client = microphoneClient;
  microphone = microphoneClient = undefined;
  if (!track) return;
  try { await client.unpublish([track]); }
  finally { track.close(); }
}
micOff.onclick = () => stopMicrophone().catch(e => {
  document.querySelector("#status").textContent = e.message;
});
