import SwiftUI

/// `parentId` 是 Prospero 的通用任务血缘。这里只解释控制协议，不理解任何业务阶段。
func runGraphLineageLabel(parentResult: String?) -> String {
  let signal = parentResult?.lowercased() ?? ""
  if signal.contains("typed_feedback_replan") || signal.contains("feedback") {
    return "反馈重规划"
  }
  if signal.contains("retry") || signal.contains("attempt") {
    return "重试"
  }
  return "派生任务"
}

func runGraphCenteredOffset(containerHeight: CGFloat, contentHeight: CGFloat) -> CGFloat {
  max(0, (containerHeight - contentHeight) / 2)
}

/// A terminal node can be historical control flow rather than a failed unit of
/// work. Keep this derived from Prospero's generic lineage/result fields so the
/// shell never needs to understand a plugin's material/domain/evidence types.
func runGraphTaskWasSuperseded(
  task: OrchestrationStatus.Task,
  all: [OrchestrationStatus.Task]
) -> Bool {
  guard task.status == "failed" || task.status == "cancelled" else { return false }
  if all.contains(where: { $0.parentId == task.id }) { return true }
  let signal = task.result?.lowercased() ?? ""
  return signal.contains("superseded")
    || signal.contains("quiesced before applying typed feedback")
    || signal.contains("typed_feedback_replan")
}

/// 一个 Run 的任务依赖图。
///
/// 列表读不出 DAG 的形状:哪几个任务此刻能并行、整条链卡在谁身上、失败的那个
/// 下游还挂着多少 —— 这些都是图里一眼的事,在列表里要靠人脑做拓扑排序。
struct RunGraphCanvas: View {
  let tasks: [OrchestrationStatus.Task]
  let dispatches: [OrchestrationStatus.Dispatch]
  @Binding var selection: String?

  /// 缩放倍数。手势进行中不断变化,松手后落到 zoomBase 作为下一次捏合的基准。
  @State private var zoom: CGFloat = 1
  @State private var zoomBase: CGFloat = 1
  /// 画布位移。和 zoom 一样,拖拽结束后落到 panBase。
  @State private var pan: CGSize = .zero
  @State private var panBase: CGSize = .zero
  /// 首次出现时,图比可视区大就自动适应一次 —— 别让人一进来就先手动找图。
  @State private var didAutoFit = false

  private let controlsHeight: CGFloat = 24

  private let minZoom: CGFloat = 0.35
  private let maxZoom: CGFloat = 2.2

  private let nodeWidth: CGFloat = 178
  private let nodeHeight: CGFloat = 70
  private let hGap: CGFloat = 78
  private let vGap: CGFloat = 26
  private let margin: CGFloat = 26

  private struct Layout {
    struct FeedbackEdge {
      var fromTaskId: String
      var toTaskId: String
      var label: String
    }

    var positions: [String: CGPoint]
    var feedbackEdges: [FeedbackEdge]
    var size: CGSize
  }

  var body: some View {
    let layout = makeLayout()
    GeometryReader { proxy in
      let viewport = CGSize(
        width: proxy.size.width,
        height: max(1, proxy.size.height - controlsHeight)
      )
      VStack(spacing: 0) {
        canvas(layout: layout, viewport: viewport)
        controls(layout: layout, viewport: viewport)
      }
      .onAppear {
        guard !didAutoFit else { return }
        didAutoFit = true
        if fitScale(layout: layout, viewport: viewport) < 1 {
          fitToWindow(layout: layout, viewport: viewport)
        }
      }
    }
    .clipShape(RoundedRectangle(cornerRadius: 10))
    .overlay {
      RoundedRectangle(cornerRadius: 10)
        .stroke(.quaternary, lineWidth: 1)
    }
    .frame(height: min(560, max(260, layout.size.height + controlsHeight + 10)))
    .accessibilityLabel("任务依赖图")
  }

