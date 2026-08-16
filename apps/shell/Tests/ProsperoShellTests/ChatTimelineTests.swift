@testable import ProsperoShell
import XCTest

final class ChatTimelineTests: XCTestCase {
  func testMergesConsecutiveTextReasoningAndToolEvents() {
    var timeline = ChatTimeline()
    XCTAssertEqual(timeline.apply(.init(evSeq: 1, body: .userMessage(.init(msgID: "u", text: "hello", agentID: nil)))), .applied)
    XCTAssertEqual(timeline.apply(.init(evSeq: 2, body: .textDelta(.init(msgID: "a", textID: "part", delta: "Hel", agentID: nil)))), .applied)
    XCTAssertEqual(timeline.apply(.init(evSeq: 3, body: .textDelta(.init(msgID: "a", textID: "part", delta: "lo", agentID: nil)))), .applied)
    XCTAssertEqual(timeline.apply(.init(evSeq: 4, body: .reasoningDelta(.init(msgID: "a", delta: "think", agentID: nil)))), .applied)
    XCTAssertEqual(timeline.apply(.init(evSeq: 5, body: .reasoningDelta(.init(msgID: "a", delta: " more", agentID: nil)))), .applied)
    XCTAssertEqual(timeline.apply(.init(evSeq: 6, body: .toolStart(.init(msgID: "a", callID: "call", tool: "shell", summary: "pwd", diff: nil, agentID: nil)))), .applied)
    XCTAssertEqual(timeline.apply(.init(evSeq: 7, body: .toolEnd(.init(callID: "call", state: .success, summary: "ok", hasMore: true, diff: nil, agentID: nil)))), .applied)

    XCTAssertEqual(timeline.entries.count, 4)
    XCTAssertEqual(message(id: "assistant:a:part", in: timeline)?.text, "Hello")
    XCTAssertEqual(reasoning(id: "reasoning:a", in: timeline)?.text, "think more")
    XCTAssertEqual(tool(id: "tool:call", in: timeline)?.state, .success)
    XCTAssertEqual(tool(id: "tool:call", in: timeline)?.hasMore, true)
  }

  func testSnapshotResetThenDeltaAndDuplicateAreDeterministic() {
    var timeline = ChatTimeline()
    timeline.reset(with: .init(evSeq: 7, events: [
      .textDelta(.init(msgID: "old", textID: "old", delta: "snapshot", agentID: nil)),
    ]))
    XCTAssertEqual(timeline.evSeq, 7)
    XCTAssertEqual(timeline.apply(.init(evSeq: 8, body: .textDelta(.init(msgID: "old", textID: "old", delta: " + delta", agentID: nil)))), .applied)
    XCTAssertEqual(timeline.apply(.init(evSeq: 8, body: .textDelta(.init(msgID: "old", textID: "old", delta: " duplicated", agentID: nil)))), .ignoredDuplicate)
    XCTAssertEqual(message(id: "assistant:old:old", in: timeline)?.text, "snapshot + delta")

    timeline.reset(with: .init(evSeq: 2, events: [.userMessage(.init(msgID: "new", text: "fresh", agentID: nil))]))
    XCTAssertEqual(timeline.evSeq, 2)
    XCTAssertEqual(timeline.entries.count, 1)
    XCTAssertEqual(message(id: "user:new", in: timeline)?.text, "fresh")
  }

  func testReportsSequenceGapsWithoutMutatingTimeline() {
    var timeline = ChatTimeline()
    let result = timeline.apply(.init(evSeq: 2, body: .error(.init(message: "late", agentID: nil))))
    XCTAssertEqual(result, .gap(expected: 1, received: 2))
    XCTAssertEqual(timeline.evSeq, 0)
    XCTAssertTrue(timeline.entries.isEmpty)
    XCTAssertEqual(timeline.apply(.init(evSeq: 1, body: .error(.init(message: "now", agentID: nil)))), .applied)
  }

  func testMainTimelineDoesNotMixChildTokensButChildScopeDoes() {
    let childText = ChatEventBody.textDelta(.init(msgID: "child", textID: "child", delta: "private work", agentID: "child-1"))
    var main = ChatTimeline()
    XCTAssertEqual(main.apply(.init(evSeq: 1, body: childText)), .ignoredScope)
    XCTAssertTrue(main.entries.isEmpty)
    XCTAssertEqual(main.apply(.init(evSeq: 2, body: .subagentStarted(.init(id: "child-1", name: "reviewer", role: nil, task: nil, status: "running", canMessage: true, createdAt: 0, updatedAt: 0, preview: nil)))), .applied)
    XCTAssertNotNil(main.entries.first(where: { $0.id == "subagent:child-1" }))

    var child = ChatTimeline(scope: .subagent("child-1"))
    XCTAssertEqual(child.apply(.init(evSeq: 1, body: childText)), .applied)
    XCTAssertEqual(message(id: "assistant:child:child", in: child)?.text, "private work")
  }

  func testResolvedPermissionAndQuestionReplacePendingState() {
    var timeline = ChatTimeline()
    XCTAssertEqual(timeline.apply(.init(evSeq: 1, body: .permissionRequest(.init(requestID: "p", action: "edit", resources: ["a.swift"], summary: "change", diff: nil, agentID: nil)))), .applied)
    XCTAssertEqual(timeline.apply(.init(evSeq: 2, body: .permissionResolved(.init(requestID: "p", reply: .always, agentID: nil)))), .applied)
    XCTAssertEqual(permission(id: "permission:p", in: timeline)?.status, .allowed(.always))

    let promptQuestion = ChatQuestion(id: "choice", header: "Mode", question: "Continue?", options: [], multiSelect: false, allowOther: false, secret: false)
    XCTAssertEqual(timeline.apply(.init(evSeq: 3, body: .questionRequest(.init(requestID: "q", questions: [promptQuestion], autoResolutionMs: nil, agentID: nil)))), .applied)
    XCTAssertEqual(timeline.apply(.init(evSeq: 4, body: .questionResolved(.init(requestID: "q", answers: [.init(questionID: "choice", values: ["Yes"])], cancelled: false, agentID: nil)))), .applied)
    XCTAssertEqual(question(id: "question:q", in: timeline)?.status, .answered([.init(questionID: "choice", values: ["Yes"])]))
  }

