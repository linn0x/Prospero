import SwiftUI

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
    var positions: [String: CGPoint]
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

  private func controls(layout: Layout, viewport: CGSize) -> some View {
    HStack(spacing: 12) {
      ForEach(RunTaskState.legend, id: \.label) { item in
        HStack(spacing: 4) {
          Circle().fill(item.color).frame(width: 5, height: 5)
          Text(item.label)
        }
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
