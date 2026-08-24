using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using Microsoft.Win32;
using Forms = System.Windows.Forms;

namespace Prospero.WindowsShell
{
    internal sealed class ProjectRow { public string Name { get; set; } public string Path { get; set; } public int Active { get; set; } }
    internal sealed class SessionRow { public string Id { get; set; } public string Agent { get; set; } public string Kind { get; set; } public string Title { get; set; } public string Cwd { get; set; } public string Status { get; set; } public int Pending { get; set; } public SessionInfo Source { get; set; } }
    internal sealed class AccountRow { public string Agent { get; set; } public string Name { get; set; } public string Environment { get; set; } public string Default { get; set; } public string Status { get; set; } public int Active { get; set; } public string Detail { get; set; } public AccountInfo Source { get; set; } }
    internal sealed class RunRow { public string Id { get; set; } public string Objective { get; set; } public string Status { get; set; } public string Updated { get; set; } }
    internal sealed class TaskRow { public string Id { get; set; } public string Title { get; set; } public string Status { get; set; } public string Result { get; set; } }
    internal sealed class GateRow { public string Id { get; set; } public string Question { get; set; } public string Status { get; set; } public string Decision { get; set; } }
    internal sealed class DeviceRow { public string Name { get; set; } public string Shell { get; set; } public string Orchestration { get; set; } public string Bound { get; set; } public string LastSeen { get; set; } }

    public partial class MainWindow : Window
    {
        private readonly ProsperoController controller;
        private readonly List<FrameworkElement> pages = new List<FrameworkElement>();
        private bool updatingSettings;
        private string explicitNodeDraft = "";
        public bool AllowClose { get; set; }
        public event EventHandler RequestExit;
        public int NavigationPageCount { get { return Navigation.Items.Count; } }

        internal MainWindow(ProsperoController controller)
        {
            this.controller = controller;
            InitializeComponent();
            ConfigureGridWidths();
            ThemeManager.ApplyWindow(this);
            pages.Add(OverviewPage); pages.Add(SessionsPage); pages.Add(AccountsPage); pages.Add(OrchestrationPage);
            pages.Add(DevicesPage); pages.Add(LogsPage); pages.Add(SettingsPage);
            Navigation.SelectedIndex = 0;
            controller.SnapshotChanged += Controller_SnapshotChanged;
            Closing += delegate(object sender, System.ComponentModel.CancelEventArgs args)
            {
                if (!AllowClose) { args.Cancel = true; Hide(); }
            };
            Closed += delegate { controller.SnapshotChanged -= Controller_SnapshotChanged; };
            RefreshUi();
        }

        public void SelectPreviewPage(int index) { if (index >= 0 && index < Navigation.Items.Count) Navigation.SelectedIndex = index; }
        public void SelectPreviewNodeMode(string mode) { SelectNodeMode(mode); }
        public bool VerifyNodeModeUi()
        {
            SelectNodeMode("system"); bool systemMode = NodePathText.IsReadOnly && !BrowseNodeButton.IsEnabled;
            SelectNodeMode("explicit"); bool explicitMode = !NodePathText.IsReadOnly && BrowseNodeButton.IsEnabled;
            return systemMode && explicitMode;
        }

        private void ConfigureGridWidths()
        {
            SetGridWidths(ProjectsGrid, 1, 3, 1); SetGridWidths(SessionsGrid, 1, 1, 2, 3, 1, 1);
            SetGridWidths(AccountsGrid, 1, 1.5, 1, 0.7, 1, 0.8, 2); SetGridWidths(RunsGrid, 3, 1, 1.4, 2);
            SetGridWidths(TasksGrid, 2, 1, 3, 2); SetGridWidths(GatesGrid, 3, 1, 1, 2); SetGridWidths(DevicesGrid, 2, 1, 1, 1, 2);
        }

        private static void SetGridWidths(DataGrid grid, params double[] values)
        {
            grid.SizeChanged += delegate { ApplyGridWidths(grid, values); };
            ApplyGridWidths(grid, values);
        }

