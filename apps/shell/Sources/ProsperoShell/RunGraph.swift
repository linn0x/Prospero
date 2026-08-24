import SwiftUI

/// 一个 Run 的任务依赖图。
///
/// 列表读不出 DAG 的形状:哪几个任务此刻能并行、整条链卡在谁身上、失败的那个
/// 下游还挂着多少 —— 这些都是图里一眼的事,在列表里要靠人脑做拓扑排序。
struct RunGraphCanvas: View {
  let tasks: [OrchestrationStatus.Task]
  let dispatches: [OrchestrationStatus.Dispatch]
  @Binding var selection: String?

  private let nodeWidth: CGFloat = 178
  private let nodeHeight: CGFloat = 70
  private let hGap: CGFloat = 78
  private let vGap: CGFloat = 26
  private let margin: CGFloat = 26

  private struct Layout {
    var positions: [String: CGPoint]
    var size: CGSize
  }

  var body: some View {
    let layout = makeLayout()
    VStack(spacing: 0) {
      ScrollView([.horizontal, .vertical]) {
        ZStack {
          edges(layout)
          ForEach(tasks) { task in
            node(task)
              .position(layout.positions[task.id] ?? .zero)
          }
        }
        .frame(width: layout.size.width, height: layout.size.height)
      }
      .background(.quaternary.opacity(0.16))
      legend
    }
    .clipShape(RoundedRectangle(cornerRadius: 10))
    .overlay {
      RoundedRectangle(cornerRadius: 10)
        .stroke(.quaternary, lineWidth: 1)
    }
    .frame(height: min(520, max(240, layout.size.height + 34)))
    .accessibilityLabel("任务依赖图")
  }

  private func edges(_ layout: Layout) -> some View {
    Canvas { context, _ in
      for task in tasks {
        guard let end = layout.positions[task.id] else { continue }
        for dependency in task.deps {
          guard let start = layout.positions[dependency] else { continue }
          let upstreamDone = tasks.first { $0.id == dependency }?.status == "done"
          // 选中一个节点时,只把它自己的进出边点亮 —— 图一大,全部同色就读不出链路。
          let touched = selection == task.id || selection == dependency
          let color: Color = touched ? .accentColor : (upstreamDone ? .green : .secondary)
          let opacity: Double = touched ? 0.9 : (upstreamDone ? 0.5 : 0.34)

          let from = CGPoint(x: start.x + nodeWidth / 2, y: start.y)
          let to = CGPoint(x: end.x - nodeWidth / 2, y: end.y)
          let bend = (from.x + to.x) / 2
          var edge = Path()
          edge.move(to: from)
          edge.addCurve(
            to: to,
            control1: CGPoint(x: bend, y: from.y),
            control2: CGPoint(x: bend, y: to.y)
          )
          context.stroke(
            edge,
            with: .color(color.opacity(opacity)),
            style: StrokeStyle(lineWidth: touched ? 2.4 : 1.6, lineCap: .round)
          )
          var arrow = Path()
          arrow.move(to: to)
          arrow.addLine(to: CGPoint(x: to.x - 9, y: to.y - 5))
          arrow.addLine(to: CGPoint(x: to.x - 9, y: to.y + 5))
          arrow.closeSubpath()
          context.fill(arrow, with: .color(color.opacity(opacity + 0.12)))
        }
      }
    }
  }

  private func node(_ task: OrchestrationStatus.Task) -> some View {
    let state = RunTaskState(task: task, all: tasks, dispatches: dispatches)
    let selected = selection == task.id
    return Button {
      selection = selected ? nil : task.id
    } label: {
      VStack(alignment: .leading, spacing: 5) {
        Text(task.title.isEmpty ? "未命名任务" : task.title)
          .font(.system(size: 12, weight: .semibold))
          .lineLimit(2)
          .multilineTextAlignment(.leading)
        Spacer(minLength: 0)
        HStack(spacing: 5) {
          Circle().fill(state.color).frame(width: 6, height: 6)
          Text(state.label)
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(state.color)
          Spacer(minLength: 2)
          if state.workerActive {
            // worker 在跑是这张图上最该被一眼看到的东西。
            Image(systemName: "bolt.fill")
              .font(.system(size: 9))
              .foregroundStyle(.green)
          }
          if !task.deps.isEmpty {
            Text("\(task.deps.count)↑")
              .font(.system(size: 9, design: .monospaced))
              .foregroundStyle(.tertiary)
          }
        }
      }
      .padding(9)
      .frame(width: nodeWidth, height: nodeHeight, alignment: .leading)
      .background(
        selected ? Color.accentColor.opacity(0.14) : Color(nsColor: .controlBackgroundColor),
        in: RoundedRectangle(cornerRadius: 10, style: .continuous)
      )
      .overlay {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .stroke(
            selected ? Color.accentColor : state.borderColor,
            lineWidth: selected ? 2 : (state.ready ? 1.6 : 1)
          )
      }
    }
    .buttonStyle(.plain)
    .help(task.spec.isEmpty ? task.title : task.spec)
  }

