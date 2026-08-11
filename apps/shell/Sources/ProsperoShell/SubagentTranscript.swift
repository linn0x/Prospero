import Foundation
import SwiftUI

/// Mac 端只读的子 Agent 过程模型。daemon 负责把实时日志或后端原生历史统一成
/// Prospero 事件，这里只把 token delta 折叠成适合阅读的消息/推理/工具条目。
struct SubagentTranscript: Sendable, Equatable {
  var evSeq: Int
  var events: [Event]

  struct Event: Identifiable, Sendable, Equatable {
    enum Kind: String, Sendable {
      case user
      case assistant
      case reasoning
      case tool
      case permission
      case question
      case error
      case milestone
    }

    var id: String
    var kind: Kind
    var title: String
    var detail: String
    var state: String?
  }

  static func decode(_ data: Data, agentName: String) throws -> SubagentTranscript {
    guard
      let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      let rawEvents = root["events"] as? [[String: Any]]
    else {
      throw SubagentTranscriptFailure("daemon 返回了无法识别的子 Agent 事件")
    }

    var events: [Event] = []
    var messageIndex: [String: Int] = [:]
    var reasoningIndex: [String: Int] = [:]
    var toolIndex: [String: Int] = [:]
    var permissionIndex: [String: Int] = [:]
    var questionIndex: [String: Int] = [:]

    func string(_ object: [String: Any], _ key: String) -> String {
      object[key] as? String ?? ""
    }
    func append(_ event: Event) -> Int {
      events.append(event)
      return events.count - 1
    }
    func joined(_ first: String, _ second: String) -> String {
      if first.isEmpty { return second }
      if second.isEmpty || first == second { return first }
      return "\(first)\n\(second)"
    }

    for (offset, raw) in rawEvents.enumerated() {
      let kind = string(raw, "kind")
      switch kind {
      case "user.message":
        let msgID = string(raw, "msgId")
        _ = append(Event(
          id: "user:\(msgID):\(offset)",
          kind: .user,
          title: "给 \(agentName) 的消息",
          detail: string(raw, "text")
        ))

      case "text.delta":
        let msgID = string(raw, "msgId")
        let delta = string(raw, "delta")
        guard !delta.isEmpty else { continue }
        if let index = messageIndex[msgID] {
          events[index].detail += delta
        } else {
          messageIndex[msgID] = append(Event(
            id: "assistant:\(msgID)",
            kind: .assistant,
            title: agentName,
            detail: delta
          ))
        }

      case "reasoning.delta":
        let msgID = string(raw, "msgId")
        let delta = string(raw, "delta")
        guard !delta.isEmpty else { continue }
        if let index = reasoningIndex[msgID] {
          events[index].detail += delta
        } else {
          reasoningIndex[msgID] = append(Event(
            id: "reasoning:\(msgID)",
            kind: .reasoning,
            title: "推理过程",
            detail: delta
          ))
        }

      case "tool.start":
        let callID = string(raw, "callId")
        toolIndex[callID] = append(Event(
          id: "tool:\(callID)",
          kind: .tool,
          title: string(raw, "tool").isEmpty ? "工具调用" : string(raw, "tool"),
          detail: string(raw, "summary"),
          state: "运行中"
        ))

      case "tool.end":
        let callID = string(raw, "callId")
        let state = string(raw, "state")
        let label = state == "success" ? "已完成" : state == "failed" ? "失败" : state
        if let index = toolIndex[callID] {
          events[index].detail = joined(events[index].detail, string(raw, "summary"))
          events[index].state = label
        } else {
          toolIndex[callID] = append(Event(
            id: "tool:\(callID)",
            kind: .tool,
            title: "工具调用",
            detail: string(raw, "summary"),
            state: label
          ))
        }

      case "permission.auto", "permission.request":
        let requestID = string(raw, "reqId")
        let action = string(raw, "action")
        permissionIndex[requestID] = append(Event(
          id: "permission:\(requestID)",
          kind: .permission,
          title: action.isEmpty ? "权限请求" : action,
          detail: string(raw, "summary"),
          state: kind == "permission.auto" ? "已自动允许" : "等待处理"
        ))

      case "permission.resolved":
        let requestID = string(raw, "reqId")
        if let index = permissionIndex[requestID] {
          let reply = string(raw, "reply")
          events[index].state = reply == "reject" ? "已拒绝" : "已允许"
        }

      case "question.request":
        let requestID = string(raw, "reqId")
        let questions = (raw["questions"] as? [[String: Any]] ?? [])
          .compactMap { $0["question"] as? String }
          .filter { !$0.isEmpty }
          .joined(separator: "\n")
        questionIndex[requestID] = append(Event(
          id: "question:\(requestID)",
          kind: .question,
          title: "等待回答",
          detail: questions,
          state: "等待处理"
        ))

      case "question.resolved":
        let requestID = string(raw, "reqId")
        if let index = questionIndex[requestID] {
          events[index].state = raw["cancelled"] as? Bool == true ? "已取消" : "已回答"
        }

      case "turn.end":
        let msgID = string(raw, "msgId")
        let finish = string(raw, "finish")
        let title = finish == "failed"
          ? "本轮失败"
          : finish == "interrupted" ? "本轮已停止" : "本轮完成"
        _ = append(Event(
          id: "turn:\(msgID):\(offset)",
          kind: .milestone,
          title: title,
          detail: ""
        ))

      case "agent.error":
        _ = append(Event(
          id: "error:\(offset)",
          kind: .error,
          title: "Agent 出错",
          detail: string(raw, "message")
        ))

      default:
        continue
      }
    }

    return SubagentTranscript(evSeq: root["evSeq"] as? Int ?? 0, events: events)
  }
}

