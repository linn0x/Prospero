using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using Forms = System.Windows.Forms;

namespace Prospero.WindowsShell
{
    internal sealed class NewSessionOptions { public string Agent; public string Kind; public string Policy; public string WorkingDirectory; }
    internal sealed class AccountCreateOptions { public string Agent; public string Name; }
    internal sealed class ApiProfileOptions { public string Agent; public string Name; public string BaseUrl; public string Model; public string ApiKey; }
    internal sealed class CredentialOptions { public string Kind; public string Secret; }
    internal sealed class WorkerOptions { public string Agent; public string Workspace; public string Policy; public string WorkingDirectory; }

    internal static class WpfDialogs
    {
        private static Style Style(string name) { return (Style)Application.Current.FindResource(name); }

        public static void Error(Window owner, string value) { new MessageDialog(owner, "出现问题", value, false, false).ShowDialog(); }
        public static void Info(Window owner, string value) { new MessageDialog(owner, "Prospero", value, false, false).ShowDialog(); }
        public static bool Confirm(Window owner, string value) { return new MessageDialog(owner, "请确认", value, true, true).ShowDialog() == true; }
        public static string Prompt(Window owner, string title, string label, string initial, bool secret)
        {
            PromptDialog dialog = new PromptDialog(owner, title, label, initial, secret); return dialog.ShowDialog() == true ? dialog.Value : null;
        }
        public static void ShowPairing(Window owner, ProsperoController controller) { new PairingDialog(owner, controller).ShowDialog(); }
        public static void ShowSession(Window owner, ProsperoController controller, SessionInfo session) { new SessionWindow(owner, controller, session).Show(); }

        public static NewSessionOptions NewSession(Window owner, string initial)
        {
            FormDialog dialog = new FormDialog(owner, "新建会话", 580, 420);
            ComboBox agent = Combo("codex", "claude", "opencode", "deepseek", "grok", "trae", "shell");
            ComboBox kind = Combo("structured", "pty"); ComboBox policy = Combo("standard", "strict", "yolo");
            TextBox cwd = new TextBox { Text = string.IsNullOrWhiteSpace(initial) ? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) : initial };
            Button browse = new Button { Content = "浏览…" }; browse.Click += delegate { using (Forms.FolderBrowserDialog f = new Forms.FolderBrowserDialog()) if (f.ShowDialog() == Forms.DialogResult.OK) cwd.Text = f.SelectedPath; };
            dialog.AddRow("Agent", agent); dialog.AddRow("会话类型", kind); dialog.AddRow("审批策略", policy); dialog.AddRow("项目目录", cwd, browse);
            Action update = delegate
            {
                string a = Convert.ToString(agent.SelectedItem); bool structured = a == "codex" || a == "claude" || a == "opencode";
                kind.IsEnabled = structured; if (!structured) kind.SelectedItem = "pty"; policy.IsEnabled = structured && Convert.ToString(kind.SelectedItem) == "structured";
            };
            agent.SelectionChanged += delegate { update(); }; kind.SelectionChanged += delegate { update(); }; update();
            if (dialog.ShowForm("启动", delegate { return Directory.Exists(cwd.Text.Trim()) || Fail(dialog, "项目目录不存在"); }) != true) return null;
            return new NewSessionOptions { Agent = Convert.ToString(agent.SelectedItem), Kind = Convert.ToString(kind.SelectedItem), Policy = Convert.ToString(policy.SelectedItem), WorkingDirectory = cwd.Text.Trim() };
        }

        public static AccountCreateOptions AccountCreate(Window owner)
        {
            FormDialog dialog = new FormDialog(owner, "新增独立账号", 480, 300); ComboBox agent = Combo("codex", "claude"); TextBox name = new TextBox(); dialog.AddRow("Agent", agent); dialog.AddRow("名称", name);
            if (dialog.ShowForm("保存", delegate { return !string.IsNullOrWhiteSpace(name.Text) || Fail(dialog, "请输入账号名称"); }) != true) return null;
            return new AccountCreateOptions { Agent = Convert.ToString(agent.SelectedItem), Name = name.Text.Trim() };
        }

