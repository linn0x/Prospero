import Foundation

/// A terminal attaches with one ANSI snapshot, then consumes raw PTY output by cursor. Replaying a
/// full snapshot for every prompt update destroys xterm selection/scroll state and feels unlike a
/// local shell, so deltas are a first-class frame rather than an implementation detail.
enum LocalSessionFrame: Sendable, Equatable {
  case terminalSnapshot(seq: Int, ansi: String, cols: Int, rows: Int)
  case terminalDelta(baseSeq: Int, seq: Int, dataB64: String)

  var seq: Int {
    switch self {
    case .terminalSnapshot(let seq, _, _, _): seq
    case .terminalDelta(_, let seq, _): seq
    }
  }

  static func decodeTerminal(_ data: Data, requestedAfterSeq: Int?) throws -> LocalSessionFrame {
    guard
      let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      root["kind"] as? String == "pty"
    else {
      throw LocalSessionControlFailure("daemon 返回了不完整的终端画面")
    }
    if root["mode"] as? String == "delta" {
      guard
        let requestedAfterSeq,
        let baseSeq = root["baseSeq"] as? Int,
        let seq = root["seq"] as? Int,
        let dataB64 = root["dataB64"] as? String,
        baseSeq == requestedAfterSeq,
        seq > baseSeq,
        Data(base64Encoded: dataB64) != nil
      else {
        throw LocalSessionControlFailure("daemon 返回了不连续的终端增量")
      }
      return .terminalDelta(baseSeq: baseSeq, seq: seq, dataB64: dataB64)
    }
    guard let ansi = root["ansi"] as? String else {
      throw LocalSessionControlFailure("daemon 返回了不完整的终端快照")
    }
    return .terminalSnapshot(
      seq: root["seq"] as? Int ?? 0,
      ansi: ansi,
      cols: root["cols"] as? Int ?? 120,
      rows: root["rows"] as? Int ?? 40
    )
  }
}

/// Checked response to the structured `afterSeq` contract. A delta can only be applied to the
/// cursor used in the request; every other case is an authoritative snapshot (including restart).
enum LocalStructuredFrame: Sendable, Equatable {
  case snapshot(ChatSnapshot)
  case delta(ChatDelta)

  static func decode(_ data: Data, requestedAfterSeq: Int) throws -> LocalStructuredFrame {
    guard requestedAfterSeq >= 0 else {
      throw LocalSessionControlFailure("结构化会话游标无效")
    }
    guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          root["kind"] as? String == "structured",
          let mode = root["mode"] as? String else {
      throw LocalSessionControlFailure("daemon 返回了无法识别的结构化会话")
    }
    switch mode {
    case "snapshot":
      // Snapshot intentionally accepts a lower evSeq. It is how a daemon restart replaces a
      // stale in-memory timeline without leaving a mixed transcript on screen.
      return .snapshot(try ChatPayloadDecoder.localSnapshot(from: data))
    case "delta":
      let delta = try ChatPayloadDecoder.localDelta(from: data)
      guard delta.baseSeq == requestedAfterSeq else {
        throw LocalSessionControlFailure("结构化会话增量的 baseSeq 与请求游标不一致")
      }
      return .delta(delta)
    default:
      throw LocalSessionControlFailure("daemon 返回了未知的结构化会话模式")
    }
  }
}

struct LocalToolOutput: Sendable, Equatable {
  let output: String
  let truncated: Bool

  static func decode(_ data: Data) throws -> LocalToolOutput {
    guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let output = root["output"] as? String else {
      throw LocalSessionControlFailure("daemon 返回了无法识别的工具输出")
    }
    return LocalToolOutput(output: output, truncated: root["truncated"] as? Bool ?? false)
  }
}

struct LocalSessionControlFailure: LocalizedError, Sendable, Equatable {
  let message: String

  init(_ message: String) {
    self.message = message
  }

  var errorDescription: String? { message }
}

extension DaemonController {
  /// Used once when the daemon identity changes. A PID change is the only safe time to replace a
  /// timeline even if its numerical cursor happens to be the same after persistence recovery.
  func loadLocalStructuredSnapshot(id: String) async throws -> ChatSnapshot {
    let (data, response) = try await performLocalSessionRead(id: id, endpoint: "view", query: [])
    guard (200..<300).contains(response.statusCode) else {
      throw LocalSessionControlFailure(controlErrorMessage(data, fallback: "daemon 拒绝读取会话"))
    }
    return try ChatPayloadDecoder.localSnapshot(from: data)
  }

  /// `nil` means HTTP 204: the requested cursor is still current and the caller must not redraw.
  func loadLocalStructuredFrame(id: String, afterSeq: Int) async throws -> LocalStructuredFrame? {
    guard afterSeq >= 0 else { throw LocalSessionControlFailure("结构化会话游标无效") }
    let (data, response) = try await performLocalSessionRead(
      id: id,
      endpoint: "view",
      query: [URLQueryItem(name: "afterSeq", value: String(afterSeq))]
    )
    if response.statusCode == 204 { return nil }
    guard (200..<300).contains(response.statusCode) else {
      throw LocalSessionControlFailure(controlErrorMessage(data, fallback: "daemon 拒绝读取会话"))
    }
    return try LocalStructuredFrame.decode(data, requestedAfterSeq: afterSeq)
  }