struct SubagentTranscriptFailure: LocalizedError, Sendable {
  let message: String

  init(_ message: String) {
    self.message = message
  }

  var errorDescription: String? { message }
}

/// Codex 风格的 Agent 身份胶囊：状态只是辅助色，名字才是主识别信息。
struct SubagentIdentityBadge: View {
  let subagent: RunningStatus.Session.Subagent
  var compact = false

  private var isActive: Bool {
    subagent.status == "running" || subagent.status == "starting"
  }

  private var tint: Color {
    if subagent.status == "failed" { return .red }
    if subagent.status == "waiting_input" { return .orange }
    return isActive ? .blue : .secondary
  }

  var body: some View {
    HStack(spacing: 6) {
      Circle()
        .fill(tint)
        .frame(width: 7, height: 7)
        .shadow(color: isActive ? tint.opacity(0.6) : .clear, radius: 3)
      Text(subagent.name)
        .font(compact ? .caption.weight(.semibold) : .callout.weight(.semibold))
        .lineLimit(1)
      if !compact, let role = subagent.role, !role.isEmpty, role != subagent.name {
        Text(role)
          .font(.caption2)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
    }
    .padding(.horizontal, compact ? 8 : 10)
    .padding(.vertical, compact ? 4 : 6)
    .background(tint.opacity(0.1), in: Capsule())
    .overlay(Capsule().stroke(tint.opacity(0.25), lineWidth: 1))
  }
}

struct SubagentTranscriptSheet: View {
  let daemon: DaemonController
  let session: RunningStatus.Session
  let subagent: RunningStatus.Session.Subagent

  @Environment(\.dismiss) private var dismiss
  @State private var transcript: SubagentTranscript?
  @State private var error: String?
  @State private var loading = true

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 12) {
        SubagentIdentityBadge(subagent: subagent)
        VStack(alignment: .leading, spacing: 2) {
          Text("子 Agent 过程").font(.headline)
          Text(session.title).font(.caption).foregroundStyle(.secondary)
        }
        Spacer()
        if subagent.status == "running" || subagent.status == "starting" {
          Label("实时更新", systemImage: "waveform.path.ecg")
            .font(.caption)
            .foregroundStyle(.blue)
        } else {
          Text(subagent.statusLabel).font(.caption).foregroundStyle(.secondary)
        }
        Button("完成") { dismiss() }
          .keyboardShortcut(.cancelAction)
      }
      .padding(18)

