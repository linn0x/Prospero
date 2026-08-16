import Foundation

/// The UI-facing representation of the structured `AgentEventBody` protocol.
///
/// This deliberately has no daemon, WebSocket, or `Observable` dependency. A transport can decode
/// a snapshot/event, feed it to `ChatTimeline`, and render the resulting value on any SwiftUI view.
enum ChatEventBody: Sendable, Equatable {
  case userMessage(ChatUserMessage)
  case textDelta(ChatTextDelta)
  case reasoningDelta(ChatReasoningDelta)
  case toolStart(ChatToolStart)
  case toolEnd(ChatToolEnd)
  case permissionRequest(ChatPermissionRequest)
  case permissionAuto(ChatPermissionAuto)
  case permissionResolved(ChatPermissionResolved)
  case questionRequest(ChatQuestionRequest)
  case questionResolved(ChatQuestionResolved)
  case subagentStarted(ChatSubagent)
  case subagentUpdated(ChatSubagentUpdate)
  case turnEnd(ChatTurnEnd)
  case error(ChatAgentError)

  /// Child transcript tokens must never be merged into the parent transcript.
  var agentID: String? {
    switch self {
    case .userMessage(let value): value.agentID
    case .textDelta(let value): value.agentID
    case .reasoningDelta(let value): value.agentID
    case .toolStart(let value): value.agentID
    case .toolEnd(let value): value.agentID
    case .permissionRequest(let value): value.agentID
    case .permissionAuto(let value): value.agentID
    case .permissionResolved(let value): value.agentID
    case .questionRequest(let value): value.agentID
    case .questionResolved(let value): value.agentID
    case .turnEnd(let value): value.agentID
    case .error(let value): value.agentID
    case .subagentStarted, .subagentUpdated: nil
    }
  }
}

struct ChatUserMessage: Sendable, Equatable { var msgID: String; var text: String; var agentID: String? }
struct ChatTextDelta: Sendable, Equatable { var msgID: String; var textID: String; var delta: String; var agentID: String? }
struct ChatReasoningDelta: Sendable, Equatable { var msgID: String; var delta: String; var agentID: String? }
struct ChatDiff: Sendable, Equatable { var path: String; var patch: String; var additions: Int; var deletions: Int; var truncated: Bool }
enum ChatToolState: String, Sendable, Equatable { case running, success, failed }
struct ChatToolStart: Sendable, Equatable { var msgID: String; var callID: String; var tool: String; var summary: String; var diff: ChatDiff?; var agentID: String? }
struct ChatToolEnd: Sendable, Equatable { var callID: String; var state: ChatToolState; var summary: String; var hasMore: Bool; var diff: ChatDiff?; var agentID: String? }
enum ChatPermissionReply: String, Sendable, Equatable { case once, always, reject }
struct ChatPermissionRequest: Sendable, Equatable { var requestID: String; var action: String; var resources: [String]; var summary: String; var diff: ChatDiff?; var agentID: String? }
struct ChatPermissionAuto: Sendable, Equatable { var requestID: String; var action: String; var summary: String; var policy: String; var agentID: String? }
struct ChatPermissionResolved: Sendable, Equatable { var requestID: String; var reply: ChatPermissionReply; var agentID: String? }
struct ChatQuestionOption: Sendable, Equatable { var label: String; var detail: String?; var preview: String? }
struct ChatQuestion: Sendable, Equatable { var id: String; var header: String; var question: String; var options: [ChatQuestionOption]; var multiSelect: Bool; var allowOther: Bool; var secret: Bool }
struct ChatQuestionRequest: Sendable, Equatable { var requestID: String; var questions: [ChatQuestion]; var autoResolutionMs: Int?; var agentID: String? }
struct ChatQuestionAnswer: Sendable, Equatable { var questionID: String; var values: [String] }
struct ChatQuestionResolved: Sendable, Equatable { var requestID: String; var answers: [ChatQuestionAnswer]; var cancelled: Bool; var agentID: String? }
struct ChatSubagent: Sendable, Equatable { var id: String; var name: String; var role: String?; var task: String?; var status: String; var canMessage: Bool; var createdAt: Int; var updatedAt: Int; var preview: String? }
struct ChatSubagentUpdate: Sendable, Equatable { var subagentID: String; var status: String; var canMessage: Bool?; var summary: String? }
struct ChatTurnEnd: Sendable, Equatable { var msgID: String; var finish: String?; var costUSD: Double?; var inputTokens: Int?; var outputTokens: Int?; var agentID: String? }
struct ChatAgentError: Sendable, Equatable { var message: String; var agentID: String? }