  private var legend: some View {
    HStack(spacing: 12) {
      ForEach(RunTaskState.legend, id: \.label) { item in
        HStack(spacing: 4) {
          Circle().fill(item.color).frame(width: 5, height: 5)
          Text(item.label)
        }
      }
      Spacer()
      Text("\(tasks.count) 个任务")
    }
    .font(.system(size: 9))
    .foregroundStyle(.secondary)
    .padding(.horizontal, 10)
    .padding(.vertical, 6)
    .background(.quaternary.opacity(0.24))
  }

  /// 按依赖深度分层:x 是拓扑层级,y 是同层内的排队位次。
  /// 成环由 daemon 在建图时就拒绝了,这里的 stack 只是防御 —— 快照里真出现环,
  /// 也只是画得难看,不能让 UI 递归到爆栈。
  private func makeLayout() -> Layout {
    var memo: [String: Int] = [:]
    func level(_ id: String, stack: Set<String> = []) -> Int {
      if let cached = memo[id] { return cached }
      guard !stack.contains(id), let task = tasks.first(where: { $0.id == id }) else { return 0 }
      let nextStack = stack.union([id])
      let value = task.deps.isEmpty
        ? 0
        : (task.deps.map { level($0, stack: nextStack) }.max() ?? -1) + 1
      memo[id] = value
      return value
    }

    var rows: [Int: Int] = [:]
    var positions: [String: CGPoint] = [:]
    for task in tasks {
      let column = level(task.id)
      let row = rows[column, default: 0]
      rows[column] = row + 1
      positions[task.id] = CGPoint(
        x: margin + nodeWidth / 2 + CGFloat(column) * (nodeWidth + hGap),
        y: margin + nodeHeight / 2 + CGFloat(row) * (nodeHeight + vGap)
      )
    }
    let columns = (memo.values.max() ?? 0) + 1
    let rowCount = max(rows.values.max() ?? 1, 1)
    return Layout(
      positions: positions,
      size: CGSize(
        width: margin * 2 + CGFloat(columns) * nodeWidth + CGFloat(max(columns - 1, 0)) * hGap,
        height: margin * 2 + CGFloat(rowCount) * nodeHeight + CGFloat(max(rowCount - 1, 0)) * vGap
      )
    )
  }
}

/// 图上一个节点的显示状态。
///
/// "就绪"在 daemon 的 status 里没有对应值 —— 它是 pending 且所有依赖都 done 的
/// 那一刻。这恰恰是看图的人最想知道的:现在可以派谁。
struct RunTaskState {
  let label: String
  let color: Color
  let ready: Bool
  let workerActive: Bool

  init(
    task: OrchestrationStatus.Task,
    all: [OrchestrationStatus.Task],
    dispatches: [OrchestrationStatus.Dispatch]
  ) {
    let latest = dispatches
      .filter { $0.taskId == task.id }
      .max { $0.startedAt < $1.startedAt }
    workerActive = latest?.state == "starting" || latest?.state == "running"

    let depsSatisfied = task.deps.allSatisfy { id in
      all.first { $0.id == id }?.status == "done"
    }
    ready = task.status == "pending" && depsSatisfied

    switch task.status {
    case "done":
      label = "完成"
      color = .green
    case "failed":
      label = "失败"
      color = .red
    case "cancelled":
      label = "已取消"
      color = .secondary
    case "dispatched":
      label = workerActive ? "运行中" : "已派发"
      color = .orange
    case "blocked":
      label = "阻塞"
      color = .yellow
    default:
      label = ready ? "就绪" : "等待依赖"
      color = ready ? .accentColor : .secondary
    }
  }

  var borderColor: Color {
    ready ? Color.accentColor.opacity(0.65) : Color.secondary.opacity(0.22)
  }

  static let legend: [(label: String, color: Color)] = [
    ("就绪", .accentColor),
    ("运行中", .orange),
    ("完成", .green),
    ("失败", .red),
    ("阻塞", .yellow),
  ]
}

/// 任务区域的视图模式。@AppStorage 要求 RawRepresentable。
enum RunTaskView: String {
  case list
  case graph
}