        private static void ApplyGridWidths(DataGrid grid, double[] values)
        {
            if (grid.ActualWidth <= 1 || values == null || values.Length == 0) return;
            double totalWeight = 0; foreach (double value in values) totalWeight += value;
            double available = Math.Max(0, grid.ActualWidth - 3);
            for (int i = 0; i < grid.Columns.Count && i < values.Length; i++)
                grid.Columns[i].Width = new DataGridLength(Math.Max(20, available * values[i] / totalWeight), DataGridLengthUnitType.Pixel);
        }

        private void Controller_SnapshotChanged(object sender, EventArgs e)
        {
            if (!Dispatcher.CheckAccess()) { Dispatcher.BeginInvoke(new Action(RefreshUi)); return; }
            RefreshUi();
        }

        private void Navigation_SelectionChanged(object sender, SelectionChangedEventArgs e)
        {
            int index = Navigation.SelectedIndex;
            for (int i = 0; i < pages.Count; i++) pages[i].Visibility = i == index ? Visibility.Visible : Visibility.Collapsed;
            if (index == 2 && controller.IsRunning) _ = RefreshAccountsAsync();
        }

        private void RefreshUi()
        {
            bool online = controller.IsRunning;
            StatusPill.Background = (Brush)FindResource(online ? "GreenSoftBrush" : "OrangeSoftBrush");
            StatusDot.Fill = (Brush)FindResource(online ? "GreenBrush" : "OrangeBrush");
            StatusText.Foreground = (Brush)FindResource(online ? "GreenBrush" : "OrangeBrush");
            StatusText.Text = controller.StateLabel + "  ·  " + controller.Port + "  ·  " + controller.Bind;
            OverviewDaemonValue.Text = online ? "在线" : "未运行";
            OverviewDaemonDetail.Text = online ? "端口 " + controller.Port : "等待启动 daemon";
            OverviewSessionValue.Text = controller.Sessions.Count.ToString(); OverviewSessionDetail.Text = "待处理 " + PendingCount();
            OverviewDeviceValue.Text = controller.Devices.Count.ToString(); OverviewDeviceDetail.Text = "已绑定 " + BoundCount();
            PersistenceText.Text = "对话会话：" + (controller.StructuredPersistent ? "✓ 可恢复" : "—") + "\n终端会话：" + (controller.PtyPersistent ? "✓ Windows Session Host 可恢复" : "—");
            FillProjects(); FillSessions(); FillAccounts(); FillOrchestration(); FillDevices();
            if (LogsText.Text != controller.LogText) { LogsText.Text = controller.LogText; LogsText.ScrollToEnd(); }
            RelayStatusText.Text = "状态：\n" + controller.RelayState + (string.IsNullOrWhiteSpace(controller.RelayError) ? "" : "\n" + controller.RelayError);
            SettingsNote.Text = "数据目录：" + controller.Home + "\n开机自启动使用当前用户的 HKCU Run 项，不需要管理员权限。";
            if (!updatingSettings && !SettingsPage.IsKeyboardFocusWithin)
            {
                explicitNodeDraft = controller.Settings.NodePath;
                SelectNodeMode(controller.Settings.NodeMode);
                CliPathText.Text = controller.Settings.CliPath.Length > 0 ? controller.Settings.CliPath : (controller.FindCli() ?? "");
                BindText.Text = controller.Settings.PendingBind; RelayUrlText.Text = controller.RelayUrl;
                StartupToggle.IsChecked = StartupManager.IsEnabled; DaemonLaunchToggle.IsChecked = controller.Settings.StartDaemonOnLaunch;
                SelectTheme(controller.Settings.ThemeMode);
            }
        }

        private int PendingCount() { int count = 0; foreach (SessionInfo session in controller.Sessions) count += session.Pending; return count; }
        private int BoundCount() { int count = 0; foreach (DeviceInfo device in controller.Devices) if (device.Bound) count++; return count; }