struct ChatIncomingEvent: Sendable, Equatable {
  var evSeq: Int
  var body: ChatEventBody
}

struct ChatSnapshot: Sendable, Equatable {
  var evSeq: Int
  var events: [ChatEventBody]
}

/// A checked portion of the daemon's append-only structured-session log.
/// `baseSeq` is the last event the caller had before this response.
struct ChatDelta: Sendable, Equatable {
  var baseSeq: Int
  var evSeq: Int
  var events: [ChatEventBody]
}

/// A deterministic reducer for either the parent conversation or one child conversation.
struct ChatTimeline: Sendable, Equatable {
  enum Scope: Sendable, Equatable { case main; case subagent(String) }
  enum ApplyResult: Sendable, Equatable { case applied; case ignoredDuplicate; case ignoredScope; case gap(expected: Int, received: Int) }
  enum MessageRole: String, Sendable, Equatable { case user, assistant }
  enum PermissionStatus: Sendable, Equatable {
    case pending
    case automatic(policy: String)
    case allowed(ChatPermissionReply)
    case rejected
  }
  enum QuestionStatus: Sendable, Equatable { case pending, answered([ChatQuestionAnswer]), cancelled }

  struct Message: Identifiable, Sendable, Equatable {
    var id: String; var role: MessageRole; var text: String
  }
  struct Reasoning: Identifiable, Sendable, Equatable { var id: String; var text: String }
  struct Tool: Identifiable, Sendable, Equatable {
    var id: String; var title: String; var summary: String; var state: ChatToolState; var hasMore: Bool; var diff: ChatDiff?
    /// Kept outside the event stream: full output is deliberately fetched only after the user asks.
    var fullOutput: String?
    var outputTruncated: Bool
  }
  struct Permission: Identifiable, Sendable, Equatable {
    var id: String; var action: String; var resources: [String]; var summary: String; var diff: ChatDiff?; var status: PermissionStatus
  }
  struct QuestionPrompt: Identifiable, Sendable, Equatable {
    var id: String; var questions: [ChatQuestion]; var status: QuestionStatus
  }
  struct Subagent: Identifiable, Sendable, Equatable {
    var id: String; var name: String; var role: String?; var task: String?; var status: String; var canMessage: Bool; var preview: String?
  }
  struct Turn: Identifiable, Sendable, Equatable {
    var id: String; var finish: String?; var costUSD: Double?; var inputTokens: Int?; var outputTokens: Int?
  }
  struct Failure: Identifiable, Sendable, Equatable { var id: String; var message: String }

  enum Entry: Identifiable, Sendable, Equatable {
    case message(Message)
    case reasoning(Reasoning)
    case tool(Tool)
    case permission(Permission)
    case question(QuestionPrompt)
    case subagent(Subagent)
    case turn(Turn)
    case error(Failure)

    var id: String {
      switch self {
      case .message(let value): value.id
      case .reasoning(let value): value.id
      case .tool(let value): value.id
      case .permission(let value): value.id
      case .question(let value): value.id
      case .subagent(let value): value.id
      case .turn(let value): value.id
      case .error(let value): value.id
      }
    }
  }

  struct ActivityGroup: Identifiable, Sendable, Equatable {
    var id: String
    var entries: [Entry]
  }
  enum PresentationItem: Identifiable, Sendable, Equatable {
    case entry(Entry)
    case collapsedActivities(ActivityGroup)

    var id: String {
      switch self {
      case .entry(let entry): entry.id
      case .collapsedActivities(let group): group.id
      }
    }
  }

  var scope: Scope
  private(set) var evSeq: Int
  private(set) var entries: [Entry]

  init(scope: Scope = .main, evSeq: Int = 0, entries: [Entry] = []) {
    self.scope = scope
    self.evSeq = max(0, evSeq)
    self.entries = entries
  }

  /// Snapshot is authoritative: it replaces UI state even when its sequence is lower than a stale UI.
  mutating func reset(with snapshot: ChatSnapshot) {
    entries.removeAll(keepingCapacity: true)
    for (offset, body) in snapshot.events.enumerated() where accepts(body) {
      reduce(body, identitySeed: offset)
    }
    evSeq = max(0, snapshot.evSeq)
  }

