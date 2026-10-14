// ConvoAI publishes transcripts over the RTC datastream as "<id>|<part>|<total>|<base64 JSON>"
// chunks. User lines carry `final`; agent lines carry `turn_status` (0 in progress, 1 done,
// 2 interrupted).
export interface ConvoMessage { object?: string; text?: string; final?: boolean; turn_id?: number; turn_status?: number }
export interface Line { role: "user" | "agent"; turnId: number; text: string; final: boolean }

export function createAssembler(): (data: Uint8Array) => ConvoMessage | null {
  const pending = new Map<string, string[]>();
  const decoder = new TextDecoder();
  return data => {
    const parts = decoder.decode(data).split("|");
    if (parts.length !== 4) return null;
    const [id, idx, total, chunk] = parts;
    const i = Number(idx), n = Number(total);
    if (!(i >= 1 && i <= n && n <= 1000)) return null;
    const chunks = pending.get(id) ?? new Array<string>(n);
    chunks[i - 1] = chunk;
    pending.set(id, chunks);
    if (chunks.filter(c => c !== undefined).length < n) return null;
    pending.delete(id);
    try {
      const bytes = Uint8Array.from(atob(chunks.join("")), ch => ch.charCodeAt(0));
      return JSON.parse(decoder.decode(bytes)) as ConvoMessage;
    } catch { return null; }
  };
}

export function applyMessage(lines: Line[], msg: ConvoMessage): Line[] {
  const role = msg.object === "user.transcription" ? "user" : msg.object === "assistant.transcription" ? "agent" : null;
  if (!role || typeof msg.text !== "string") return lines;
  const turnId = msg.turn_id ?? -1;
  const final = role === "user" ? msg.final === true : msg.turn_status !== undefined && msg.turn_status !== 0;
  const line: Line = { role, turnId, text: msg.text, final };
  const at = lines.findIndex(l => l.role === role && l.turnId === turnId);
  if (at === -1) return [...lines, line];
  return lines.map((l, i) => (i === at ? line : l));
}

// The agent's text arrives as the LLM writes it, ~2–3 s before the avatar speaks it (TTS plus
// Vivix rendering). Agent turns stay hidden until revealed, so the text follows the voice.
export function visibleLines(lines: Line[], revealed: ReadonlySet<number>): Line[] {
  return lines.filter(l => l.role === "user" || revealed.has(l.turnId));
}

// Decides when each agent turn's text may show. Turns are revealed in arrival order as the
// avatar starts speaking; if the avatar starts before the text arrives, that one head start
// reveals the next turn at once. force() covers turns the avatar never speaks.
export class TurnRevealer {
  readonly revealed = new Set<number>();
  private pending: number[] = [];
  private headStart = false;

  /** Returns true the first time a turn is seen. */
  agentTurn(id: number): boolean {
    if (this.revealed.has(id) || this.pending.includes(id)) return false;
    if (this.headStart) { this.headStart = false; this.revealed.add(id); }
    else this.pending.push(id);
    return true;
  }

  avatarStarted(): void {
    const id = this.pending.shift();
    if (id === undefined) this.headStart = true;
    else this.revealed.add(id);
  }

  force(id: number): void {
    this.pending = this.pending.filter(p => p !== id);
    this.revealed.add(id);
  }
}
