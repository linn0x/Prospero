import SwiftUI

/// Interaction boundary for `ChatTimelineView`. The host owns transport and may wire these closures
/// to a daemon, a preview fixture, or a test harness; this component never opens a connection itself.
struct ChatTimelineActions {
  var send: (String) -> Void = { _ in }
  var respondToPermission: (String, ChatPermissionReply) -> Void = { _, _ in }
  var respondToQuestion: (String, [ChatQuestionAnswer], Bool) -> Void = { _, _, _ in }
  var loadToolOutput: (String) -> Void = { _ in }
  var openSubagent: (String) -> Void = { _ in }
  var isPending: (String) -> Bool = { _ in false }
}

struct ChatTimelineView: View {
  let timeline: ChatTimeline
  var actions = ChatTimelineActions()
  var showsComposer = true
  @Binding var draft: String
  var isSending = false
  var sendEnabled = true
  @State private var isAtBottom = true
  @State private var showsLatestButton = false

  var body: some View {
    VStack(spacing: 0) {
      ScrollViewReader { proxy in
        ZStack(alignment: .bottomTrailing) {
          ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
              if timeline.entries.isEmpty {
                ContentUnavailableView(
                  "还没有对话内容",
                  systemImage: "bubble.left.and.bubble.right",
                  description: Text("发送一条消息即可开始与 Agent 协作。")
                )
                .frame(maxWidth: .infinity, minHeight: 260)
              } else {
                ForEach(timeline.presentationItems) { item in
                  switch item {
                  case .entry(let entry): ChatTimelineEntryView(entry: entry, actions: actions)
                  case .collapsedActivities(let group): ChatCollapsedActivityView(group: group, actions: actions)
                  }
                }
              }
              Color.clear
                .frame(height: 1)
                .id("chat-bottom")
                .onAppear { isAtBottom = true; showsLatestButton = false }
                .onDisappear { isAtBottom = false }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 16)
            .frame(maxWidth: 960)
            .frame(maxWidth: .infinity)
          }
          if showsLatestButton {
            Button {
              withAnimation(.easeOut(duration: 0.18)) {
                proxy.scrollTo("chat-bottom", anchor: .bottom)
              }
              isAtBottom = true
              showsLatestButton = false
            } label: {
              Label("查看最新", systemImage: "arrow.down")
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .padding(16)
            .shadow(color: .black.opacity(0.15), radius: 8, y: 3)
          }
        }
        .onChange(of: timeline.evSeq) { _, _ in
          guard timeline.evSeq > 0 else { return }
          if isAtBottom {
            withAnimation(.easeOut(duration: 0.16)) {
              proxy.scrollTo("chat-bottom", anchor: .bottom)
            }
          } else {
            showsLatestButton = true
          }
        }
      }
      if showsComposer { composer }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Agent 对话时间线")
  }

  private var composer: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        Image(systemName: "sparkles").foregroundStyle(.tint)
        Text("发送给 Agent").font(.caption.weight(.semibold))
        Text("⌘↵ 发送 · Return 换行")
          .font(.caption2)
          .foregroundStyle(.secondary)
        Spacer()
        if isSending { ProgressView().controlSize(.small) }
      }
      HStack(alignment: .bottom, spacing: 10) {
        TextField("描述任务、补充上下文或继续追问…", text: $draft, axis: .vertical)
        .lineLimit(1...6)
        .textFieldStyle(.plain)
        .padding(.horizontal, 11)
        .padding(.vertical, 9)
        .background(.quaternary.opacity(0.7), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityLabel("发送给 Agent 的消息")
        .onKeyPress(.return, phases: .down) { press in
          guard press.modifiers.contains(.command) else { return .ignored }
          sendDraft()
          return .handled
        }
        .disabled(!sendEnabled || isSending)
        Button(action: sendDraft) {
          Label("发送", systemImage: "arrow.up.circle.fill")
        }
        .buttonStyle(.borderedProminent)
        .disabled(!sendEnabled || isSending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .accessibilityLabel("发送消息")
      }
    }
    .padding(.horizontal, 18)
    .padding(.vertical, 12)
    .background(.bar.opacity(0.86))
  }

  private func sendDraft() {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, !isSending, sendEnabled else { return }
    actions.send(text)
  }
}