  /// Applies exactly one next event. Duplicates are harmless and a hole is reported to the caller so
  /// it can request a fresh snapshot instead of constructing an invalid transcript.
  @discardableResult
  mutating func apply(_ event: ChatIncomingEvent) -> ApplyResult {
    if event.evSeq <= evSeq { return .ignoredDuplicate }
    let expected = evSeq + 1
    guard event.evSeq == expected else { return .gap(expected: expected, received: event.evSeq) }
    evSeq = event.evSeq
    guard accepts(event.body) else { return .ignoredScope }
    reduce(event.body, identitySeed: event.evSeq)
    return .applied
  }

  /// Stores a user-requested tool payload without inventing a second event model.
  mutating func setToolOutput(callID: String, output: String, truncated: Bool) {
    let id = "tool:\(callID)"
    guard let index = entries.firstIndex(where: { $0.id == id }), case .tool(var tool) = entries[index] else {
      return
    }
    tool.fullOutput = output
    tool.outputTruncated = truncated
    entries[index] = .tool(tool)
  }

  /// Folds only adjacent completed activities. Pending or failed activity remains visible.
  var presentationItems: [PresentationItem] {
    var result: [PresentationItem] = []
    var run: [Entry] = []
    func flush() {
      guard !run.isEmpty else { return }
      if run.count > 1 {
        result.append(.collapsedActivities(ActivityGroup(id: "activity:" + run.map(\.id).joined(separator: ":"), entries: run)))
      } else if let entry = run.first {
        result.append(.entry(entry))
      }
      run.removeAll(keepingCapacity: true)
    }
    for entry in entries {
      if entry.isSuccessfulActivity { run.append(entry) } else { flush(); result.append(.entry(entry)) }
    }
    flush()
    return result
  }

  private func accepts(_ body: ChatEventBody) -> Bool {
    switch scope {
    case .main:
      return body.agentID == nil
    case .subagent(let id):
      switch body {
      case .subagentStarted(let subagent): return subagent.id == id
      case .subagentUpdated(let update): return update.subagentID == id
      default: return body.agentID == id
      }
    }
  }

  private mutating func reduce(_ body: ChatEventBody, identitySeed: Int) {
    switch body {
    case .userMessage(let input):
      let id = "user:\(input.msgID)"
      upsert(.message(Message(id: id, role: .user, text: input.text)))
    case .textDelta(let input):
      guard !input.delta.isEmpty else { return }
      let id = "assistant:\(input.msgID):\(input.textID)"
      if let index = entries.firstIndex(where: { $0.id == id }), case .message(var message) = entries[index] {
        message.text += input.delta; entries[index] = .message(message)
      } else {
        entries.append(.message(Message(id: id, role: .assistant, text: input.delta)))
      }
    case .reasoningDelta(let input):
      guard !input.delta.isEmpty else { return }
      let id = "reasoning:\(input.msgID)"
      if let index = entries.firstIndex(where: { $0.id == id }), case .reasoning(var reasoning) = entries[index] {
        reasoning.text += input.delta; entries[index] = .reasoning(reasoning)
      } else {
        entries.append(.reasoning(Reasoning(id: id, text: input.delta)))
      }
    case .toolStart(let input):
      upsert(.tool(Tool(id: "tool:\(input.callID)", title: input.tool.isEmpty ? "工具调用" : input.tool, summary: input.summary, state: .running, hasMore: false, diff: input.diff, fullOutput: nil, outputTruncated: false)))
    case .toolEnd(let input):
      let id = "tool:\(input.callID)"
      if let index = entries.firstIndex(where: { $0.id == id }), case .tool(var tool) = entries[index] {
        if !input.summary.isEmpty && input.summary != tool.summary {
          tool.summary = tool.summary.isEmpty ? input.summary : "\(tool.summary)\n\(input.summary)"
        }
        tool.state = input.state; tool.hasMore = input.hasMore; tool.diff = input.diff ?? tool.diff
        entries[index] = .tool(tool)
      } else {
        entries.append(.tool(Tool(id: id, title: "工具调用", summary: input.summary, state: input.state, hasMore: input.hasMore, diff: input.diff, fullOutput: nil, outputTruncated: false)))
      }
    case .permissionRequest(let input):
      upsert(.permission(Permission(id: "permission:\(input.requestID)", action: input.action, resources: input.resources, summary: input.summary, diff: input.diff, status: .pending)))
    case .permissionAuto(let input):
      upsert(.permission(Permission(id: "permission:\(input.requestID)", action: input.action, resources: [], summary: input.summary, diff: nil, status: .automatic(policy: input.policy))))
    case .permissionResolved(let input):
      let id = "permission:\(input.requestID)"
      let state: PermissionStatus = input.reply == .reject ? .rejected : .allowed(input.reply)
      if let index = entries.firstIndex(where: { $0.id == id }), case .permission(var permission) = entries[index] {
        permission.status = state; entries[index] = .permission(permission)
      } else {
        entries.append(.permission(Permission(id: id, action: "权限请求", resources: [], summary: "", diff: nil, status: state)))
      }
    case .questionRequest(let input):
      upsert(.question(QuestionPrompt(id: "question:\(input.requestID)", questions: input.questions, status: .pending)))
    case .questionResolved(let input):
      let id = "question:\(input.requestID)"
      let status: QuestionStatus = input.cancelled ? .cancelled : .answered(input.answers)
      if let index = entries.firstIndex(where: { $0.id == id }), case .question(var question) = entries[index] {
        question.status = status; entries[index] = .question(question)
      } else {
        entries.append(.question(QuestionPrompt(id: id, questions: [], status: status)))
      }
    case .subagentStarted(let input):
      upsert(.subagent(Subagent(id: "subagent:\(input.id)", name: input.name, role: input.role, task: input.task, status: input.status, canMessage: input.canMessage, preview: input.preview)))
    case .subagentUpdated(let input):
      let id = "subagent:\(input.subagentID)"
      if let index = entries.firstIndex(where: { $0.id == id }), case .subagent(var subagent) = entries[index] {
        subagent.status = input.status; subagent.canMessage = input.canMessage ?? subagent.canMessage
        subagent.preview = input.summary ?? subagent.preview; entries[index] = .subagent(subagent)
      } else {
        entries.append(.subagent(Subagent(id: id, name: "子 Agent", role: nil, task: nil, status: input.status, canMessage: input.canMessage ?? false, preview: input.summary)))
      }
    case .turnEnd(let input):
      upsert(.turn(Turn(id: "turn:\(input.msgID)", finish: input.finish, costUSD: input.costUSD, inputTokens: input.inputTokens, outputTokens: input.outputTokens)))
    case .error(let input):
      entries.append(.error(Failure(id: "error:\(identitySeed)", message: input.message)))
    }
  }