      Divider()

      Group {
        if loading && transcript == nil {
          ProgressView("正在读取过程…")
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let error, transcript == nil {
          ContentUnavailableView(
            "无法读取子 Agent 过程",
            systemImage: "exclamationmark.triangle",
            description: Text(error)
          )
        } else if transcript?.events.isEmpty != false {
          ContentUnavailableView(
            "还没有过程事件",
            systemImage: "ellipsis.bubble",
            description: Text("子 Agent 开始回复或调用工具后，这里会实时出现完整过程。")
          )
        } else if let transcript {
          ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
              ForEach(transcript.events) { event in
                SubagentTranscriptEventRow(event: event)
              }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)

      if let error, transcript != nil {
        Divider()
        Label(error, systemImage: "wifi.exclamationmark")
          .font(.caption)
          .foregroundStyle(.orange)
          .padding(10)
      }
    }
    .frame(minWidth: 720, idealWidth: 820, minHeight: 560, idealHeight: 680)
    .task(id: "\(session.id):\(subagent.id)") {
      await refreshLoop()
    }
  }

  private func refreshLoop() async {
    while !Task.isCancelled {
      do {
        transcript = try await daemon.loadSubagentTranscript(
          sessionID: session.id,
          subagentID: subagent.id,
          agentName: subagent.name
        )
        error = nil
      } catch {
        self.error = error.localizedDescription
      }
      loading = false
      do {
        try await Task.sleep(for: .seconds(1))
      } catch {
        return
      }
    }
  }
}

struct SubagentTranscriptEventRow: View {
  let event: SubagentTranscript.Event

  private var tint: Color {
    switch event.kind {
    case .user: .blue
    case .assistant: .primary
    case .reasoning: .purple
    case .tool: .cyan
    case .permission: .orange
    case .question: .indigo
    case .error: .red
    case .milestone: .secondary
    }
  }

  private var symbol: String {
    switch event.kind {
    case .user: "person.crop.circle"
    case .assistant: "sparkles"
    case .reasoning: "brain.head.profile"
    case .tool: "hammer"
    case .permission: "hand.raised"
    case .question: "questionmark.bubble"
    case .error: "exclamationmark.triangle"
    case .milestone: "checkmark.circle"
    }
  }

  var body: some View {
    HStack(alignment: .top, spacing: 11) {
      Image(systemName: symbol)
        .font(.callout)
        .foregroundStyle(tint)
        .frame(width: 24, height: 24)
        .background(tint.opacity(0.1), in: RoundedRectangle(cornerRadius: 6))
      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 8) {
          Text(event.title).font(.callout.weight(.semibold))
          if let state = event.state, !state.isEmpty {
            Text(state)
              .font(.caption2.weight(.medium))
              .foregroundStyle(tint)
              .padding(.horizontal, 6)
              .padding(.vertical, 2)
              .background(tint.opacity(0.09), in: Capsule())
          }
        }
        if !event.detail.isEmpty {
          Text(event.detail)
            .font(event.kind == .tool ? .system(.caption, design: .monospaced) : .callout)
            .foregroundStyle(event.kind == .reasoning ? .secondary : .primary)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(12)
    // 对话输入保留气泡，其余事件作为连续的工作流记录呈现，避免每条工具日志都再套一张卡。
    .background(
      event.kind == .user ? Color(nsColor: .controlBackgroundColor) : .clear,
      in: RoundedRectangle(cornerRadius: 10)
    )
    .frame(maxWidth: event.kind == .user ? 620 : .infinity, alignment: event.kind == .user ? .trailing : .leading)
  }
}