        public static ApiProfileOptions ApiProfile(Window owner, AccountInfo existing)
        {
            FormDialog dialog = new FormDialog(owner, existing == null ? "新增 API Profile" : "配置 API Profile", 620, 500);
            ComboBox agent = Combo("codex", "claude"); agent.SelectedItem = existing == null ? "codex" : existing.Agent; agent.IsEnabled = existing == null;
            TextBox name = new TextBox { Text = existing == null ? "" : existing.Name, IsEnabled = existing == null };
            TextBox baseUrl = new TextBox { Text = existing == null ? "" : existing.BaseUrl }; TextBox model = new TextBox { Text = existing == null ? "" : existing.Model }; PasswordBox key = new PasswordBox();
            dialog.AddRow("Agent", agent); dialog.AddRow("Profile 名称", name); dialog.AddRow("API 地址", baseUrl); dialog.AddRow("模型", model); dialog.AddRow("API Key", key);
            dialog.AddNote("API Key 只写入账号私有安全存储；重新配置时必须再次输入。");
            if (dialog.ShowForm("保存", delegate
            {
                if (string.IsNullOrWhiteSpace(name.Text) || string.IsNullOrWhiteSpace(baseUrl.Text) || string.IsNullOrWhiteSpace(model.Text) || key.Password.Length == 0) return Fail(dialog, "请填写全部字段");
                Uri uri; bool valid = Uri.TryCreate(baseUrl.Text.Trim(), UriKind.Absolute, out uri) && (uri.Scheme == "https" || (uri.Scheme == "http" && (uri.Host == "localhost" || uri.Host == "127.0.0.1" || uri.Host == "::1")));
                return valid || Fail(dialog, "API 地址必须是 HTTPS；本机 localhost 可使用 HTTP");
            }) != true) return null;
            return new ApiProfileOptions { Agent = Convert.ToString(agent.SelectedItem), Name = name.Text.Trim(), BaseUrl = baseUrl.Text.Trim(), Model = model.Text.Trim(), ApiKey = key.Password };
        }

        public static CredentialOptions Credential(Window owner, string agent)
        {
            FormDialog dialog = new FormDialog(owner, "安全导入凭据", 560, 350); ComboBox kind = Combo("api_key", "oauth_token"); kind.SelectedItem = agent == "claude" ? "oauth_token" : "api_key"; PasswordBox secret = new PasswordBox();
            dialog.AddRow("凭据类型", kind); dialog.AddRow("凭据", secret); dialog.AddNote("凭据只会通过本机鉴权接口写入账号私有存储，不会显示在状态或日志中。");
            if (dialog.ShowForm("保存", delegate { return secret.Password.Length > 0 || Fail(dialog, "请输入凭据"); }) != true) return null;
            return new CredentialOptions { Kind = Convert.ToString(kind.SelectedItem), Secret = secret.Password };
        }