  private mutating func upsert(_ entry: Entry) {
    if let index = entries.firstIndex(where: { $0.id == entry.id }) { entries[index] = entry } else { entries.append(entry) }
  }
}

private extension ChatTimeline.Entry {
  var isSuccessfulActivity: Bool {
    switch self {
    case .tool(let tool): return tool.state == .success
    case .permission(let permission):
      if case .automatic = permission.status { return true }
      return false
    default: return false
    }
  }
}

/// Strict, Foundation-only decoder for the daemon's JSON protocol. Keeping this at the boundary lets
/// the reducer stay typed and makes malformed daemon data a recoverable error instead of a UI crash.
enum ChatPayloadDecoder {
  struct Failure: LocalizedError, Sendable, Equatable {
    var message: String
    var errorDescription: String? { message }
  }

  static func event(from data: Data) throws -> ChatIncomingEvent {
    let root = try object(data)
    guard try string(root, "type") == "agent.event" else { throw Failure(message: "不是 agent.event") }
    let evSeq = try integer(root, "evSeq")
    guard evSeq >= 0 else { throw Failure(message: "evSeq 不可为负数") }
    return ChatIncomingEvent(evSeq: evSeq, body: try body(try object(root, "body")))
  }

  static func snapshot(from data: Data) throws -> ChatSnapshot {
    let root = try object(data)
    guard try string(root, "type") == "chat.snapshot" else { throw Failure(message: "不是 chat.snapshot") }
    let events = try eventBodies(root)
    let evSeq = try integer(root, "evSeq")
    guard evSeq >= 0 else { throw Failure(message: "evSeq 不可为负数") }
    return ChatSnapshot(evSeq: evSeq, events: events)
  }

  /// Decodes the daemon's native Mac control response. The caller additionally checks the cursor
  /// it asked for; keeping the event parser here ensures snapshot and delta share one schema.
  static func localSnapshot(from data: Data) throws -> ChatSnapshot {
    let root = try object(data)
    guard try string(root, "kind") == "structured", try string(root, "mode") == "snapshot" else {
      throw Failure(message: "不是结构化会话快照")
    }
    let evSeq = try integer(root, "evSeq")
    guard evSeq >= 0 else { throw Failure(message: "evSeq 不可为负数") }
    return ChatSnapshot(evSeq: evSeq, events: try eventBodies(root))
  }