private struct ChatTimelineEntryView: View {
  let entry: ChatTimeline.Entry
  let actions: ChatTimelineActions

  var body: some View {
    switch entry {
    case .message(let message): ChatMessageView(message: message)
    case .reasoning(let reasoning): ChatReasoningView(reasoning: reasoning)
    case .tool(let tool): ChatToolView(tool: tool, actions: actions)
    case .permission(let permission): ChatPermissionView(permission: permission, actions: actions)
    case .question(let question): ChatQuestionView(prompt: question, actions: actions)
    case .subagent(let subagent): ChatSubagentView(subagent: subagent, actions: actions)
    case .turn(let turn): ChatTurnView(turn: turn)
    case .error(let failure): ChatErrorView(failure: failure)
    }
  }
}

private struct ChatMessageView: View {
  let message: ChatTimeline.Message

  var body: some View {
    HStack {
      if message.role == .assistant { content; Spacer(minLength: 44) }
      else { Spacer(minLength: 44); content }
    }
    .textSelection(.enabled)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(message.role == .user ? "用户消息" : "助手消息")
  }

  private var content: some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(message.role == .user ? "你" : "Agent")
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
      ChatMarkdownText(text: message.text)
    }
    .padding(12)
    .background(message.role == .user ? Color.accentColor.opacity(0.16) : Color.secondary.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
  }
}

/// Markdown 解析结果的记忆缓存。
///
/// 解析原本发生在 `body` 里,而 LazyVStack 会丢弃移出视口的行 —— 同一条消息每次
/// 滚回视口都要重新解析一遍(实测一条典型回复约 0.09 ms,十几条可见消息就是毫秒级,
/// 且随滚动持续重复)。文本本身就是键:文本没变就没有重新解析的理由。
///
/// 流式输出中的那条消息每次追加都会产生新键,因此仍按需解析一次 —— 这与旧行为相同,
/// 差别只在于其余已定稿的消息不再反复付费。
@MainActor
private final class MarkdownCache {
  static let shared = MarkdownCache()

  private var entries: [String: AttributedString] = [:]
  private var insertionOrder: [String] = []
  /// 上限存在的意义是流式消息会不断产生新键;按插入顺序淘汰即可。
  private let capacity = 128

  func attributed(_ text: String) -> AttributedString {
    if let cached = entries[text] { return cached }
    // 解析失败时退化为普通文本,与原先的 `Text(text)` 分支等价。
    let parsed = (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .full)))
      ?? AttributedString(text)
    entries[text] = parsed
    insertionOrder.append(text)
    if insertionOrder.count > capacity {
      entries.removeValue(forKey: insertionOrder.removeFirst())
    }
    return parsed
  }
}

/// Markdown is best-effort: malformed Markdown is rendered as ordinary selectable text.
private struct ChatMarkdownText: View {
  let text: String

  var body: some View {
    Text(MarkdownCache.shared.attributed(text))
      .fixedSize(horizontal: false, vertical: true)
  }
}

private struct ChatReasoningView: View {
  let reasoning: ChatTimeline.Reasoning
  @State private var expanded = false

  var body: some View {
    DisclosureGroup(isExpanded: $expanded) {
      Text(reasoning.text)
        .font(.callout.monospaced())
        .textSelection(.enabled)
        .padding(.top, 4)
    } label: {
      Label("推理过程", systemImage: "brain.head.profile")
        .foregroundStyle(.secondary)
    }
    .padding(10)
    .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    .accessibilityLabel("可折叠推理过程")
  }
}