        private void FillProjects()
        {
            string selected = (ProjectsGrid.SelectedItem as ProjectRow)?.Path;
            List<ProjectRow> rows = new List<ProjectRow>();
            foreach (string path in controller.Projects)
            {
                int active = 0; foreach (SessionInfo session in controller.Sessions) if (string.Equals(session.Cwd, path, StringComparison.OrdinalIgnoreCase)) active++;
                string name = System.IO.Path.GetFileName(path.TrimEnd(System.IO.Path.DirectorySeparatorChar)); if (string.IsNullOrEmpty(name)) name = path;
                rows.Add(new ProjectRow { Name = name, Path = path, Active = active });
            }
            ProjectsGrid.ItemsSource = rows; RestoreSelection(ProjectsGrid, delegate(object item) { return ((ProjectRow)item).Path; }, selected);
        }

        private void FillSessions()
        {
            string selected = (SessionsGrid.SelectedItem as SessionRow)?.Id;
            List<SessionRow> rows = new List<SessionRow>();
            foreach (SessionInfo session in controller.Sessions) rows.Add(new SessionRow { Id = session.Id, Agent = session.Agent, Kind = session.Kind, Title = session.Title, Cwd = session.Cwd, Status = session.Status, Pending = session.Pending, Source = session });
            SessionsGrid.ItemsSource = rows; RestoreSelection(SessionsGrid, delegate(object item) { return ((SessionRow)item).Id; }, selected);
        }

        private void FillAccounts()
        {
            string selected = (AccountsGrid.SelectedItem as AccountRow)?.Source.Id;
            List<AccountRow> rows = new List<AccountRow>();
            foreach (AccountInfo account in controller.Accounts) rows.Add(new AccountRow
            {
                Agent = account.Agent, Name = account.Name, Environment = account.HasApiProfile ? "API Profile" : (account.Managed ? "独立环境" : "本机环境"),
                Default = account.IsDefault ? "✓" : "", Status = account.Status, Active = account.ActiveSessions,
                Detail = account.HasApiProfile ? account.BaseUrl + " · " + account.Model : account.Detail, Source = account
            });
            AccountsGrid.ItemsSource = rows; RestoreSelection(AccountsGrid, delegate(object item) { return ((AccountRow)item).Source.Id; }, selected);
        }

        private void FillOrchestration()
        {
            string run = (RunsGrid.SelectedItem as RunRow)?.Id; string task = (TasksGrid.SelectedItem as TaskRow)?.Id; string gate = (GatesGrid.SelectedItem as GateRow)?.Id;
            List<RunRow> runs = new List<RunRow>(); foreach (OrchestrationRunInfo item in controller.Runs) runs.Add(new RunRow { Id = item.Id, Objective = item.Objective, Status = item.Status, Updated = Date(item.UpdatedAt) });
            List<TaskRow> tasks = new List<TaskRow>(); foreach (OrchestrationTaskInfo item in controller.Tasks) tasks.Add(new TaskRow { Id = item.Id, Title = item.Title, Status = item.Status, Result = item.Result });
            List<GateRow> gates = new List<GateRow>(); foreach (GateInfo item in controller.Gates) gates.Add(new GateRow { Id = item.Id, Question = item.Question, Status = item.Status, Decision = item.Decision });
            RunsGrid.ItemsSource = runs; TasksGrid.ItemsSource = tasks; GatesGrid.ItemsSource = gates;
            RestoreSelection(RunsGrid, delegate(object item) { return ((RunRow)item).Id; }, run); RestoreSelection(TasksGrid, delegate(object item) { return ((TaskRow)item).Id; }, task); RestoreSelection(GatesGrid, delegate(object item) { return ((GateRow)item).Id; }, gate);
        }

