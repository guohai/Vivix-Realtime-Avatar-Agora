import "./style.css";
import AgoraRTC from "agora-rtc-sdk-ng";
import { FIELDS, SERVER_FIELD, loadCredentials, saveCredentials, validate, type Covered, type Credentials } from "./config";
import { ApiError, fetchCovered } from "./api";
import { Session, CancelledError } from "./session";
import type { Line } from "./transcript";
import { MIC_STORAGE_KEY, labelsHidden, micOptions } from "./mic";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const form = $<HTMLFormElement>("#creds");
const remember = $<HTMLInputElement>("#remember");
const startBtn = $<HTMLButtonElement>("#start"), stopBtn = $<HTMLButtonElement>("#stop");
const muteBtn = $<HTMLButtonElement>("#mute"), interruptBtn = $<HTMLButtonElement>("#interrupt");
const soundBtn = $<HTMLButtonElement>("#sound"), status = $("#status");
const setup = $("#setup"), credsToggle = $<HTMLButtonElement>("#creds-toggle");
const micSelect = $<HTMLSelectElement>("#mic");
const transcript = $("#transcript"), timeline = $("#timeline"), latency = $("#latency");

const { creds: initial, remembered } = loadCredentials(localStorage);
remember.checked = remembered;
const inputs = {} as Record<keyof Credentials, HTMLInputElement | HTMLTextAreaElement>;
for (const f of FIELDS) {
  const label = document.createElement("label");
  label.dataset.field = f.key;
  const input = f.multiline ? document.createElement("textarea") : document.createElement("input");
  if (input instanceof HTMLInputElement) input.type = f.secret ? "password" : "text";
  input.placeholder = f.placeholder;
  input.value = initial[f.key];
  input.spellcheck = false;
  const err = document.createElement("span");
  err.className = "error";
  label.append(f.label, input, err);
  form.append(label);
  inputs[f.key] = input;
}

let covered: Covered = {};
void fetchCovered().then(c => {
  covered = c;
  for (const f of FIELDS) if (c[f.key]) inputs[f.key].placeholder = "Leave blank to use the server's";
});

const read = (): Credentials => Object.fromEntries(FIELDS.map(f => [f.key, inputs[f.key].value])) as unknown as Credentials;
function showErrors(errors: Partial<Record<keyof Credentials, string>>) {
  for (const f of FIELDS) {
    const label = form.querySelector<HTMLElement>(`[data-field="${f.key}"]`)!;
    label.classList.toggle("invalid", !!errors[f.key]);
    label.querySelector(".error")!.textContent = errors[f.key] ?? "";
  }
}

let session: Session | undefined;

// ---- Microphone choice ----------------------------------------------------------------------
const savedMic = () => { try { return localStorage.getItem(MIC_STORAGE_KEY) ?? ""; } catch { return ""; } };
let micLabelsHidden = true;

// askPermission: the browser hides device names until the mic is allowed, so the first click on
// the dropdown asks once and then lists the real names.
async function refreshMics(askPermission = false) {
  let devices: MediaDeviceInfo[];
  try { devices = await AgoraRTC.getMicrophones(!askPermission); }
  catch { devices = []; }
  micLabelsHidden = labelsHidden(devices);
  const { options, selected } = micOptions(devices, micSelect.value || savedMic());
  micSelect.replaceChildren(...options.map(o => new Option(o.label, o.id, false, o.id === selected)));
}
void refreshMics();
AgoraRTC.onMicrophoneChanged = () => void refreshMics();
micSelect.addEventListener("pointerdown", () => { if (micLabelsHidden) void refreshMics(true); });
micSelect.onchange = async () => {
  try { localStorage.setItem(MIC_STORAGE_KEY, micSelect.value); } catch { /* not remembered */ }
  try { await session?.setMicrophone(micSelect.value); }
  catch (e) { status.textContent = `Could not switch microphone: ${(e as Error).message}`; }
};
let muted = false;
const latencies: number[] = [];

