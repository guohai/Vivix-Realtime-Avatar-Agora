import { describe, it, expect } from "vitest";
import { mintIdentities, buildJoinBody, joinAgent, leaveAgent, interruptAgent } from "./agora.mjs";

const creds = { appId: "a".repeat(32), certificate: "b".repeat(32) };
const respond = (status, payload) => {
  const calls = [];
  const impl = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(payload), { status }); };
  impl.calls = calls;
  return impl;
};

describe("mintIdentities", () => {
  it("mints a fresh channel, non-overlapping uids and AccessToken2 tokens", () => {
    const ids = mintIdentities(creds);
    expect(ids.channel).toMatch(/^vivix-[0-9a-f]{16}$/);
    expect(ids.userUid).toBeGreaterThanOrEqual(100_000);
    expect(ids.userUid).toBeLessThan(600_000);
    expect(ids.agentUid).toBeGreaterThanOrEqual(600_000);
    expect(ids.agentUid).toBeLessThan(800_000);
    expect(ids.userToken.startsWith("007")).toBe(true);
    expect(ids.agentToken.startsWith("007")).toBe(true);
    expect(ids.userToken).not.toBe(ids.agentToken);
  });
});

describe("buildJoinBody", () => {
  const ids = { channel: "vivix-1", userUid: 111111, agentUid: 666666, agentToken: "atok", userToken: "utok" };

  it("references the pipeline and streams transcripts over the datastream", () => {
    const b = buildJoinBody({ pipelineId: "pipe" }, ids);
    expect(b.name).toBe("vivix-1");
    expect(b.pipeline_id).toBe("pipe");
    expect(b.properties).toEqual({
      channel: "vivix-1",
      token: "atok",
      agent_rtc_uid: "666666",
      remote_rtc_uids: ["111111"],
      idle_timeout: 60,
      turn_detection: { config: {
        start_of_speech: { mode: "vad", vad_config: { interrupt_duration_ms: 160, prefix_padding_ms: 800 } },
        end_of_speech: { mode: "semantic", semantic_config: { silence_duration_ms: 320, max_wait_ms: 3000 } },
      } },
      parameters: { data_channel: "datastream", enable_error_message: true },
    });
  });

  it("overrides the persona only when one is given", () => {
    const b = buildJoinBody({ pipelineId: "pipe", persona: "  Be brief.  " }, ids);
    expect(b.properties.llm).toEqual({ system_messages: [{ role: "system", content: "Be brief." }] });
    expect(buildJoinBody({ pipelineId: "pipe", persona: "   " }, ids).properties.llm).toBeUndefined();
  });
});

describe("joinAgent", () => {
  it("joins with REST auth signed from the certificate and returns the client's identity", async () => {
    const f = respond(200, { agent_id: "ag-1", status: "RUNNING" });
    const s = await joinAgent({ ...creds, pipelineId: "pipe" }, f);
    expect(f.calls[0].url).toBe(`https://api.agora.io/api/conversational-ai-agent/v2/projects/${creds.appId}/join`);
    expect(f.calls[0].init.headers.Authorization).toMatch(/^agora token="007.+"$/);
    const sent = JSON.parse(f.calls[0].init.body);
    expect(s).toEqual({ agentId: "ag-1", appId: creds.appId, channel: sent.name,
      uid: Number(sent.properties.remote_rtc_uids[0]), token: s.token, agentUid: Number(sent.properties.agent_rtc_uid) });
    expect(s.token).not.toBe(sent.properties.token);
  });

  it("surfaces the upstream detail with the certificate redacted", async () => {
    const f = respond(400, { detail: `properties: tts.addon not found for ${creds.certificate}` });
    await expect(joinAgent({ ...creds, pipelineId: "nope" }, f)).rejects.toThrow("ConvoAI: properties: tts.addon not found for <redacted>");
  });

  it("redacts derived tokens echoed by upstream", async () => {
    let agentToken;
    const f = async (url, init) => {
      agentToken = JSON.parse(init.body).properties.token;
      return new Response(JSON.stringify({ detail: `bad token ${agentToken} / ${init.headers.Authorization}` }), { status: 400 });
    };
    const err = await joinAgent({ ...creds, pipelineId: "p" }, f).catch(e => e);
    expect(err.message).toBe("ConvoAI: bad token <redacted> / agora token=\"<redacted>\"");
    expect(err.message).not.toContain(agentToken);
  });

  it("fails when no agent id comes back", async () => {
    await expect(joinAgent({ ...creds, pipelineId: "p" }, respond(200, {}))).rejects.toThrow("no agent id");
  });
});

describe("leaveAgent / interruptAgent", () => {
  it("treats 404 on leave as already stopped", async () => {
    const f = respond(404, { detail: "not found" });
    await expect(leaveAgent({ ...creds, agentId: "ag-1" }, f)).resolves.toBeUndefined();
    expect(f.calls[0].url).toBe(`https://api.agora.io/api/conversational-ai-agent/v2/projects/${creds.appId}/agents/ag-1/leave`);
  });

  it("calls interrupt", async () => {
    const f = respond(200, {});
    await interruptAgent({ ...creds, agentId: "ag-1" }, f);
    expect(f.calls[0].url.endsWith("/agents/ag-1/interrupt")).toBe(true);
  });
});
