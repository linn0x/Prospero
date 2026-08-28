import Testing
@testable import ProsperoShell

@Suite("Run graph lineage semantics")
struct RunGraphLayoutTests {
  @Test("labels the generic typed feedback protocol")
  func feedbackLabel() {
    #expect(
      runGraphLineageLabel(parentResult: "TYPED_FEEDBACK_REPLAN:any-payload")
        == "反馈重规划"
    )
  }

  @Test("labels retries without understanding task semantics")
  func retryLabel() {
    #expect(runGraphLineageLabel(parentResult: "dispatch retry attempt=2") == "重试")
  }

  @Test("uses a neutral label for other parent-child lineage")
  func derivedTaskLabel() {
    #expect(runGraphLineageLabel(parentResult: "ordinary result") == "派生任务")
  }

  @Test("centers entry content in the full graph height")
  func centersEntryContent() {
    let offset = runGraphCenteredOffset(containerHeight: 500, contentHeight: 70)
    #expect(offset == 215)
    #expect(offset + 35 == 250)
  }
}
