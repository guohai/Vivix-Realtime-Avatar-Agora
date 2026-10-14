import "./style.css";
import { FIELDS, SERVER_FIELD, loadCredentials, saveCredentials, validate, type Credentials } from "./config";
import { ApiError } from "./api";
import { Session, CancelledError } from "./session";
import type { Line } from "./transcript";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const form = $<HTMLFormElement>("#creds");
const remember = $<HTMLInputElement>("#remember");
const startBtn = $<HTMLButtonElement>("#start"), stopBtn = $<HTMLButtonElement>("#stop");
const muteBtn = $<HTMLButtonElement>("#mute"), interruptBtn = $<HTMLButtonElement>("#interrupt");
const soundBtn = $<HTMLButtonElement>("#sound"), status = $("#status");
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

const read = (): Credentials => Object.fromEntries(FIELDS.map(f => [f.key, inputs[f.key].value])) as unknown as Credentials;
function showErrors(errors: Partial<Record<keyof Credentials, string>>) {
  for (const f of FIELDS) {
    const label = form.querySelector<HTMLElement>(`[data-field="${f.key}"]`)!;
    label.classList.toggle("invalid", !!errors[f.key]);
    label.querySelector(".error")!.textContent = errors[f.key] ?? "";
  }
}

let session: Session | undefined;
let muted = false;
const latencies: number[] = [];

function setRunning(running: boolean) {
  startBtn.disabled = running;
  stopBtn.disabled = !running;
  muteBtn.disabled = interruptBtn.disabled = !running;
  for (const el of Object.values(inputs)) el.disabled = running;
}

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
  try { await s.stop(); status.textContent = reason ?? "Stopped."; }
  catch (e) { status.textContent = `Stopped locally; upstream close failed: ${(e as Error).message}`; }
  setRunning(false);
  soundBtn.hidden = true;
}

startBtn.onclick = async () => {
  const creds = read();
  const errors = validate(creds);
  showErrors(errors);
  if (Object.keys(errors).length) { status.textContent = "Fix the highlighted fields."; return; }
  try { saveCredentials(localStorage, creds, remember.checked); }
  catch { status.textContent = "Could not save credentials on this device; continuing without remembering."; }

  timeline.replaceChildren(); transcript.replaceChildren(); latencies.length = 0;
  latency.textContent = "Relay + render: —";
  muted = false; muteBtn.textContent = "Mute mic";
  setRunning(true);
  session = new Session(creds, $("#video"), {
    status: t => { status.textContent = t; },
    mark: (label, ms) => {
      const dt = document.createElement("dt"), dd = document.createElement("dd");
      dt.textContent = label; dd.textContent = `${ms} ms`;
      timeline.append(dt, dd);
    },
    latency: ms => {
      latencies.push(ms);
      const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
      latency.textContent = `Relay + render: last ${ms} ms · avg ${avg} ms (${latencies.length} turns)`;
    },
    transcript: renderTranscript,
    autoplayBlocked: () => { soundBtn.hidden = false; },
    ended: reason => void stop(reason),
  });
  try { await session.start(); }
  catch (e) {
    if (e instanceof CancelledError) return; // Stop was pressed; stop() reports the outcome
    const err = e as ApiError;
    if (err.field && SERVER_FIELD[err.field]) showErrors({ [SERVER_FIELD[err.field]]: err.message });
    await stop(`Start failed: ${err.message}`);
  }
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