        private void FillDevices()
        {
            string selected = (DevicesGrid.SelectedItem as DeviceRow)?.Name;
            List<DeviceRow> rows = new List<DeviceRow>(); foreach (DeviceInfo device in controller.Devices) rows.Add(new DeviceRow { Name = device.Name, Shell = device.AllowShell ? "允许" : "禁止", Orchestration = device.AllowOrchestration ? "允许" : "只读", Bound = device.Bound ? "已绑定" : "等待扫码", LastSeen = Date(device.LastSeenAt) });
            DevicesGrid.ItemsSource = rows; RestoreSelection(DevicesGrid, delegate(object item) { return ((DeviceRow)item).Name; }, selected);
        }

        private static void RestoreSelection(DataGrid grid, Func<object, string> key, string selected)
        {
            if (selected == null) return; foreach (object item in grid.ItemsSource) if (key(item) == selected) { grid.SelectedItem = item; break; }
        }

        private static string Date(double milliseconds) { if (milliseconds <= 0) return "—"; try { return new DateTime(1970, 1, 1).AddMilliseconds(milliseconds).ToLocalTime().ToString("yyyy-MM-dd HH:mm"); } catch { return "—"; } }
        private void ShowError(string value) { if (!string.IsNullOrWhiteSpace(value)) WpfDialogs.Error(this, value); }
        private bool Confirm(string value) { return WpfDialogs.Confirm(this, value); }
        private static Dictionary<string, object> OperationParameters() { return new Dictionary<string, object> { { "operationId", Guid.NewGuid().ToString("N") } }; }

        private void StartDaemon_Click(object sender, RoutedEventArgs e) { controller.StartDaemon(); }
        private void StopDaemon_Click(object sender, RoutedEventArgs e) { controller.StopDaemon(); }
        private async void RestartDaemon_Click(object sender, RoutedEventArgs e) { await controller.RestartDaemonAsync(); }
        private void Refresh_Click(object sender, RoutedEventArgs e) { controller.Refresh(); }
        private void Exit_Click(object sender, RoutedEventArgs e) { RequestExit?.Invoke(this, EventArgs.Empty); }
        private void OpenData_Click(object sender, RoutedEventArgs e) { OpenPath(controller.Home); }
        private void PairDevice_Click(object sender, RoutedEventArgs e) { WpfDialogs.ShowPairing(this, controller); }
        private void ProjectsGrid_DoubleClick(object sender, MouseButtonEventArgs e) { NewSessionForProject(); }
        private void SessionsGrid_DoubleClick(object sender, MouseButtonEventArgs e) { OpenSelectedSession(); }
        private void NewSession_Click(object sender, RoutedEventArgs e) { NewSessionForProject(); }
        private void OpenSession_Click(object sender, RoutedEventArgs e) { OpenSelectedSession(); }

        private async void NewSessionForProject()
        {
            string initial = (ProjectsGrid.SelectedItem as ProjectRow)?.Path;
            NewSessionOptions options = WpfDialogs.NewSession(this, initial); if (options == null) return;
            if (options.Policy == "yolo" && options.Kind == "structured" && !Confirm("YOLO 会自动批准 Agent 请求的命令和文件操作。确认在此项目中启用？")) return;
            ShowError(await controller.CreateSessionAsync(options.Agent, options.Kind, options.WorkingDirectory, options.Policy, ""));
        }

        private void OpenSelectedSession()
        {
            SessionRow row = SessionsGrid.SelectedItem as SessionRow; if (row != null) WpfDialogs.ShowSession(this, controller, row.Source);
        }