  static func localDelta(from data: Data) throws -> ChatDelta {
    let root = try object(data)
    guard try string(root, "kind") == "structured", try string(root, "mode") == "delta" else {
      throw Failure(message: "不是结构化会话增量")
    }
    let baseSeq = try integer(root, "baseSeq")
    let evSeq = try integer(root, "evSeq")
    guard baseSeq >= 0, evSeq >= baseSeq else { throw Failure(message: "结构化会话游标无效") }
    let events = try eventBodies(root)
    guard events.count == evSeq - baseSeq else {
      throw Failure(message: "结构化会话增量事件数与游标不一致")
    }
    return ChatDelta(baseSeq: baseSeq, evSeq: evSeq, events: events)
  }

  /// The child endpoint has the same event bodies but a smaller envelope.
  static func subagentSnapshot(from data: Data) throws -> ChatSnapshot {
    let root = try object(data)
    let evSeq = try integer(root, "evSeq")
    guard evSeq >= 0 else { throw Failure(message: "子 Agent evSeq 不可为负数") }
    return ChatSnapshot(evSeq: evSeq, events: try eventBodies(root))
  }

  private static func object(_ data: Data) throws -> [String: Any] {
    guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw Failure(message: "JSON 根节点必须是对象") }
    return value
  }
  private static func object(_ value: [String: Any], _ key: String) throws -> [String: Any] {
    guard let object = value[key] as? [String: Any] else { throw Failure(message: "\(key) 必须是对象") }
    return object
  }
  private static func array(_ value: [String: Any], _ key: String) throws -> [Any] {
    guard let array = value[key] as? [Any] else { throw Failure(message: "\(key) 必须是数组") }
    return array
  }
  private static func eventBodies(_ value: [String: Any]) throws -> [ChatEventBody] {
    try array(value, "events").map { raw in
      guard let event = raw as? [String: Any] else { throw Failure(message: "events 包含非对象") }
      return try body(event)
    }
  }
  private static func string(_ value: [String: Any], _ key: String) throws -> String {
    guard let string = value[key] as? String else { throw Failure(message: "\(key) 必须是字符串") }
    return string
  }
  private static func optionalString(_ value: [String: Any], _ key: String) throws -> String? {
    guard let raw = value[key] else { return nil }
    guard let string = raw as? String else { throw Failure(message: "\(key) 必须是字符串") }
    return string
  }
  private static func boolean(_ value: [String: Any], _ key: String) throws -> Bool {
    guard let result = value[key] as? Bool else { throw Failure(message: "\(key) 必须是布尔值") }
    return result
  }
  private static func optionalBoolean(_ value: [String: Any], _ key: String) throws -> Bool? {
    guard value[key] != nil else { return nil }; return try boolean(value, key)
  }
  private static func integer(_ value: [String: Any], _ key: String) throws -> Int {
    guard let number = value[key] as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
          number.doubleValue.rounded() == number.doubleValue else { throw Failure(message: "\(key) 必须是整数") }
    return number.intValue
  }
  private static func optionalInteger(_ value: [String: Any], _ key: String) throws -> Int? {
    guard value[key] != nil else { return nil }; return try integer(value, key)
  }
  private static func optionalDouble(_ value: [String: Any], _ key: String) throws -> Double? {
    guard let raw = value[key] else { return nil }
    guard let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { throw Failure(message: "\(key) 必须是数字") }
    return number.doubleValue
  }
  private static func agentID(_ value: [String: Any]) throws -> String? { try optionalString(value, "agentId") }
  private static func strings(_ value: [String: Any], _ key: String) throws -> [String] { try array(value, key).map { guard let result = $0 as? String else { throw Failure(message: "\(key) 必须只包含字符串") }; return result } }

  private static func diff(_ value: [String: Any]) throws -> ChatDiff? {
    guard let raw = value["diff"] else { return nil }
    guard let object = raw as? [String: Any] else { throw Failure(message: "diff 必须是对象") }
    return try ChatDiff(path: string(object, "path"), patch: string(object, "patch"), additions: integer(object, "additions"), deletions: integer(object, "deletions"), truncated: optionalBoolean(object, "truncated") ?? false)
  }
  private static func questions(_ value: [String: Any]) throws -> [ChatQuestion] {
    try array(value, "questions").map { raw in
      guard let question = raw as? [String: Any] else { throw Failure(message: "question 必须是对象") }
      let options = try array(question, "options").map { raw -> ChatQuestionOption in
        guard let option = raw as? [String: Any] else { throw Failure(message: "option 必须是对象") }
        return try ChatQuestionOption(label: string(option, "label"), detail: optionalString(option, "description"), preview: optionalString(option, "preview"))
      }
      return try ChatQuestion(id: string(question, "id"), header: string(question, "header"), question: string(question, "question"), options: options, multiSelect: boolean(question, "multiSelect"), allowOther: boolean(question, "allowOther"), secret: optionalBoolean(question, "secret") ?? false)
    }
  }
  private static func answers(_ value: [String: Any]) throws -> [ChatQuestionAnswer] {
    try array(value, "answers").map { raw in
      guard let answer = raw as? [String: Any] else { throw Failure(message: "answer 必须是对象") }
      return try ChatQuestionAnswer(questionID: string(answer, "questionId"), values: strings(answer, "values"))
    }
  }
  private static func subagent(_ value: [String: Any]) throws -> ChatSubagent {
    try ChatSubagent(id: string(value, "id"), name: string(value, "name"), role: optionalString(value, "role"), task: optionalString(value, "task"), status: string(value, "status"), canMessage: boolean(value, "canMessage"), createdAt: integer(value, "createdAt"), updatedAt: integer(value, "updatedAt"), preview: optionalString(value, "preview"))
  }

  private static func body(_ value: [String: Any]) throws -> ChatEventBody {
    switch try string(value, "kind") {
    case "user.message": return try .userMessage(ChatUserMessage(msgID: string(value, "msgId"), text: string(value, "text"), agentID: agentID(value)))
    case "text.delta": return try .textDelta(ChatTextDelta(msgID: string(value, "msgId"), textID: string(value, "textId"), delta: string(value, "delta"), agentID: agentID(value)))
    case "reasoning.delta": return try .reasoningDelta(ChatReasoningDelta(msgID: string(value, "msgId"), delta: string(value, "delta"), agentID: agentID(value)))
    case "tool.start": return try .toolStart(ChatToolStart(msgID: string(value, "msgId"), callID: string(value, "callId"), tool: string(value, "tool"), summary: string(value, "summary"), diff: diff(value), agentID: agentID(value)))
    case "tool.end":
      guard let state = ChatToolState(rawValue: try string(value, "state")) else { throw Failure(message: "未知工具状态") }
      return try .toolEnd(ChatToolEnd(callID: string(value, "callId"), state: state, summary: string(value, "summary"), hasMore: optionalBoolean(value, "hasMore") ?? false, diff: diff(value), agentID: agentID(value)))
    case "permission.request": return try .permissionRequest(ChatPermissionRequest(requestID: string(value, "reqId"), action: string(value, "action"), resources: strings(value, "resources"), summary: string(value, "summary"), diff: diff(value), agentID: agentID(value)))
    case "permission.auto": return try .permissionAuto(ChatPermissionAuto(requestID: string(value, "reqId"), action: string(value, "action"), summary: string(value, "summary"), policy: string(value, "policy"), agentID: agentID(value)))
    case "permission.resolved":
      guard let reply = ChatPermissionReply(rawValue: try string(value, "reply")) else { throw Failure(message: "未知审批回答") }
      return try .permissionResolved(ChatPermissionResolved(requestID: string(value, "reqId"), reply: reply, agentID: agentID(value)))
    case "question.request": return try .questionRequest(ChatQuestionRequest(requestID: string(value, "reqId"), questions: questions(value), autoResolutionMs: optionalInteger(value, "autoResolutionMs"), agentID: agentID(value)))
    case "question.resolved": return try .questionResolved(ChatQuestionResolved(requestID: string(value, "reqId"), answers: answers(value), cancelled: optionalBoolean(value, "cancelled") ?? false, agentID: agentID(value)))
    case "subagent.started": return try .subagentStarted(subagent(try object(value, "subagent")))
    case "subagent.updated": return try .subagentUpdated(ChatSubagentUpdate(subagentID: string(value, "subagentId"), status: string(value, "status"), canMessage: optionalBoolean(value, "canMessage"), summary: optionalString(value, "summary")))
    case "turn.end": return try .turnEnd(ChatTurnEnd(msgID: string(value, "msgId"), finish: optionalString(value, "finish"), costUSD: optionalDouble(value, "costUsd"), inputTokens: optionalInteger(value, "inputTokens"), outputTokens: optionalInteger(value, "outputTokens"), agentID: agentID(value)))
    case "agent.error": return try .error(ChatAgentError(message: string(value, "message"), agentID: agentID(value)))
    default: throw Failure(message: "未知 Agent 事件")
    }
  }
}
