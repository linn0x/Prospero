import { describe, expect, it, vi } from "vitest";
import { RustRuntime } from "../src/main/rust-runtime";
function runtime(client: object) {
  return Object.assign(Object.create(RustRuntime.prototype), {
    controller: new AbortController(), current: () => ({ client }), refresh: vi.fn(async () => {}),
  }) as RustRuntime;
}
describe("Rust bridge parity with master", () => {
  it.each(["engine", "protocol"])("forwards validated %s account probes without leaking unknown fields", async scope => {
    const result = { type: "agent.account.result", requestId: "probe", engineValidation: { status: "passed" } };
    const accountControl = vi.fn(async () => result); const r = runtime({accountControl});
    expect(await r.request("/_prospero/control/accounts", {method: "POST",body: {type: "agent.account.api.test",requestId: "probe",accountId: "profile-1", scope, ignored: "extra"}})).toEqual(result);
    expect(accountControl.mock.calls[0]?.[0]).toEqual({type: "agent.account.api.test",requestId: "probe",accountId: "profile-1",scope});
  });
  it.each(["anthropic", "openai_responses", "openai_chat_completions"])("forwards draft model catalog protocol %s", async protocol => {
    const accountFeature = vi.fn(async () => ({models:[]})); const r = runtime({accountFeature});
    await r.request("/_prospero/control/accounts", {method:"POST",body:{type:"agent.account.api.models.get",requestId:"models",baseUrl:"https://example.invalid/v1",apiKey:"test-key",protocol}});
    expect(accountFeature.mock.calls[0]?.[0]).toMatchObject({protocol});
  });
  it("preserves unsupported-scope validation", async () => {
    const accountControl=vi.fn();const r=runtime({accountControl});
    await expect(r.request("/_prospero/control/accounts",{method:"POST",body:{type:"agent.account.api.test",requestId:"probe",accountId:"profile-1",scope:"bogus"}})).rejects.toThrow("连接测试范围无效");
    expect(accountControl).not.toHaveBeenCalled();
  });
  it("routes the legacy schedule action entry point to Rust schedule APIs", async () => {
    const schedules=vi.fn(async()=>[{id:"s"}]); const pauseSchedule=vi.fn(async()=>({id:"s",status:"PAUSED"}));const r=runtime({schedules,pauseSchedule});
    expect(await r.request("/_prospero/control/orchestration/action",{method:"POST",body:{method:"schedule.list",params:{}}})).toEqual([{id:"s"}]);
    expect(await r.request("/_prospero/control/orchestration/action",{method:"POST",body:{method:"schedule.pause",params:{id:"s"}}})).toMatchObject({id:"s",status:"PAUSED"});
    expect(pauseSchedule).toHaveBeenCalledWith("s",expect.any(AbortSignal));
  });
});