private struct ChatToolView: View {
  let tool: ChatTimeline.Tool
  let actions: ChatTimelineActions
  @State private var expanded = false

  var body: some View {
    DisclosureGroup(isExpanded: $expanded) {
      VStack(alignment: .leading, spacing: 8) {
        if !tool.summary.isEmpty { Text(tool.summary).textSelection(.enabled) }
        if let diff = tool.diff { ChatDiffView(diff: diff) }
        if let output = tool.fullOutput {
          VStack(alignment: .leading, spacing: 4) {
            Text("完整输出")
              .font(.caption.weight(.semibold))
              .foregroundStyle(.secondary)
            Text(output)
              .font(.caption.monospaced())
              .textSelection(.enabled)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(8)
              .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
            if tool.outputTruncated {
              Text("daemon 为保护工作台已截断过长输出。")
                .font(.caption)
                .foregroundStyle(.secondary)
            }
          }
        } else if tool.hasMore, actions.isPending(tool.id) {
          ProgressView("正在载入完整输出…")
            .controlSize(.small)
        } else if tool.hasMore {
          Button("拉取完整输出") { actions.loadToolOutput(String(tool.id.dropFirst("tool:".count))) }
            .accessibilityLabel("拉取 \(tool.title) 的完整输出")
        }
      }
      .padding(.top, 4)
    } label: {
      HStack {
        Image(systemName: toolSymbol)
          .foregroundStyle(toolColor)
        Text(tool.title).fontWeight(.medium)
        Spacer()
        Text(toolStateLabel).font(.caption).foregroundStyle(.secondary)
      }
    }
    .padding(10)
    .background(toolColor.opacity(0.10), in: RoundedRectangle(cornerRadius: 10))
    .accessibilityLabel("工具 \(tool.title)，\(toolStateLabel)")
  }

  private var toolSymbol: String { tool.state == .running ? "gearshape.2" : tool.state == .success ? "checkmark.circle" : "xmark.octagon" }
  private var toolColor: Color { tool.state == .running ? .orange : tool.state == .success ? .green : .red }
  private var toolStateLabel: String { tool.state == .running ? "运行中" : tool.state == .success ? "已完成" : "失败" }
}

private struct ChatDiffView: View {
  let diff: ChatDiff

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack {
        Label(diff.path, systemImage: "doc.text")
          .font(.caption.weight(.medium))
        Spacer()
        Text("+\(diff.additions) −\(diff.deletions)")
          .font(.caption.monospacedDigit())
          .foregroundStyle(.secondary)
      }
      if !diff.patch.isEmpty {
        Text(diff.patch)
          .font(.caption.monospaced())
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(8)
          .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
      }
      if diff.truncated { Text("差异已截断") .font(.caption).foregroundStyle(.secondary) }
    }
    .accessibilityLabel("文件差异 \(diff.path)，新增 \(diff.additions) 行，删除 \(diff.deletions) 行")
  }
}

private struct ChatPermissionView: View {
  let permission: ChatTimeline.Permission
  let actions: ChatTimelineActions

  var body: some View {
    VStack(alignment: .leading, spacing: 9) {
      HStack {
        Label("权限：\(permission.action)", systemImage: "hand.raised.fill")
          .fontWeight(.medium)
        Spacer()
        Text(statusLabel).font(.caption).foregroundStyle(statusColor)
      }
      if !permission.summary.isEmpty { Text(permission.summary).textSelection(.enabled) }
      if !permission.resources.isEmpty { Text(permission.resources.joined(separator: "\n")).font(.caption.monospaced()).textSelection(.enabled) }
      if let diff = permission.diff { ChatDiffView(diff: diff) }
      if case .pending = permission.status {
        HStack {
          Button("允许一次") { actions.respondToPermission(requestID, .once) }.buttonStyle(.borderedProminent)
          Button("始终允许") { actions.respondToPermission(requestID, .always) }
          Button("拒绝", role: .destructive) { actions.respondToPermission(requestID, .reject) }
          if actions.isPending(permission.id) { ProgressView().controlSize(.small) }
        }
        .disabled(actions.isPending(permission.id))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("审批操作")
      }
    }
    .padding(12)
    .background(statusColor.opacity(0.10), in: RoundedRectangle(cornerRadius: 10))
    .accessibilityLabel("权限请求 \(permission.action)，\(statusLabel)")
  }