        private void AddProject_Click(object sender, RoutedEventArgs e)
        {
            using (Forms.FolderBrowserDialog dialog = new Forms.FolderBrowserDialog()) if (dialog.ShowDialog() == Forms.DialogResult.OK) controller.RememberProject(dialog.SelectedPath);
        }
        private void RemoveProject_Click(object sender, RoutedEventArgs e) { ProjectRow row = ProjectsGrid.SelectedItem as ProjectRow; if (row != null) controller.RemoveProject(row.Path); }
        private async void InterruptSession_Click(object sender, RoutedEventArgs e) { await SessionAction("interrupt"); }
        private async void KillSession_Click(object sender, RoutedEventArgs e) { await SessionAction("kill"); }
        private async Task SessionAction(string action) { SessionRow row = SessionsGrid.SelectedItem as SessionRow; if (row == null) return; if (action == "kill" && !Confirm("结束会话会持久化终态并终止受控 Agent，确定继续？")) return; ShowError(await controller.ControlSessionAsync(row.Id, action)); }

        private async Task RefreshAccountsAsync() { ShowError(await controller.RefreshAccountsAsync()); }
        private async void RefreshAccounts_Click(object sender, RoutedEventArgs e) { await RefreshAccountsAsync(); }
        private AccountInfo SelectedAccount() { return (AccountsGrid.SelectedItem as AccountRow)?.Source; }
        private async void AddAccount_Click(object sender, RoutedEventArgs e) { AccountCreateOptions o = WpfDialogs.AccountCreate(this); if (o == null) return; ShowError(await controller.AccountOperationAsync(new Dictionary<string, object> { { "type", "agent.account.create" }, { "agent", o.Agent }, { "name", o.Name } })); }
        private async void RenameAccount_Click(object sender, RoutedEventArgs e) { AccountInfo a = SelectedAccount(); if (a == null || !a.Managed) return; string name = WpfDialogs.Prompt(this, "重命名账号", "账号名称", a.Name, false); if (name == null) return; Dictionary<string, object> body = AccountBody("agent.account.rename", a.Id); body["name"] = name; ShowError(await controller.AccountOperationAsync(body)); }
        private async void AddApiProfile_Click(object sender, RoutedEventArgs e) { ApiProfileOptions o = WpfDialogs.ApiProfile(this, null); if (o == null) return; ShowError(await controller.AccountOperationAsync(new Dictionary<string, object> { { "type", "agent.account.api.create" }, { "agent", o.Agent }, { "name", o.Name }, { "baseUrl", o.BaseUrl }, { "model", o.Model }, { "apiKey", o.ApiKey } })); }
        private async void ConfigureApi_Click(object sender, RoutedEventArgs e) { AccountInfo a = SelectedAccount(); if (a == null || !a.HasApiProfile) return; ApiProfileOptions o = WpfDialogs.ApiProfile(this, a); if (o == null) return; Dictionary<string, object> body = AccountBody("agent.account.api.configure", a.Id); body["baseUrl"] = o.BaseUrl; body["model"] = o.Model; body["apiKey"] = o.ApiKey; ShowError(await controller.AccountOperationAsync(body)); }
        private async void Credential_Click(object sender, RoutedEventArgs e) { AccountInfo a = SelectedAccount(); if (a == null) return; CredentialOptions o = WpfDialogs.Credential(this, a.Agent); if (o == null) return; Dictionary<string, object> body = AccountBody("agent.account.credential.set", a.Id); body["credentialKind"] = o.Kind; body["credential"] = o.Secret; ShowError(await controller.AccountOperationAsync(body)); }
        private async void DefaultAccount_Click(object sender, RoutedEventArgs e) { await AccountSimple("agent.account.default"); }
        private async void LogoutAccount_Click(object sender, RoutedEventArgs e) { await AccountSimple("agent.account.logout"); }
        private async Task AccountSimple(string type) { AccountInfo a = SelectedAccount(); if (a != null) ShowError(await controller.AccountOperationAsync(AccountBody(type, a.Id))); }
        private async void LoginAccount_Click(object sender, RoutedEventArgs e)
        {
            AccountInfo a = SelectedAccount(); if (a == null || a.HasApiProfile) return; Dictionary<string, object> body = AccountBody("agent.account.login", a.Id); body["cols"] = 120; body["rows"] = 40;
            string error = await controller.AccountOperationAsync(body); ShowError(error); if (error != null) return; await Task.Delay(250); controller.Refresh();
            foreach (SessionInfo session in controller.Sessions) if (session.Id == controller.LastAccountSessionId) { WpfDialogs.ShowSession(this, controller, session); return; }
            WpfDialogs.Info(this, "登录终端已创建，可在“项目与会话”页面中打开。");
        }
        private async void DeleteAccount_Click(object sender, RoutedEventArgs e) { AccountInfo a = SelectedAccount(); if (a == null || !a.Managed || !Confirm("删除独立账号「" + a.Name + "」？项目文件不会删除。")) return; ShowError(await controller.AccountOperationAsync(AccountBody("agent.account.delete", a.Id))); }
        private static Dictionary<string, object> AccountBody(string type, string id) { return new Dictionary<string, object> { { "type", type }, { "accountId", id } }; }