        public static WorkerOptions Worker(Window owner, bool automation)
        {
            FormDialog dialog = new FormDialog(owner, automation ? "启动自动编排" : "启动 Worker", 600, 450);
            ComboBox agent = Combo("codex", "claude", "opencode", "deepseek", "grok"); ComboBox workspace = automation ? Combo("run", "current") : Combo("new", "none"); ComboBox policy = Combo("standard", "strict", "yolo"); TextBox cwd = new TextBox { Text = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) };
            Button browse = new Button { Content = "浏览…" }; browse.Click += delegate { using (Forms.FolderBrowserDialog f = new Forms.FolderBrowserDialog()) if (f.ShowDialog() == Forms.DialogResult.OK) cwd.Text = f.SelectedPath; };
            dialog.AddRow("Agent", agent); dialog.AddRow(automation ? "工作区" : "新 worktree", workspace); dialog.AddRow("审批策略", policy); dialog.AddRow("项目目录", cwd, browse);
            if (dialog.ShowForm("启动", delegate { return Directory.Exists(cwd.Text.Trim()) || Fail(dialog, "项目目录不存在"); }) != true) return null;
            if (Convert.ToString(policy.SelectedItem) == "yolo" && !Confirm(dialog, "YOLO 会自动批准 Agent 操作，确定继续？")) return null;
            return new WorkerOptions { Agent = Convert.ToString(agent.SelectedItem), Workspace = Convert.ToString(workspace.SelectedItem), Policy = Convert.ToString(policy.SelectedItem), WorkingDirectory = cwd.Text.Trim() };
        }

        private static ComboBox Combo(params string[] values) { ComboBox box = new ComboBox(); foreach (string value in values) box.Items.Add(value); if (box.Items.Count > 0) box.SelectedIndex = 0; return box; }
        private static bool Fail(Window owner, string value) { Error(owner, value); return false; }

        private sealed class MessageDialog : Window
        {
            public MessageDialog(Window owner, string title, string value, bool confirm, bool warning)
            {
                Owner = owner; Title = title; Width = 480; SizeToContent = SizeToContent.Height; MinHeight = 190; WindowStartupLocation = WindowStartupLocation.CenterOwner; ResizeMode = ResizeMode.NoResize; ShowInTaskbar = false;
                ThemeManager.ApplyWindow(this);
                Grid root = new Grid { Margin = new Thickness(24) }; root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto }); root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
                TextBlock heading = new TextBlock { Text = title, FontSize = 22, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 0, 0, 14) };
                TextBlock body = new TextBlock { Text = value, TextWrapping = TextWrapping.Wrap, MaxHeight = 420, Margin = new Thickness(0, 0, 0, 22) }; Grid.SetRow(body, 1);
                StackPanel actions = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right }; Grid.SetRow(actions, 2);
                if (confirm) { Button cancel = new Button { Content = "取消" }; cancel.Click += delegate { DialogResult = false; }; actions.Children.Add(cancel); }
                Button ok = new Button { Content = confirm ? "确认" : "知道了", Style = Style(warning ? "DangerButton" : "PrimaryButton"), Margin = new Thickness(0) }; ok.Click += delegate { DialogResult = true; }; actions.Children.Add(ok);
                root.Children.Add(heading); root.Children.Add(body); root.Children.Add(actions); Content = root;
            }
        }

        private sealed class PromptDialog : Window
        {
            private readonly TextBox text; private readonly PasswordBox password; public string Value { get { return password == null ? text.Text : password.Password; } }
            public PromptDialog(Window owner, string title, string label, string initial, bool secret)
            {
                Owner = owner; Title = title; Width = 520; Height = 240; WindowStartupLocation = WindowStartupLocation.CenterOwner; ResizeMode = ResizeMode.NoResize; ShowInTaskbar = false; ThemeManager.ApplyWindow(this);
                Grid grid = new Grid { Margin = new Thickness(24) }; for (int i = 0; i < 4; i++) grid.RowDefinitions.Add(new RowDefinition { Height = i == 2 ? new GridLength(1, GridUnitType.Star) : GridLength.Auto });
                TextBlock heading = new TextBlock { Text = title, FontSize = 22, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 0, 0, 14) }; TextBlock caption = new TextBlock { Text = label, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 10) }; Grid.SetRow(caption, 1);
                Control editor; if (secret) { password = new PasswordBox { Password = initial ?? "" }; editor = password; } else { text = new TextBox { Text = initial ?? "" }; editor = text; } Grid.SetRow(editor, 2);
                StackPanel actions = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 18, 0, 0) }; Grid.SetRow(actions, 3); Button cancel = new Button { Content = "取消" }; cancel.Click += delegate { DialogResult = false; }; Button ok = new Button { Content = "确定", Style = Style("PrimaryButton"), Margin = new Thickness(0) }; ok.Click += delegate { DialogResult = true; }; actions.Children.Add(cancel); actions.Children.Add(ok);
                grid.Children.Add(heading); grid.Children.Add(caption); grid.Children.Add(editor); grid.Children.Add(actions); Content = grid; Loaded += delegate { editor.Focus(); };
            }
        }

        private sealed class FormDialog : Window
        {
            private readonly Grid form = new Grid(); private readonly StackPanel content = new StackPanel(); private Func<bool> validator;
            public FormDialog(Window owner, string title, double width, double height)
            {
                Owner = owner; Title = title; Width = width; Height = height; MinHeight = 260; WindowStartupLocation = WindowStartupLocation.CenterOwner; ResizeMode = ResizeMode.NoResize; ShowInTaskbar = false; ThemeManager.ApplyWindow(this);
                content.Margin = new Thickness(26); content.Children.Add(new TextBlock { Text = title, FontSize = 25, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 0, 0, 18) });
                form.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(130) }); form.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) }); form.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); content.Children.Add(form); Content = content;
            }
            public void AddRow(string label, Control control, Button extra = null)
            {
                int row = form.RowDefinitions.Count; form.RowDefinitions.Add(new RowDefinition { Height = new GridLength(52) }); TextBlock caption = new TextBlock { Text = label, VerticalAlignment = VerticalAlignment.Center }; Grid.SetRow(caption, row); form.Children.Add(caption);
                control.Margin = new Thickness(0, 6, extra == null ? 0 : 8, 6); Grid.SetRow(control, row); Grid.SetColumn(control, 1); form.Children.Add(control);
                if (extra != null) { extra.Margin = new Thickness(0, 6, 0, 6); Grid.SetRow(extra, row); Grid.SetColumn(extra, 2); form.Children.Add(extra); }
            }
            public void AddNote(string value) { content.Children.Add(new TextBlock { Text = value, TextWrapping = TextWrapping.Wrap, Foreground = (Brush)FindResource("MutedBrush"), Margin = new Thickness(130, 8, 0, 0) }); }
            public bool? ShowForm(string primary, Func<bool> validate)
            {
                validator = validate; StackPanel actions = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 20, 0, 0) }; Button cancel = new Button { Content = "取消" }; cancel.Click += delegate { DialogResult = false; }; Button ok = new Button { Content = primary, Style = Style("PrimaryButton"), Margin = new Thickness(0) }; ok.Click += delegate { if (validator == null || validator()) DialogResult = true; }; actions.Children.Add(cancel); actions.Children.Add(ok); content.Children.Add(actions); return ShowDialog();
            }
        }
    }

    internal sealed class PairingDialog : Window
    {
        private readonly ProsperoController controller; private readonly TextBox name = new TextBox { Text = "my-phone", FontSize = 15, VerticalContentAlignment = VerticalAlignment.Center }; private readonly CheckBox shell = new CheckBox { Content = "允许 shell 会话（完整用户权限）", IsChecked = true }; private readonly CheckBox orchestration = new CheckBox { Content = "允许手工编排与派发 worker", IsChecked = true }; private readonly WpfQrCodeView qr = new WpfQrCodeView(); private readonly Button generate; private string uri = "";
        public PairingDialog(Window owner, ProsperoController controller)
        {
            this.controller = controller; Owner = owner; Title = "配对新设备"; Width = 880; Height = 900; MinWidth = 720; MinHeight = 680; WindowStartupLocation = WindowStartupLocation.CenterOwner; ThemeManager.ApplyWindow(this);
            Grid root = new Grid { Margin = new Thickness(28, 20, 28, 24) }; root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(58) }); root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(52) }); root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(40) }); root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(40) }); root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(52) }); root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) }); root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(34) });
            TextBlock title = new TextBlock { Text = "配对新设备", FontSize = 28, FontWeight = FontWeights.SemiBold }; root.Children.Add(title);
            Grid device = new Grid(); device.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(90) }); device.ColumnDefinitions.Add(new ColumnDefinition()); device.Children.Add(new TextBlock { Text = "设备名", VerticalAlignment = VerticalAlignment.Center }); Grid.SetColumn(name, 1); name.Margin = new Thickness(0, 6, 0, 6); device.Children.Add(name); Grid.SetRow(device, 1); root.Children.Add(device);
            shell.Style = (Style)FindResource("ToggleSwitch"); orchestration.Style = (Style)FindResource("ToggleSwitch"); Grid.SetRow(shell, 2); Grid.SetRow(orchestration, 3); root.Children.Add(shell); root.Children.Add(orchestration); shell.Click += delegate { orchestration.IsEnabled = shell.IsChecked == true; if (shell.IsChecked != true) orchestration.IsChecked = false; };
            StackPanel buttons = new StackPanel { Orientation = Orientation.Horizontal }; generate = new Button { Content = "生成二维码", Style = (Style)FindResource("PrimaryButton") }; generate.Click += async delegate { await Generate(); }; Button copy = new Button { Content = "复制配对串" }; copy.Click += delegate { if (uri.Length > 0) Clipboard.SetText(uri); }; buttons.Children.Add(generate); buttons.Children.Add(copy); Grid.SetRow(buttons, 4); root.Children.Add(buttons);
            Border card = new Border { Background = (Brush)FindResource("TerminalBrush"), BorderBrush = (Brush)FindResource("BorderBrush"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(14), Padding = new Thickness(16), Child = qr, Margin = new Thickness(0, 4, 0, 8) }; Grid.SetRow(card, 5); root.Children.Add(card);
            TextBlock warning = new TextBlock { Text = "二维码含访问凭证，请勿截图或外传。", Foreground = (Brush)FindResource("OrangeBrush"), VerticalAlignment = VerticalAlignment.Center }; Grid.SetRow(warning, 6); root.Children.Add(warning); Content = root;
            Loaded += delegate { name.SelectionLength = 0; name.CaretIndex = name.Text.Length; generate.Focus(); };
        }
        private async Task Generate() { generate.IsEnabled = false; qr.Content = "正在生成…"; PairingResult result = await controller.PairDeviceAsync(name.Text.Trim(), shell.IsChecked == true, orchestration.IsChecked == true); uri = result.PairingUri; qr.Content = result.Output; if (!result.Success) WpfDialogs.Error(this, result.Output); generate.IsEnabled = true; }
        public void SetPreviewOutput(string value) { qr.Content = value; }
    }

    internal sealed class WpfQrCodeView : FrameworkElement
    {
        private string content = ""; public string Content { get { return content; } set { content = value ?? ""; InvalidateVisual(); } }
        protected override void OnRender(DrawingContext dc)
        {
            base.OnRender(dc); Brush background = (Brush)FindResource("TerminalBrush"); dc.DrawRectangle(background, null, new Rect(RenderSize));
            string[] source = content.Replace("\r", "").Split('\n'); List<string> qr = new List<string>(); foreach (string line in source) if (line.IndexOf('█') >= 0 || line.IndexOf('▀') >= 0 || line.IndexOf('▄') >= 0) qr.Add(line);
            if (qr.Count == 0)
            {
                FormattedText text = new FormattedText(string.IsNullOrWhiteSpace(content) ? "生成后将在这里显示完整二维码" : content, System.Globalization.CultureInfo.CurrentUICulture, FlowDirection.LeftToRight, new Typeface("Segoe UI"), 14, (Brush)FindResource("TerminalTextBrush"), 1.0); text.MaxTextWidth = Math.Max(20, ActualWidth - 36); text.MaxTextHeight = Math.Max(20, ActualHeight - 36); dc.DrawText(text, new Point(18, 18)); return;
            }
            int columns = 0; foreach (string line in qr) columns = Math.Max(columns, line.Length); double scale = Math.Max(1, Math.Floor(Math.Min((ActualWidth - 40) / columns, (ActualHeight - 40) / (qr.Count * 2)))); double width = columns * scale; double height = qr.Count * scale * 2; double ox = (ActualWidth - width) / 2; double oy = (ActualHeight - height) / 2;
            for (int row = 0; row < qr.Count; row++) for (int column = 0; column < qr[row].Length; column++) { char cell = qr[row][column]; double x = ox + column * scale; double y = oy + row * scale * 2; if (cell == '█') dc.DrawRectangle(Brushes.White, null, new Rect(x, y, scale, scale * 2)); else if (cell == '▀') dc.DrawRectangle(Brushes.White, null, new Rect(x, y, scale, scale)); else if (cell == '▄') dc.DrawRectangle(Brushes.White, null, new Rect(x, y + scale, scale, scale)); }
        }
    }

    internal sealed class SessionWindow : Window
    {
        private readonly ProsperoController controller; private readonly SessionInfo session; private readonly TextBox timeline = new TextBox(); private readonly TextBox composer = new TextBox(); private readonly Button once; private readonly Button always; private readonly Button reject; private readonly Button answer; private readonly DispatcherTimer timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(800) }; private bool loading; private string pendingPermission; private string pendingQuestion; private readonly List<Dictionary<string, object>> pendingQuestions = new List<Dictionary<string, object>>();
        public SessionWindow(Window owner, ProsperoController controller, SessionInfo session)
        {
            Owner = owner; this.controller = controller; this.session = session; Title = session.Title + " — " + session.Agent; Width = 1000; Height = 760; MinWidth = 760; MinHeight = 560; WindowStartupLocation = WindowStartupLocation.CenterOwner; ThemeManager.ApplyWindow(this);
            Grid root = new Grid(); root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(70) }); root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) }); root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(150) });
            Border header = new Border { Background = (Brush)FindResource("SurfaceBrush"), Padding = new Thickness(20, 12, 20, 12) }; header.Child = new TextBlock { Text = session.Title + "\n" + session.Agent + " · " + session.Kind + " · " + session.Cwd, FontWeight = FontWeights.SemiBold }; root.Children.Add(header);
            timeline.IsReadOnly = true; timeline.AcceptsReturn = true; timeline.TextWrapping = session.Kind == "pty" ? TextWrapping.NoWrap : TextWrapping.Wrap; timeline.VerticalScrollBarVisibility = ScrollBarVisibility.Auto; timeline.HorizontalScrollBarVisibility = ScrollBarVisibility.Auto; timeline.Background = (Brush)FindResource("TerminalBrush"); timeline.Foreground = (Brush)FindResource("TerminalTextBrush"); timeline.FontFamily = new FontFamily(session.Kind == "pty" ? "Cascadia Mono, Microsoft YaHei UI" : "Segoe UI Variable Text, Microsoft YaHei UI"); timeline.BorderThickness = new Thickness(0); timeline.Padding = new Thickness(18); Grid.SetRow(timeline, 1); root.Children.Add(timeline);
            Grid compose = new Grid { Margin = new Thickness(16, 12, 16, 12) }; compose.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) }); compose.RowDefinitions.Add(new RowDefinition { Height = new GridLength(48) }); composer.AcceptsReturn = true; composer.VerticalScrollBarVisibility = ScrollBarVisibility.Auto; compose.Children.Add(composer);
            WrapPanel actions = new WrapPanel { Margin = new Thickness(0, 10, 0, 0) }; Button send = new Button { Content = session.Kind == "pty" ? "发送输入" : "发送消息", Style = (Style)FindResource("PrimaryButton") }; send.Click += async delegate { await Send(); }; Button interrupt = new Button { Content = "中断 Ctrl+C" }; interrupt.Click += async delegate { await Interrupt(); }; once = new Button { Content = "允许一次" }; always = new Button { Content = "本会话始终允许" }; reject = new Button { Content = "拒绝" }; answer = new Button { Content = "回答问题" }; once.Click += async delegate { await Permission("once"); }; always.Click += async delegate { await Permission("always"); }; reject.Click += async delegate { await Permission("reject"); }; answer.Click += async delegate { await Answer(); }; actions.Children.Add(send); actions.Children.Add(interrupt); actions.Children.Add(once); actions.Children.Add(always); actions.Children.Add(reject); actions.Children.Add(answer); Grid.SetRow(actions, 1); compose.Children.Add(actions); Grid.SetRow(compose, 2); root.Children.Add(compose); Content = root;
            composer.KeyDown += async delegate(object s, KeyEventArgs e) { if (e.Key == Key.Enter && Keyboard.Modifiers.HasFlag(ModifierKeys.Control)) { e.Handled = true; await Send(); } }; timer.Tick += async delegate { await RefreshView(); }; Loaded += async delegate { timer.Start(); await RefreshView(); }; Closed += delegate { timer.Stop(); };
        }
        private async Task RefreshView()
        {
            if (loading) return; loading = true; try { Dictionary<string, object> root = JsonValue.ParseObject(await controller.LoadSessionViewAsync(session.Id)); string error = JsonValue.String(root, "error", ""); if (error.Length > 0) timeline.Text = error; else timeline.Text = JsonValue.String(root, "kind", session.Kind) == "pty" ? RenderTerminal(root) : RenderStructured(root); timeline.ScrollToEnd(); SetButtons(); } catch (Exception error) { timeline.Text = error.Message; } finally { loading = false; }
        }
        private static string RenderTerminal(Dictionary<string, object> root) { string value = JsonValue.String(root, "ansi", ""); value = Regex.Replace(value, @"\x1B\][^\x07]*(?:\x07|\x1B\\)", ""); value = Regex.Replace(value, @"\x1B\[[0-?]*[ -/]*[@-~]", ""); return value.Replace("\r", ""); }
        private string RenderStructured(Dictionary<string, object> root)
        {
            StringBuilder text = new StringBuilder(); pendingPermission = null; pendingQuestion = null; pendingQuestions.Clear(); Dictionary<string, bool> permissions = new Dictionary<string, bool>(); Dictionary<string, List<Dictionary<string, object>>> questions = new Dictionary<string, List<Dictionary<string, object>>>(); object raw; string last = null;
            foreach (object item in root.TryGetValue("events", out raw) ? JsonValue.AsArray(raw) : new object[0]) { Dictionary<string, object> entry = JsonValue.AsObject(item); string kind = JsonValue.String(entry, "kind", ""); if (kind == "user.message") text.AppendLine().Append("你：").AppendLine(JsonValue.String(entry, "text", "")); else if (kind == "text.delta") { string id = JsonValue.String(entry, "msgId", ""); if (id != last) { text.AppendLine().Append("Agent："); last = id; } text.Append(JsonValue.String(entry, "delta", "")); } else if (kind == "tool.start") text.AppendLine().Append("\n[工具] ").Append(JsonValue.String(entry, "tool", "")).Append(" — ").AppendLine(JsonValue.String(entry, "summary", "")); else if (kind == "tool.end") text.Append("[工具结果] ").Append(JsonValue.String(entry, "state", "")).Append(" — ").AppendLine(JsonValue.String(entry, "summary", "")); else if (kind == "permission.request") { string id = JsonValue.String(entry, "reqId", ""); permissions[id] = true; text.Append("\n[等待审批] ").AppendLine(JsonValue.String(entry, "summary", "")); } else if (kind == "permission.resolved") permissions.Remove(JsonValue.String(entry, "reqId", "")); else if (kind == "question.request") { string id = JsonValue.String(entry, "reqId", ""); List<Dictionary<string, object>> list = new List<Dictionary<string, object>>(); object qraw; foreach (object q in entry.TryGetValue("questions", out qraw) ? JsonValue.AsArray(qraw) : new object[0]) { Dictionary<string, object> value = JsonValue.AsObject(q); list.Add(value); text.Append("\n[Agent 提问] ").AppendLine(JsonValue.String(value, "question", "")); } questions[id] = list; } else if (kind == "question.resolved") questions.Remove(JsonValue.String(entry, "reqId", "")); else if (kind == "agent.error") text.Append("\n[错误] ").AppendLine(JsonValue.String(entry, "message", "")); else if (kind == "turn.end") text.AppendLine().AppendLine("—— 回合结束 ——"); }
            foreach (KeyValuePair<string, bool> p in permissions) { pendingPermission = p.Key; break; } foreach (KeyValuePair<string, List<Dictionary<string, object>>> q in questions) { pendingQuestion = q.Key; pendingQuestions.AddRange(q.Value); break; } return text.ToString();
        }
        private async Task Send() { string value = composer.Text; if (value.Length == 0) return; Dictionary<string, object> body = new Dictionary<string, object>(); if (session.Kind == "pty") { body["type"] = "term.input"; body["dataB64"] = Convert.ToBase64String(Encoding.UTF8.GetBytes(value + "\r")); } else { body["type"] = "chat.send"; body["text"] = value; } string error = await controller.InteractSessionAsync(session.Id, body); if (error == null) composer.Clear(); else WpfDialogs.Error(this, error); await RefreshView(); }
        private async Task Interrupt() { if (session.Kind == "pty") { Dictionary<string, object> body = new Dictionary<string, object> { { "type", "term.input" }, { "dataB64", Convert.ToBase64String(new byte[] { 3 }) } }; string e = await controller.InteractSessionAsync(session.Id, body); if (e != null) WpfDialogs.Error(this, e); } else { string e = await controller.ControlSessionAsync(session.Id, "interrupt"); if (e != null) WpfDialogs.Error(this, e); } }
        private async Task Permission(string reply) { if (pendingPermission == null) return; string e = await controller.InteractSessionAsync(session.Id, new Dictionary<string, object> { { "type", "permission.respond" }, { "reqId", pendingPermission }, { "reply", reply } }); if (e != null) WpfDialogs.Error(this, e); await RefreshView(); }
        private async Task Answer() { if (pendingQuestion == null) return; List<Dictionary<string, object>> answers = new List<Dictionary<string, object>>(); foreach (Dictionary<string, object> q in pendingQuestions) { string value = WpfDialogs.Prompt(this, "Agent 提问", JsonValue.String(q, "question", "请回答"), "", JsonValue.Bool(q, "secret", false)); if (value == null) return; answers.Add(new Dictionary<string, object> { { "questionId", JsonValue.String(q, "id", "") }, { "values", new string[] { value } } }); } string e = await controller.InteractSessionAsync(session.Id, new Dictionary<string, object> { { "type", "question.respond" }, { "reqId", pendingQuestion }, { "answers", answers.ToArray() }, { "cancelled", false } }); if (e != null) WpfDialogs.Error(this, e); await RefreshView(); }
        private void SetButtons() { bool permission = pendingPermission != null; once.IsEnabled = always.IsEnabled = reject.IsEnabled = permission; answer.IsEnabled = pendingQuestion != null; }
    }
}
