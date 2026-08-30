import CoreGraphics
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

  @Test("fits very large graphs below the old 35 percent floor")
  func fitsWholeLargeGraph() {
    let scale = runGraphFitScale(
      content: CGSize(width: 48_000, height: 96_000),
      viewport: CGSize(width: 1_200, height: 600)
    )
    #expect(scale == 0.00625)
    #expect(96_000 * scale == 600)
  }

  @Test("maps pan and zoom back to a content-space viewport")
  func visibleContentRect() {
    let rect = runGraphVisibleRect(
      viewport: CGSize(width: 800, height: 500),
      pan: CGSize(width: -300, height: -120),
      zoom: 2,
      overscan: 20
    )
    #expect(rect.origin.x == 130)
    #expect(rect.origin.y == 40)
    #expect(rect.width == 440)
    #expect(rect.height == 290)
    #expect(rect.contains(CGPoint(x: 150, y: 60)))
    #expect(!rect.contains(CGPoint(x: 900, y: 900)))
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
