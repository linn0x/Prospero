import Foundation

/// Mac 工作台从 daemon 本机控制面取得的单帧。结构化会话返回完整事件快照，
/// PTY 返回可直接重放给 xterm 的 ANSI 画面；`seq` 用来让无变化轮询走 204。
enum LocalSessionFrame: Sendable, Equatable {
  case structured(seq: Int, payload: Data)
  case terminal(seq: Int, ansi: String, cols: Int, rows: Int)

  var seq: Int {
    switch self {
    case .structured(let seq, _), .terminal(let seq, _, _, _): seq
    }
  }

  static func decode(_ data: Data) throws -> LocalSessionFrame {
    guard
      let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      let kind = root["kind"] as? String
    else {
      throw LocalSessionControlFailure("daemon 返回了无法识别的会话画面")
    }
    let seq = root["seq"] as? Int ?? 0
    if kind == "structured" {
      return .structured(seq: seq, payload: data)
    }
    guard kind == "pty", let ansi = root["ansi"] as? String else {
      throw LocalSessionControlFailure("daemon 返回了不完整的终端画面")
    }
    return .terminal(
      seq: seq,
      ansi: ansi,
      cols: root["cols"] as? Int ?? 120,
      rows: root["rows"] as? Int ?? 40
    )
  }
}

struct LocalPermissionPrompt: Identifiable, Sendable, Equatable {
  var id: String { requestID }
  let requestID: String
  let action: String
  let summary: String
  let resources: [String]
}

struct LocalAgentQuestionOption: Identifiable, Sendable, Equatable {
  var id: String { label }
  let label: String
  let detail: String?
}

struct LocalAgentQuestion: Identifiable, Sendable, Equatable {
  let id: String
  let header: String
  let question: String
  let options: [LocalAgentQuestionOption]
  let multiSelect: Bool
  let allowOther: Bool
  let secret: Bool
}

struct LocalQuestionPrompt: Identifiable, Sendable, Equatable {
  var id: String { requestID }
  let requestID: String
  let questions: [LocalAgentQuestion]
}

struct LocalSessionInteractions: Sendable, Equatable {
  var permissions: [LocalPermissionPrompt]
  var questions: [LocalQuestionPrompt]

  static let empty = LocalSessionInteractions(permissions: [], questions: [])

  /// 从同一份事件快照推导当前仍未处理的交互。后出现的 resolved 事件会移除请求，
  /// 所以 daemon 重启恢复后也不会把旧审批重新亮起来。
  static func decode(_ data: Data) throws -> LocalSessionInteractions {
    guard
      let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      let events = root["events"] as? [[String: Any]]
    else {
      throw LocalSessionControlFailure("daemon 返回了无法识别的 Agent 事件")
    }

    var permissionOrder: [String] = []
    var permissions: [String: LocalPermissionPrompt] = [:]
    var questionOrder: [String] = []
    var questions: [String: LocalQuestionPrompt] = [:]

    for event in events {
      let kind = event["kind"] as? String ?? ""
      let requestID = event["reqId"] as? String ?? ""
      switch kind {
      case "permission.request":
        guard !requestID.isEmpty else { continue }
        if permissions[requestID] == nil { permissionOrder.append(requestID) }
        permissions[requestID] = LocalPermissionPrompt(
          requestID: requestID,
          action: event["action"] as? String ?? "权限请求",
          summary: event["summary"] as? String ?? "",
          resources: event["resources"] as? [String] ?? []
        )
      case "permission.resolved":
        permissions.removeValue(forKey: requestID)
      case "question.request":
        guard !requestID.isEmpty else { continue }
        let decoded: [LocalAgentQuestion] =
          (event["questions"] as? [[String: Any]] ?? []).compactMap { raw -> LocalAgentQuestion? in
            guard let id = raw["id"] as? String, let text = raw["question"] as? String else {
              return nil
            }
            let options: [LocalAgentQuestionOption] =
              (raw["options"] as? [[String: Any]] ?? []).compactMap { option -> LocalAgentQuestionOption? in
              guard let label = option["label"] as? String else { return nil }
              return LocalAgentQuestionOption(
                label: label,
                detail: option["description"] as? String
              )
            }
            return LocalAgentQuestion(
              id: id,
              header: raw["header"] as? String ?? "",
              question: text,
              options: options,
              multiSelect: raw["multiSelect"] as? Bool ?? false,
              allowOther: raw["allowOther"] as? Bool ?? false,
              secret: raw["secret"] as? Bool ?? false
            )
          }
        if questions[requestID] == nil { questionOrder.append(requestID) }
        questions[requestID] = LocalQuestionPrompt(requestID: requestID, questions: decoded)
      case "question.resolved":
        questions.removeValue(forKey: requestID)
      default:
        continue
      }
    }

    return LocalSessionInteractions(
      permissions: permissionOrder.compactMap { permissions[$0] },
      questions: questionOrder.compactMap { questions[$0] }
    )
  }
}

struct LocalSessionControlFailure: LocalizedError, Sendable {
  let message: String

  init(_ message: String) {
    self.message = message
  }

  var errorDescription: String? { message }
}

extension DaemonController {
  /// 返回 nil 表示 `knownSeq` 仍是最新，调用者无需重绘。
  func loadLocalSessionFrame(id: String, knownSeq: Int?) async throws -> LocalSessionFrame? {
    guard let initialRequest = localSessionRequest(id: id, endpoint: "view", method: "GET") else {
      throw LocalSessionControlFailure("daemon 尚未提供本机会话接口")
    }
    var request = initialRequest
    if let knownSeq, var components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false) {
      components.queryItems = [URLQueryItem(name: "knownSeq", value: String(knownSeq))]
      request.url = components.url
    }
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw LocalSessionControlFailure("daemon 没有返回 HTTP 状态")
    }
    if http.statusCode == 204 { return nil }
    guard (200..<300).contains(http.statusCode) else {
      throw LocalSessionControlFailure(controlErrorMessage(data, fallback: "daemon 拒绝读取会话"))
    }
    return try LocalSessionFrame.decode(data)
  }

  func sendLocalChat(id: String, text: String) async -> String? {
    await performLocalSessionInteraction(
      id: id,
      body: ["type": "chat.send", "text": text]
    )
  }

  func sendLocalTerminalInput(id: String, dataB64: String) async -> String? {
    await performLocalSessionInteraction(
      id: id,
      body: ["type": "term.input", "dataB64": dataB64]
    )
  }

  func resizeLocalTerminal(id: String, cols: Int, rows: Int) async -> String? {
    await performLocalSessionInteraction(
      id: id,
      body: ["type": "term.resize", "cols": cols, "rows": rows]
    )
  }

  func respondLocalPermission(id: String, requestID: String, reply: String) async -> String? {
    await performLocalSessionInteraction(
      id: id,
      body: ["type": "permission.respond", "reqId": requestID, "reply": reply]
    )
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
      body: [
        "type": "question.respond",
        "reqId": requestID,
        "answers": payload,
        "cancelled": cancelled,
      ]
    )
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
