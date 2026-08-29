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

  @Test("distinguishes generic feedback lineage from a real failure")
  func supersededTask() {
    let parent = OrchestrationStatus.Task(
      id: "old", runId: "run", title: "old", spec: "", deps: [],
      parentId: nil, status: "failed", result: "typed feedback", createdAt: 1, updatedAt: 2
    )
    let replacement = OrchestrationStatus.Task(
      id: "new", runId: "run", title: "new", spec: "", deps: [],
      parentId: "old", status: "pending", result: nil, createdAt: 3, updatedAt: 3
    )
    #expect(runGraphTaskWasSuperseded(task: parent, all: [parent, replacement]))
  }

  @Test("keeps an unrelated failed task red")
  func genuineFailure() {
    let task = OrchestrationStatus.Task(
      id: "failed", runId: "run", title: "failed", spec: "", deps: [],
      parentId: nil, status: "failed", result: "compiler crashed", createdAt: 1, updatedAt: 2
    )
    #expect(!runGraphTaskWasSuperseded(task: task, all: [task]))
  }
}
