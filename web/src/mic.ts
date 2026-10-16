// Microphone choice. "" means the system default; otherwise a MediaDeviceInfo.deviceId, kept in
// localStorage on this device (a device id, not a credential).
export const MIC_STORAGE_KEY = "vivix-convoai-demo.microphone";

type Device = Pick<MediaDeviceInfo, "deviceId" | "label">;
export interface MicOption { id: string; label: string }

// Chrome adds "default" and "communications" aliases of real devices; the first option covers them.
const ALIASES = new Set(["", "default", "communications"]);

export function micOptions(devices: Device[], savedId: string): { options: MicOption[]; selected: string } {
  const real = devices.filter(d => !ALIASES.has(d.deviceId));
  const options = [
    { id: "", label: "System default" },
    ...real.map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` })),
  ];
  return { options, selected: options.some(o => o.id === savedId) ? savedId : "" };
}

// Browsers hide device labels (and often ids) until microphone permission has been granted.
export const labelsHidden = (devices: Device[]) => !devices.some(d => d.label);