        private async void RevokeDevice_Click(object sender, RoutedEventArgs e) { DeviceRow row = DevicesGrid.SelectedItem as DeviceRow; if (row == null || !Confirm("撤销设备「" + row.Name + "」？它将立即失去访问权限。")) return; ShowError(await controller.RevokeDeviceAsync(row.Name)); }
        private async void CreateRun_Click(object sender, RoutedEventArgs e) { string objective = WpfDialogs.Prompt(this, "新建编排 Run", "目标", "", false); if (string.IsNullOrWhiteSpace(objective)) return; Dictionary<string, object> p = OperationParameters(); p["objective"] = objective; ShowError(await controller.OrchestrationActionAsync("run.create", p)); }
        private async Task RunAction(string method) { RunRow row = RunsGrid.SelectedItem as RunRow; if (row == null) return; Dictionary<string, object> p = OperationParameters(); p["runId"] = row.Id; ShowError(await controller.OrchestrationActionAsync(method, p)); }
        private async void CompleteRun_Click(object sender, RoutedEventArgs e) { await RunAction("run.complete"); }
        private async void AbandonRun_Click(object sender, RoutedEventArgs e) { await RunAction("run.abandon"); }
        private async void PauseAutomation_Click(object sender, RoutedEventArgs e) { await RunAction("automation.pause"); }
        private async void DeleteRun_Click(object sender, RoutedEventArgs e) { RunRow row = RunsGrid.SelectedItem as RunRow; if (row == null || !Confirm("删除 Run 只删除编排记录，不会自动清理关联 worktree。确定继续？")) return; Dictionary<string, object> p = OperationParameters(); p["runId"] = row.Id; ShowError(await controller.OrchestrationActionAsync("run.delete", p)); }
        private async void CreateTask_Click(object sender, RoutedEventArgs e)
        {
            RunRow row = RunsGrid.SelectedItem as RunRow; if (row == null) { ShowError("请先选择一个 Run"); return; }
            string title = WpfDialogs.Prompt(this, "新建 Task", "任务标题", "", false); if (string.IsNullOrWhiteSpace(title)) return;
            string spec = WpfDialogs.Prompt(this, "新建 Task", "任务说明", "", false); if (string.IsNullOrWhiteSpace(spec)) return;
            string depsText = WpfDialogs.Prompt(this, "新建 Task", "依赖 Task ID（逗号分隔，可留空）", "", false); if (depsText == null) return;
            List<string> deps = new List<string>(); foreach (string dep in depsText.Split(',')) if (!string.IsNullOrWhiteSpace(dep)) deps.Add(dep.Trim());
            Dictionary<string, object> p = OperationParameters(); p["runId"] = row.Id; p["title"] = title; p["spec"] = spec; p["deps"] = deps.ToArray(); ShowError(await controller.OrchestrationActionAsync("task.create", p));
        }
        private async Task TaskAction(string method) { TaskRow row = TasksGrid.SelectedItem as TaskRow; if (row == null) return; Dictionary<string, object> p = OperationParameters(); p["taskId"] = row.Id; if (method == "worker.stop") p["reason"] = "由 Windows 用户停止 worker"; if (method == "task.cancel") p["reason"] = "由 Windows 用户取消任务"; ShowError(await controller.OrchestrationActionAsync(method, p)); }
        private async void StopWorker_Click(object sender, RoutedEventArgs e) { await TaskAction("worker.stop"); }
        private async void CancelTask_Click(object sender, RoutedEventArgs e) { await TaskAction("task.cancel"); }
        private async void RetryTask_Click(object sender, RoutedEventArgs e) { await TaskAction("task.retry"); }
        private async void StartWorker_Click(object sender, RoutedEventArgs e) { TaskRow row = TasksGrid.SelectedItem as TaskRow; if (row == null) return; WorkerOptions o = WpfDialogs.Worker(this, false); if (o == null) return; Dictionary<string, object> p = OperationParameters(); p["taskId"] = row.Id; p["agent"] = o.Agent; p["cwd"] = o.WorkingDirectory; p["worktree"] = o.Workspace; p["approvalPolicy"] = o.Policy; ShowError(await controller.OrchestrationActionAsync("worker.start", p)); }
        private async void StartAutomation_Click(object sender, RoutedEventArgs e) { RunRow row = RunsGrid.SelectedItem as RunRow; if (row == null) return; WorkerOptions o = WpfDialogs.Worker(this, true); if (o == null) return; Dictionary<string, object> p = OperationParameters(); p["runId"] = row.Id; p["agent"] = o.Agent; p["cwd"] = o.WorkingDirectory; p["workspace"] = o.Workspace; p["approvalPolicy"] = o.Policy; ShowError(await controller.OrchestrationActionAsync("automation.start", p)); }
        private async Task GateAction(string decision) { GateRow row = GatesGrid.SelectedItem as GateRow; if (row != null) ShowError(await controller.ResolveGateAsync(row.Id, decision)); }
        private async void ApproveGate_Click(object sender, RoutedEventArgs e) { await GateAction("approve"); }
        private async void RejectGate_Click(object sender, RoutedEventArgs e) { await GateAction("reject"); }