  func testReducerCoversAllFourteenEventBodies() {
    let coverageQuestion = ChatQuestion(id: "q1", header: "", question: "Pick", options: [], multiSelect: false, allowOther: false, secret: false)
    let child = ChatSubagent(id: "child", name: "builder", role: "implement", task: "work", status: "starting", canMessage: true, createdAt: 1, updatedAt: 1, preview: nil)
    let events: [ChatEventBody] = [
      .userMessage(.init(msgID: "u", text: "go", agentID: nil)),
      .textDelta(.init(msgID: "a", textID: "text", delta: "answer", agentID: nil)),
      .reasoningDelta(.init(msgID: "a", delta: "reason", agentID: nil)),
      .toolStart(.init(msgID: "a", callID: "tool", tool: "bash", summary: "run", diff: nil, agentID: nil)),
      .toolEnd(.init(callID: "tool", state: .success, summary: "done", hasMore: false, diff: nil, agentID: nil)),
      .permissionRequest(.init(requestID: "permit", action: "edit", resources: [], summary: "", diff: nil, agentID: nil)),
      .permissionAuto(.init(requestID: "auto", action: "read", summary: "", policy: "standard", agentID: nil)),
      .permissionResolved(.init(requestID: "permit", reply: .once, agentID: nil)),
      .questionRequest(.init(requestID: "question", questions: [coverageQuestion], autoResolutionMs: nil, agentID: nil)),
      .questionResolved(.init(requestID: "question", answers: [], cancelled: false, agentID: nil)),
      .subagentStarted(child),
      .subagentUpdated(.init(subagentID: "child", status: "completed", canMessage: false, summary: "finished")),
      .turnEnd(.init(msgID: "a", finish: "completed", costUSD: 0.01, inputTokens: 1, outputTokens: 2, agentID: nil)),
      .error(.init(message: "recoverable", agentID: nil)),
    ]
    var timeline = ChatTimeline()
    for (index, event) in events.enumerated() { XCTAssertEqual(timeline.apply(.init(evSeq: index + 1, body: event)), .applied) }
    XCTAssertEqual(timeline.evSeq, 14)
    XCTAssertEqual(tool(id: "tool:tool", in: timeline)?.state, .success)
    XCTAssertEqual(permission(id: "permission:permit", in: timeline)?.status, .allowed(.once))
    XCTAssertEqual(question(id: "question:question", in: timeline)?.status, .answered([]))
    XCTAssertEqual(subagent(id: "subagent:child", in: timeline)?.status, "completed")
    XCTAssertNotNil(timeline.entries.first(where: { if case .turn = $0 { return true }; return false }))
    XCTAssertNotNil(timeline.entries.first(where: { if case .error = $0 { return true }; return false }))
  }

  func testMalformedPayloadFailsAtDecoderBoundary() {
    let missingDelta = Data(#"{"type":"agent.event","evSeq":1,"body":{"kind":"text.delta","msgId":"m","textId":"t"}}"#.utf8)
    let invalidState = Data(#"{"type":"agent.event","evSeq":1,"body":{"kind":"tool.end","callId":"c","state":"unknown","summary":""}}"#.utf8)
    let malformedSnapshot = Data(#"{"type":"chat.snapshot","evSeq":1,"events":[null]}"#.utf8)
    XCTAssertThrowsError(try ChatPayloadDecoder.event(from: missingDelta))
    XCTAssertThrowsError(try ChatPayloadDecoder.event(from: invalidState))
    XCTAssertThrowsError(try ChatPayloadDecoder.snapshot(from: malformedSnapshot))
  }

  private func message(id: String, in timeline: ChatTimeline) -> ChatTimeline.Message? {
    guard let entry = timeline.entries.first(where: { $0.id == id }), case .message(let value) = entry else { return nil }; return value
  }
  private func reasoning(id: String, in timeline: ChatTimeline) -> ChatTimeline.Reasoning? {
    guard let entry = timeline.entries.first(where: { $0.id == id }), case .reasoning(let value) = entry else { return nil }; return value
  }
  private func tool(id: String, in timeline: ChatTimeline) -> ChatTimeline.Tool? {
    guard let entry = timeline.entries.first(where: { $0.id == id }), case .tool(let value) = entry else { return nil }; return value
  }
  private func permission(id: String, in timeline: ChatTimeline) -> ChatTimeline.Permission? {
    guard let entry = timeline.entries.first(where: { $0.id == id }), case .permission(let value) = entry else { return nil }; return value
  }
  private func question(id: String, in timeline: ChatTimeline) -> ChatTimeline.QuestionPrompt? {
    guard let entry = timeline.entries.first(where: { $0.id == id }), case .question(let value) = entry else { return nil }; return value
  }
  private func subagent(id: String, in timeline: ChatTimeline) -> ChatTimeline.Subagent? {
    guard let entry = timeline.entries.first(where: { $0.id == id }), case .subagent(let value) = entry else { return nil }; return value
  }
}