  private var requestID: String { String(permission.id.dropFirst("permission:".count)) }
  private var statusLabel: String {
    switch permission.status {
    case .pending: "等待批准"
    case .automatic(let policy): "已按 \(policy) 自动允许"
    case .allowed(.always): "已始终允许"
    case .allowed: "已允许"
    case .rejected: "已拒绝"
    }
  }
  private var statusColor: Color {
    switch permission.status { case .pending: .orange; case .rejected: .red; case .automatic, .allowed: .green }
  }
}

private struct ChatQuestionView: View {
  let prompt: ChatTimeline.QuestionPrompt
  let actions: ChatTimelineActions
  @State private var selections: [String: Set<String>] = [:]
  @State private var otherAnswers: [String: String] = [:]

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Label("Agent 需要你的回答", systemImage: "questionmark.bubble.fill")
          .fontWeight(.medium)
        Spacer()
        Text(statusLabel).font(.caption).foregroundStyle(.secondary)
      }
      if prompt.questions.isEmpty { Text(resolvedText).font(.callout).foregroundStyle(.secondary) }
      ForEach(prompt.questions, id: \.id) { question in questionBody(question) }
      if case .pending = prompt.status {
        HStack {
          Button("提交回答") { actions.respondToQuestion(requestID, answers, false) }
            .buttonStyle(.borderedProminent)
            .disabled(!hasAnswer || actions.isPending(prompt.id))
            .accessibilityLabel("提交问题回答")
          Button("取消问题", role: .cancel) { actions.respondToQuestion(requestID, [], true) }
            .disabled(actions.isPending(prompt.id))
            .accessibilityLabel("取消问题")
          if actions.isPending(prompt.id) { ProgressView().controlSize(.small) }
        }
      } else if !resolvedText.isEmpty { Text(resolvedText).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
    }
    .padding(12)
    .background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 10))
    .accessibilityLabel("Agent 问题，\(statusLabel)")
  }

  @ViewBuilder private func questionBody(_ question: ChatQuestion) -> some View {
    VStack(alignment: .leading, spacing: 7) {
      if !question.header.isEmpty { Text(question.header).font(.caption.weight(.semibold)).foregroundStyle(.secondary) }
      Text(question.question).textSelection(.enabled)
      if case .pending = prompt.status {
        ForEach(question.options, id: \.label) { option in
          Toggle(isOn: selectionBinding(question: question, label: option.label)) {
            VStack(alignment: .leading, spacing: 1) {
              Text(option.label)
              if let detail = option.detail, !detail.isEmpty { Text(detail).font(.caption).foregroundStyle(.secondary) }
            }
          }
          .toggleStyle(.checkbox)
        }
        if question.allowOther {
          Group {
            if question.secret { SecureField("其他回答", text: otherBinding(question.id)) }
            else { TextField("其他回答", text: otherBinding(question.id)) }
          }
          .textFieldStyle(.roundedBorder)
        }
      }
    }
  }

  private func selectionBinding(question: ChatQuestion, label: String) -> Binding<Bool> {
    Binding(
      get: { selections[question.id, default: []].contains(label) },
      set: { selected in
        var values = selections[question.id, default: []]
        if selected { if !question.multiSelect { values.removeAll() }; values.insert(label) } else { values.remove(label) }
        selections[question.id] = values
      }
    )
  }
  private func otherBinding(_ id: String) -> Binding<String> { Binding(get: { otherAnswers[id, default: ""] }, set: { otherAnswers[id] = $0 }) }
  private var requestID: String { String(prompt.id.dropFirst("question:".count)) }
  private var answers: [ChatQuestionAnswer] {
    prompt.questions.compactMap { question in
      var values = Array(selections[question.id, default: []])
      if let other = otherAnswers[question.id]?.trimmingCharacters(in: .whitespacesAndNewlines), !other.isEmpty { values.append(other) }
      return values.isEmpty ? nil : ChatQuestionAnswer(questionID: question.id, values: values)
    }
  }
  private var hasAnswer: Bool { !answers.isEmpty }
  private var statusLabel: String {
    switch prompt.status { case .pending: "等待回答"; case .answered: "已回答"; case .cancelled: "已取消" }
  }
  private var resolvedText: String {
    switch prompt.status {
    case .pending: ""
    case .cancelled: "问题已取消"
    case .answered(let answers): answers.map { "\($0.questionID)：\($0.values.joined(separator: "、"))" }.joined(separator: "\n")
    }
  }
}