  /// 画板本体:拖动平移、捏合缩放,不用 ScrollView。
  ///
  /// 之前用 ScrollView 有两个毛病。一是滚动条式的导航不是看图的手感 —— 图要能直接抓着拖;
  /// 二是 scaleEffect 不改变布局尺寸,外层 frame 会把原尺寸的视图居中放进放大后的框里,
  /// 于是放大之后右下角那部分被推到可视区外,怎么滚都到不了。
  /// 自己管 offset 就没有这层错位:内容永远从左上角开始画,位移是我们自己给的。
  private func canvas(layout: Layout, viewport: CGSize) -> some View {
    ZStack(alignment: .topLeading) {
      // 铺满的透明层,让空白处也能起手拖拽。
      Color.clear
      ZStack {
        edges(layout)
        ForEach(tasks) { task in
          node(task)
            .position(layout.positions[task.id] ?? .zero)
        }
      }
      .frame(width: layout.size.width, height: layout.size.height)
      .scaleEffect(zoom, anchor: .topLeading)
      .offset(x: pan.width, y: pan.height)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(.quaternary.opacity(0.16))
    .contentShape(Rectangle())
    .clipped()
    .gesture(
      DragGesture(minimumDistance: 2)
        .onChanged { value in
          pan = CGSize(
            width: panBase.width + value.translation.width,
            height: panBase.height + value.translation.height
          )
        }
        .onEnded { _ in panBase = pan }
    )
    .gesture(
      MagnifyGesture()
        .onChanged { value in
          applyZoom(
            zoomBase * value.magnification,
            around: CGPoint(x: viewport.width / 2, y: viewport.height / 2)
          )
        }
        .onEnded { _ in zoomBase = zoom }
    )
    // 手型光标是"这块能拖"的唯一提示 —— 画布上没有别的地方说这件事。
    .onHover { inside in
      if inside { NSCursor.openHand.set() } else { NSCursor.arrow.set() }
    }
  }

  private func clamp(_ value: CGFloat) -> CGFloat {
    min(maxZoom, max(minZoom, value))
  }

  /// 缩放时让锚点位置不动。少了这步,放大就是"内容往右下跑",
  /// 正在看的那块会被挤出屏幕 —— 每次放大都得重新找回来。
  private func applyZoom(_ requested: CGFloat, around anchor: CGPoint) {
    let next = clamp(requested)
    guard zoom > 0, next != zoom else { return }
    let ratio = next / zoom
    pan = CGSize(
      width: anchor.x - (anchor.x - pan.width) * ratio,
      height: anchor.y - (anchor.y - pan.height) * ratio
    )
    panBase = pan
    zoom = next
  }

  private func stepZoom(_ factor: CGFloat, viewport: CGSize) {
    withAnimation(.easeOut(duration: 0.15)) {
      applyZoom(
        zoom * factor,
        around: CGPoint(x: viewport.width / 2, y: viewport.height / 2)
      )
      zoomBase = zoom
    }
  }

  private func fitToWindow(layout: Layout, viewport: CGSize) {
    let fit = fitScale(layout: layout, viewport: viewport)
    withAnimation(.easeOut(duration: 0.18)) {
      zoom = fit
      zoomBase = fit
      pan = CGSize(
        width: (viewport.width - layout.size.width * fit) / 2,
        height: (viewport.height - layout.size.height * fit) / 2
      )
      panBase = pan
    }
  }

  private func reset() {
    withAnimation(.easeOut(duration: 0.15)) {
      zoom = 1
      zoomBase = 1
      pan = .zero
      panBase = .zero
    }
  }

  private func edges(_ layout: Layout) -> some View {
    Canvas { context, _ in
      let taskById = Dictionary(uniqueKeysWithValues: tasks.map { ($0.id, $0) })
      for task in tasks {
        guard let end = layout.positions[task.id] else { continue }
        for dependency in task.deps {
          guard let start = layout.positions[dependency] else { continue }
          let upstreamDone = taskById[dependency]?.status == "done"
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

      // parentId 表达任务反馈/重试血缘，不是执行依赖。用独立的蓝色虚线画成回路，
      // 既保留旧取消分支，又能一眼看到替代分支从哪里派生而来。
      for feedback in layout.feedbackEdges {
        guard let start = layout.positions[feedback.fromTaskId],
              let end = layout.positions[feedback.toTaskId] else { continue }
        let touched = selection == feedback.fromTaskId || selection == feedback.toTaskId
        let color = Color.accentColor.opacity(touched ? 0.95 : 0.72)
        let from = CGPoint(x: start.x, y: start.y + nodeHeight / 2)
        let to = CGPoint(x: end.x - nodeWidth / 2, y: end.y)
        let loopY = max(from.y, to.y) + 22
        var edge = Path()
        edge.move(to: from)
        edge.addCurve(
          to: to,
          control1: CGPoint(x: from.x, y: loopY),
          control2: CGPoint(x: to.x - 34, y: loopY)
        )
        context.stroke(
          edge,
          with: .color(color),
          style: StrokeStyle(
            lineWidth: touched ? 2.5 : 1.8,
            lineCap: .round,
            dash: [7, 5]
          )
        )
        var arrow = Path()
        arrow.move(to: to)
        arrow.addLine(to: CGPoint(x: to.x - 9, y: to.y - 5))
        arrow.addLine(to: CGPoint(x: to.x - 9, y: to.y + 5))
        arrow.closeSubpath()
        context.fill(arrow, with: .color(color))
        context.draw(
          Text(feedback.label)
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(Color.accentColor),
          at: CGPoint(x: (from.x + to.x) / 2, y: loopY + 8),
          anchor: .center
        )
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
          if task.status == "cancelled" {
            Image(systemName: "arrow.uturn.backward")
              .font(.system(size: 9, weight: .semibold))
              .foregroundStyle(.secondary)
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
      .opacity(task.status == "cancelled" ? 0.72 : 1)
    }
    .buttonStyle(.plain)
    .help(task.spec.isEmpty ? task.title : task.spec)
  }

  private func controls(layout: Layout, viewport: CGSize) -> some View {
    HStack(spacing: 12) {
      ForEach(RunTaskState.legend, id: \.label) { item in
        HStack(spacing: 4) {
          Circle().fill(item.color).frame(width: 5, height: 5)
          Text(item.label)
        }
      }
      HStack(spacing: 4) {
        Capsule()
          .stroke(Color.accentColor, style: StrokeStyle(lineWidth: 1.4, dash: [4, 3]))
          .frame(width: 13, height: 5)
        Text("反馈 / 重试")
      }
      Spacer(minLength: 8)
      Text("\(tasks.count) 个任务")
      HStack(spacing: 2) {
        Button { stepZoom(1 / 1.25, viewport: viewport) } label: { Image(systemName: "minus") }
          .disabled(zoom <= minZoom + 0.001)
        // 百分比本身就是复位按钮 —— 拖远了、缩过头了,这里一下回到原点。
        Button(action: reset) {
          Text("\(Int((zoom * 100).rounded()))%")
            .monospacedDigit()
            .frame(width: 34)
        }
        .help("复位:100% 并回到起点")
        Button { stepZoom(1.25, viewport: viewport) } label: { Image(systemName: "plus") }
          .disabled(zoom >= maxZoom - 0.001)
        Button {
          fitToWindow(layout: layout, viewport: viewport)
        } label: {
          Image(systemName: "arrow.up.left.and.down.right.magnifyingglass")
        }
        .help("适应窗口:整张图缩放并居中")
      }
      .buttonStyle(.borderless)
      .font(.system(size: 9))
    }
    .font(.system(size: 9))
    .foregroundStyle(.secondary)
    .padding(.horizontal, 10)
    .padding(.vertical, 5)
    .background(.quaternary.opacity(0.24))
  }

  /// 整张图塞进可视区所需的倍数。传进来的 viewport 已经扣掉控件条的高度。
  private func fitScale(layout: Layout, viewport: CGSize) -> CGFloat {
    guard layout.size.width > 0, layout.size.height > 0,
          viewport.width > 0, viewport.height > 0 else { return 1 }
    return clamp(min(viewport.width / layout.size.width, viewport.height / layout.size.height))
  }

  /// 通用分层 DAG 布局:x 是拓扑层级,y 是后继分支的重心。
  ///
  /// 叶子从上到下稳定排列，父节点落在所有后继的平均高度；因此入口会自然位于
  /// 整体高度中线，任何中途分叉也会展开，而不是把同一列机械地从顶部往下堆。
  /// 成环由 daemon 在建图时就拒绝了,这里的 stack 只是防御 —— 快照里真出现环,
  /// 也只是画得难看,不能让 UI 递归到爆栈。
  private func makeLayout() -> Layout {
    let taskById = Dictionary(uniqueKeysWithValues: tasks.map { ($0.id, $0) })
    var memo: [String: Int] = [:]
    func level(_ id: String, stack: Set<String> = []) -> Int {
      if let cached = memo[id] { return cached }
      guard !stack.contains(id), let task = taskById[id] else { return 0 }
      let nextStack = stack.union([id])
      let ancestors = Array(Set(task.deps + [task.parentId].compactMap { $0 }))
        .filter { taskById[$0] != nil }
      let value = ancestors.isEmpty
        ? 0
        : (ancestors.map { level($0, stack: nextStack) }.max() ?? -1) + 1
      memo[id] = value
      return value
    }

    for task in tasks { _ = level(task.id) }

    var successors: [String: Set<String>] = [:]
    for task in tasks {
      let ancestors = Array(Set(task.deps + [task.parentId].compactMap { $0 }))
        .filter { taskById[$0] != nil }
      for ancestor in ancestors {
        successors[ancestor, default: []].insert(task.id)
      }
    }

    func taskSort(_ lhs: OrchestrationStatus.Task, _ rhs: OrchestrationStatus.Task) -> Bool {
      if lhs.createdAt != rhs.createdAt { return lhs.createdAt < rhs.createdAt }
      return lhs.id < rhs.id
    }

    var tasksByColumn: [Int: [OrchestrationStatus.Task]] = [:]
    for task in tasks { tasksByColumn[memo[task.id] ?? 0, default: []].append(task) }
    let columns = (memo.values.max() ?? 0) + 1
    let maxColumnCount = max(tasksByColumn.values.map(\.count).max() ?? 1, 1)

    // 以 DFS 顺序收集叶子，保证同一分支的叶子相邻，减少长距离交叉线。
    let roots = tasks.filter { (memo[$0.id] ?? 0) == 0 }.sorted(by: taskSort)
    var orderedLeaves: [String] = []
    var visited: Set<String> = []
    func collectLeaves(_ id: String, stack: Set<String> = []) {
      guard !stack.contains(id), !visited.contains(id) else { return }
      let children = (successors[id] ?? []).compactMap { taskById[$0] }.sorted(by: taskSort)
      if children.isEmpty {
        visited.insert(id)
        orderedLeaves.append(id)
        return
      }
      let nextStack = stack.union([id])
      for child in children { collectLeaves(child.id, stack: nextStack) }
      visited.insert(id)
    }
    for root in roots { collectLeaves(root.id) }
    for task in tasks.sorted(by: taskSort) where (successors[task.id] ?? []).isEmpty {
      if !orderedLeaves.contains(task.id) { orderedLeaves.append(task.id) }
    }

    let slotCount = max(orderedLeaves.count, maxColumnCount, 1)
    let slotStep = nodeHeight + vGap
    let contentHeight = CGFloat(slotCount) * nodeHeight
      + CGFloat(max(slotCount - 1, 0)) * vGap
    let leafContentHeight = CGFloat(max(orderedLeaves.count, 1)) * nodeHeight
      + CGFloat(max(orderedLeaves.count - 1, 0)) * vGap
    let leafTop = margin + runGraphCenteredOffset(
      containerHeight: contentHeight,
      contentHeight: leafContentHeight
    )
    var leafY: [String: CGFloat] = [:]
    for (index, id) in orderedLeaves.enumerated() {
      leafY[id] = leafTop + nodeHeight / 2 + CGFloat(index) * slotStep
    }

    var desiredMemo: [String: CGFloat] = [:]
    func desiredY(_ id: String, stack: Set<String> = []) -> CGFloat {
      if let cached = desiredMemo[id] { return cached }
      if let leaf = leafY[id] { desiredMemo[id] = leaf; return leaf }
      guard !stack.contains(id) else { return margin + contentHeight / 2 }
      let nextStack = stack.union([id])
      let values = (successors[id] ?? []).map { desiredY($0, stack: nextStack) }
      let value = values.isEmpty
        ? margin + contentHeight / 2
        : values.reduce(0, +) / CGFloat(values.count)
      desiredMemo[id] = value
      return value
    }
    for task in tasks { _ = desiredY(task.id) }
    if roots.count == 1, let rootId = roots.first?.id {
      desiredMemo[rootId] = margin + contentHeight / 2
    }

    let canvasHeight = margin * 2 + contentHeight
    let canvasWidth = margin * 2 + CGFloat(columns) * nodeWidth
      + CGFloat(max(columns - 1, 0)) * hGap

    // 同列节点按目标重心排序，再以目标平均值为轴对称压排，避免节点碰撞的同时
    // 保持入口/分叉/合流的视觉中心不漂移到顶部或底部。
    var positions: [String: CGPoint] = [:]
    for (column, columnTasks) in tasksByColumn {
      let ordered = columnTasks.sorted {
        let left = desiredMemo[$0.id] ?? 0
        let right = desiredMemo[$1.id] ?? 0
        if left != right { return left < right }
        return taskSort($0, $1)
      }
      var placed: [CGFloat] = []
      for task in ordered {
        let target = desiredMemo[task.id] ?? margin + contentHeight / 2
        let minimum = (placed.last ?? -CGFloat.greatestFiniteMagnitude) + slotStep
        placed.append(max(target, minimum))
      }
      if !placed.isEmpty {
        let desiredAverage = ordered.map { desiredMemo[$0.id] ?? 0 }.reduce(0, +)
          / CGFloat(ordered.count)
        let placedAverage = placed.reduce(0, +) / CGFloat(placed.count)
        let lowerBound = margin + nodeHeight / 2
        let upperBound = canvasHeight - margin - nodeHeight / 2
        var shift = desiredAverage - placedAverage
        if let first = placed.first, first + shift < lowerBound { shift = lowerBound - first }
        if let last = placed.last, last + shift > upperBound { shift = upperBound - last }
        for index in placed.indices { placed[index] += shift }
      }
      for (index, task) in ordered.enumerated() {
        positions[task.id] = CGPoint(
          x: margin + nodeWidth / 2 + CGFloat(column) * (nodeWidth + hGap),
          y: placed[index]
        )
      }
    }

    var feedbackGroups: [String: [OrchestrationStatus.Task]] = [:]
    for task in tasks {
      guard let parentId = task.parentId, taskById[parentId] != nil else { continue }
      feedbackGroups[parentId, default: []].append(task)
    }
    let feedbackEdges = feedbackGroups.values.compactMap { candidates -> Layout.FeedbackEdge? in
      guard let target = candidates.sorted(by: {
        let leftLevel = memo[$0.id] ?? 0
        let rightLevel = memo[$1.id] ?? 0
        if leftLevel != rightLevel { return leftLevel < rightLevel }
        return taskSort($0, $1)
      }).first,
      let parentId = target.parentId,
      let parent = taskById[parentId] else { return nil }
      return .init(
        fromTaskId: parentId,
        toTaskId: target.id,
        label: runGraphLineageLabel(parentResult: parent.result)
      )
    }

    return Layout(
      positions: positions,
      feedbackEdges: feedbackEdges,
      size: CGSize(
        width: canvasWidth,
        height: canvasHeight
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

    if runGraphTaskWasSuperseded(task: task, all: all) {
      label = "已回退"
      color = .blue
      return
    }

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
    ("已回退", .blue),
    ("失败", .red),
    ("阻塞", .yellow),
  ]
}

/// 任务区域的视图模式。@AppStorage 要求 RawRepresentable。
enum RunTaskView: String {
  case list
  case graph
}