function setRunning(running: boolean) {
  startBtn.disabled = running;
  stopBtn.disabled = !running;
  muteBtn.disabled = interruptBtn.disabled = !running;
  for (const el of Object.values(inputs)) el.disabled = running;
  // Collapsed while running (inputs stay disabled); a toggle reveals them read-only.
  setup.classList.toggle("running", running);
  setup.classList.remove("creds-open");
  credsToggle.hidden = !running;
  credsToggle.textContent = "Show credentials";
}

const avg = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);

function renderTranscript(lines: Line[]) {
  transcript.replaceChildren(...lines.map(l => {
    const li = document.createElement("li");
    li.className = `${l.role}${l.final ? "" : " partial"}`;
    li.textContent = l.text;
    return li;
  }));
  transcript.lastElementChild?.scrollIntoView({ block: "nearest" });
}

async function stop(reason?: string) {
  const s = session;
  if (!s) return;
  session = undefined;
  stopBtn.disabled = true;
  status.textContent = "Stopping…";
  let outcome: string;
  try { await s.stop(); outcome = reason ?? "Stopped."; }
  catch (e) { outcome = `Stopped locally; upstream close failed: ${(e as Error).message}`; }
  if (session) return; // a newer session already owns the UI
  status.textContent = outcome;
  setRunning(false);
  soundBtn.hidden = true;
}

startBtn.onclick = async () => {
  const creds = read();
  const errors = validate(creds, covered);
  showErrors(errors);
  if (Object.keys(errors).length) { status.textContent = "Fix the highlighted fields."; return; }
  try { saveCredentials(localStorage, creds, remember.checked); }
  catch { status.textContent = "Could not save credentials on this device; continuing without remembering."; }

  timeline.replaceChildren(); transcript.replaceChildren(); latencies.length = 0;
  latency.textContent = "—";
  muted = false; muteBtn.textContent = "Mute mic";
  setRunning(true);
  // Late callbacks from a superseded session must not touch the shared UI (a stopped one may still report).
  const mine = () => session === s || session === undefined;
  const s: Session = new Session(creds, $("#video"), {
    status: t => { if (mine()) status.textContent = t; },
    mark: (label, ms) => {
      if (!mine()) return;
      const dt = document.createElement("dt"), dd = document.createElement("dd");
      dt.textContent = label; dd.textContent = `${ms} ms`;
      timeline.append(dt, dd);
    },
    latency: t => {
      if (!mine()) return;
      const stat = (xs: number[], x: number) => { xs.push(x); return `last ${x} ms · avg ${avg(xs)} ms`; };
      const net = t.videoNetworkMs != null ? ` · video network ${t.videoNetworkMs} ms` : "";
      latency.textContent = `${stat(latencies, t.renderMs)} (${latencies.length} turns)${net}`;
    },
    transcript: lines => { if (mine()) renderTranscript(lines); },
    autoplayBlocked: () => { if (mine()) soundBtn.hidden = false; },
    ended: reason => { if (session === s) void stop(reason); },
  });
  session = s;
  await s.setMicrophone(micSelect.value);
  try {
    await s.start();
    if (micLabelsHidden) void refreshMics(); // permission granted now: show real names
  }
  catch (e) {
    if (e instanceof CancelledError || session !== s) return; // Stop was pressed (or a newer session owns the UI)
    const err = e as ApiError;
    if (err.field && SERVER_FIELD[err.field]) showErrors({ [SERVER_FIELD[err.field]]: err.message });
    await stop(`Start failed: ${err.message}`);
  }
};

credsToggle.onclick = () => {
  const open = setup.classList.toggle("creds-open");
  credsToggle.textContent = open ? "Hide credentials" : "Show credentials";
};

stopBtn.onclick = () => void stop();
interruptBtn.onclick = () => session?.interrupt().catch(e => { status.textContent = `Interrupt failed: ${e.message}`; });
muteBtn.onclick = async () => {
  muted = !muted;
  await session?.setMuted(muted);
  muteBtn.textContent = muted ? "Unmute mic" : "Mute mic";
};
soundBtn.onclick = () => { soundBtn.hidden = true; session?.resumeAudio(); };
remember.onchange = () => {
  try { saveCredentials(localStorage, read(), remember.checked); }
  catch { remember.checked = false; }
};
addEventListener("pagehide", () => session?.stopOnUnload());