private struct ChatSubagentView: View {
  let subagent: ChatTimeline.Subagent
  let actions: ChatTimelineActions

  var body: some View {
    Button { actions.openSubagent(String(subagent.id.dropFirst("subagent:".count))) } label: {
      HStack(spacing: 10) {
        Image(systemName: "person.2.fill").foregroundStyle(.blue)
        VStack(alignment: .leading, spacing: 2) {
          Text(subagent.name).fontWeight(.medium)
          Text([subagent.role, subagent.preview].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
            .font(.caption).foregroundStyle(.secondary).lineLimit(2)
        }
        Spacer()
        VStack(alignment: .trailing, spacing: 2) {
          Text(subagent.status).font(.caption).foregroundStyle(.secondary)
          Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(10)
      .background(Color.blue.opacity(0.10), in: RoundedRectangle(cornerRadius: 10))
    }
    .buttonStyle(.plain)
    .accessibilityLabel("打开子 Agent \(subagent.name)，状态 \(subagent.status)")
  }
}

private struct ChatTurnView: View {
  let turn: ChatTimeline.Turn
  var body: some View {
    Label(turn.finish == "failed" ? "本轮失败" : turn.finish == "interrupted" ? "本轮已停止" : "本轮完成", systemImage: turn.finish == "failed" ? "xmark.circle" : "checkmark.circle")
      .font(.caption)
      .foregroundStyle(turn.finish == "failed" ? .red : .secondary)
      .accessibilityLabel("对话轮次结束")
  }
}

private struct ChatErrorView: View {
  let failure: ChatTimeline.Failure
  var body: some View {
    Label { Text(failure.message).textSelection(.enabled) } icon: { Image(systemName: "exclamationmark.triangle.fill") }
      .padding(10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .foregroundStyle(.red)
      .background(Color.red.opacity(0.10), in: RoundedRectangle(cornerRadius: 10))
      .accessibilityLabel("Agent 错误：\(failure.message)")
  }
}

private struct ChatCollapsedActivityView: View {
  let group: ChatTimeline.ActivityGroup
  let actions: ChatTimelineActions
  @State private var expanded = false

  var body: some View {
    DisclosureGroup(isExpanded: $expanded) {
      VStack(alignment: .leading, spacing: 8) {
        ForEach(group.entries) { ChatTimelineEntryView(entry: $0, actions: actions) }
      }
      .padding(.top, 6)
    } label: {
      Label("\(group.entries.count) 项连续活动已完成", systemImage: "checkmark.circle.fill")
        .foregroundStyle(.green)
    }
    .padding(10)
    .background(Color.green.opacity(0.10), in: RoundedRectangle(cornerRadius: 10))
    .accessibilityLabel("\(group.entries.count) 项已完成活动，可展开")
  }
}