        private void ClearLogs_Click(object sender, RoutedEventArgs e) { controller.ClearLog(); LogsText.Clear(); }
        private void BrowseNode_Click(object sender, RoutedEventArgs e)
        {
            if (SelectedNodeMode() != "explicit") SelectNodeMode("explicit");
            BrowseFile(NodePathText, "node.exe|node.exe|所有文件|*.*"); explicitNodeDraft = NodePathText.Text.Trim();
        }
        private void BrowseCli_Click(object sender, RoutedEventArgs e) { BrowseFile(CliPathText, "JavaScript|*.js|所有文件|*.*"); }
        private static void BrowseFile(TextBox target, string filter) { OpenFileDialog dialog = new OpenFileDialog { Filter = filter, CheckFileExists = true }; if (dialog.ShowDialog() == true) target.Text = dialog.FileName; }
        private void SaveSettings_Click(object sender, RoutedEventArgs e) { SaveSettings(); }
        private async void SaveRestart_Click(object sender, RoutedEventArgs e) { if (SaveSettings()) await controller.RestartDaemonAsync(); }
        private bool SaveSettings()
        {
            updatingSettings = true;
            try
            {
                string nodeMode = SelectedNodeMode();
                if (nodeMode == "explicit")
                {
                    explicitNodeDraft = NodePathText.Text.Trim();
                    if (!File.Exists(explicitNodeDraft)) { WpfDialogs.Error(this, "请选择有效的 node.exe。"); return false; }
                }
                else if (controller.FindSystemNode() == null) { WpfDialogs.Error(this, "未在 PATH 或 NVM_SYMLINK 中找到系统 Node.js。"); return false; }
                controller.Settings.NodeMode = nodeMode; controller.Settings.NodePath = explicitNodeDraft;
                controller.Settings.CliPath = CliPathText.Text.Trim(); controller.Settings.PendingBind = BindText.Text.Trim(); controller.Settings.StartDaemonOnLaunch = DaemonLaunchToggle.IsChecked == true;
                StartupManager.SetEnabled(StartupToggle.IsChecked == true); string theme = SelectedTheme(); controller.Settings.ThemeMode = theme; ThemeManager.Apply(Application.Current, theme);
                WpfDialogs.Info(this, "设置已保存。监听地址将在下次 daemon 启动时生效。"); return true;
            }
            catch (Exception error) { ShowError(error.Message); return false; }
            finally { updatingSettings = false; }
        }
        private void ThemeCombo_SelectionChanged(object sender, SelectionChangedEventArgs e) { if (!updatingSettings && IsLoaded) { string mode = SelectedTheme(); controller.Settings.ThemeMode = mode; ThemeManager.Apply(Application.Current, mode); } }
        private void NodeModeCombo_SelectionChanged(object sender, SelectionChangedEventArgs e) { if (!updatingSettings) ApplyNodeModeUi(true); }
        private string SelectedNodeMode() { ComboBoxItem item = NodeModeCombo.SelectedItem as ComboBoxItem; return Convert.ToString(item == null ? "system" : item.Tag); }
        private void SelectNodeMode(string mode)
        {
            bool previous = updatingSettings; updatingSettings = true;
            try { foreach (ComboBoxItem item in NodeModeCombo.Items) if (Convert.ToString(item.Tag) == mode) { NodeModeCombo.SelectedItem = item; break; } if (NodeModeCombo.SelectedItem == null) NodeModeCombo.SelectedIndex = 0; }
            finally { updatingSettings = previous; }
            ApplyNodeModeUi(false);
        }
        private void ApplyNodeModeUi(bool rememberExplicitValue)
        {
            if (rememberExplicitValue && !NodePathText.IsReadOnly) explicitNodeDraft = NodePathText.Text.Trim();
            bool explicitMode = SelectedNodeMode() == "explicit";
            NodePathText.IsReadOnly = !explicitMode; BrowseNodeButton.IsEnabled = explicitMode;
            NodePathText.Text = explicitMode ? explicitNodeDraft : (controller.FindSystemNode() ?? "未检测到系统 Node.js");
        }
        private string SelectedTheme() { ComboBoxItem item = ThemeCombo.SelectedItem as ComboBoxItem; return Convert.ToString(item == null ? "system" : item.Tag); }
        private void SelectTheme(string mode) { updatingSettings = true; try { foreach (ComboBoxItem item in ThemeCombo.Items) if (Convert.ToString(item.Tag) == mode) { ThemeCombo.SelectedItem = item; return; } ThemeCombo.SelectedIndex = 0; } finally { updatingSettings = false; } }
        private async Task RelayCommand(string action) { string value = await controller.RelayCommandAsync(action, RelayUrlText.Text); if (!string.IsNullOrWhiteSpace(value)) WpfDialogs.Info(this, value); }
        private async void EnableRelay_Click(object sender, RoutedEventArgs e) { await RelayCommand("enable"); }
        private async void DisableRelay_Click(object sender, RoutedEventArgs e) { await RelayCommand("disable"); }
        private async void RefreshRelay_Click(object sender, RoutedEventArgs e) { await RelayCommand("status"); }
        private async void RotateRelay_Click(object sender, RoutedEventArgs e) { if (Confirm("轮换 Relay 密钥会使所有设备的 Relay 配对立即失效，并要求重新扫码。是否继续？") && Confirm("最后确认：此操作无法撤销。确定轮换 Relay 密钥？")) await RelayCommand("rotate-key"); }
        private void SelfCheck_Click(object sender, RoutedEventArgs e) { WpfDialogs.Info(this, controller.SelfCheck()); }
        private static void OpenPath(string path) { Directory.CreateDirectory(path); Process.Start(new ProcessStartInfo("explorer.exe", "\"" + path + "\"") { UseShellExecute = true }); }
    }
}