  /// The first read is an authoritative snapshot. Later reads are authenticated local long polls:
  /// a new daemon returns raw output immediately, while an older daemon safely falls back to the
  /// legacy knownSeq snapshot contract instead of busy-looping.
  func loadLocalTerminalFrame(id: String, afterSeq: Int?) async throws -> LocalSessionFrame? {
    var query: [URLQueryItem] = []
    if let afterSeq {
      query.append(URLQueryItem(name: "knownSeq", value: String(afterSeq)))
      query.append(URLQueryItem(name: "outputAfterSeq", value: String(afterSeq)))
      query.append(URLQueryItem(name: "waitMs", value: "15000"))
    }
    let (data, response) = try await performLocalSessionRead(id: id, endpoint: "view", query: query)
    if response.statusCode == 204 { return nil }
    guard (200..<300).contains(response.statusCode) else {
      throw LocalSessionControlFailure(controlErrorMessage(data, fallback: "daemon 拒绝读取终端"))
    }
    return try LocalSessionFrame.decodeTerminal(data, requestedAfterSeq: afterSeq)
  }

  /// Tool payloads are intentionally loaded only when a user expands a truncated tool card.
  func loadLocalToolOutput(id: String, callID: String) async throws -> LocalToolOutput {
    let (data, response) = try await performLocalSessionRead(
      id: id,
      endpoint: "tool-output",
      query: [URLQueryItem(name: "callId", value: callID)]
    )
    guard (200..<300).contains(response.statusCode) else {
      throw LocalSessionControlFailure(controlErrorMessage(data, fallback: "无法读取完整工具输出"))
    }
    return try LocalToolOutput.decode(data)
  }

  /// Child details share the same reducer as their parent, but are read from the daemon's isolated
  /// child endpoint so child tokens never contaminate the parent timeline.
  func loadLocalSubagentSnapshot(sessionID: String, subagentID: String) async throws -> ChatSnapshot {
    guard let running, !running.controlToken.isEmpty else {
      throw LocalSessionControlFailure("daemon 尚未提供本机控制接口")
    }
    let encodedSession = sessionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionID
    let encodedSubagent = subagentID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? subagentID
    guard let url = URL(
      string: "http://127.0.0.1:\(running.port)/_prospero/control/session/\(encodedSession)/subagent/\(encodedSubagent)/events"
    ) else {
      throw LocalSessionControlFailure("无法构造子 Agent 事件地址")
    }
    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.setValue("Bearer \(running.controlToken)", forHTTPHeaderField: "Authorization")
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      throw LocalSessionControlFailure(controlErrorMessage(data, fallback: "无法读取子 Agent 过程"))
    }
    return try ChatPayloadDecoder.subagentSnapshot(from: data)
  }

  func sendLocalChat(id: String, text: String) async -> String? {
    await performLocalSessionInteraction(id: id, body: ["type": "chat.send", "text": text])
  }

  func sendLocalTerminalInput(id: String, dataB64: String) async -> String? {
    await performLocalSessionInteraction(id: id, body: ["type": "term.input", "dataB64": dataB64])
  }

  func resizeLocalTerminal(id: String, cols: Int, rows: Int) async -> String? {
    await performLocalSessionInteraction(id: id, body: ["type": "term.resize", "cols": cols, "rows": rows])
  }

  func respondLocalPermission(id: String, requestID: String, reply: String) async -> String? {
    await performLocalSessionInteraction(id: id, body: ["type": "permission.respond", "reqId": requestID, "reply": reply])
  }

  func respondLocalQuestion(
    id: String,
    requestID: String,
    answers: [(questionID: String, values: [String])],
    cancelled: Bool = false
  ) async -> String? {
    let payload = answers.map { ["questionId": $0.questionID, "values": $0.values] as [String: Any] }
    return await performLocalSessionInteraction(
      id: id,
      body: ["type": "question.respond", "reqId": requestID, "answers": payload, "cancelled": cancelled]
    )
  }

  private func performLocalSessionRead(
    id: String,
    endpoint: String,
    query: [URLQueryItem]
  ) async throws -> (Data, HTTPURLResponse) {
    guard var request = localSessionRequest(id: id, endpoint: endpoint, method: "GET") else {
      throw LocalSessionControlFailure("daemon 尚未提供本机会话接口")
    }
    if !query.isEmpty, var components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false) {
      components.queryItems = query
      request.url = components.url
    }
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw LocalSessionControlFailure("daemon 没有返回 HTTP 状态")
    }
    return (data, http)
  }

  private func localSessionRequest(id: String, endpoint: String, method: String) -> URLRequest? {
    guard let running, !running.controlToken.isEmpty else { return nil }
    let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
    guard let url = URL(
      string: "http://127.0.0.1:\(running.port)/_prospero/control/session/\(encoded)/\(endpoint)"
    ) else { return nil }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.setValue("Bearer \(running.controlToken)", forHTTPHeaderField: "Authorization")
    return request
  }

  private func performLocalSessionInteraction(id: String, body: [String: Any]) async -> String? {
    guard var request = localSessionRequest(id: id, endpoint: "interact", method: "POST") else {
      return "daemon 尚未提供本机会话接口"
    }
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    do {
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
      let (data, response) = try await URLSession.shared.data(for: request)
      guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
        return controlErrorMessage(data, fallback: "daemon 拒绝了这次会话操作")
      }
      return nil
    } catch {
      return error.localizedDescription
    }
  }

  private func controlErrorMessage(_ data: Data, fallback: String) -> String {
    let message = String(decoding: data, as: UTF8.self)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return message.isEmpty ? fallback : message
  }
}
