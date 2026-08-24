using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Prospero.WindowsShell
{
    internal sealed class ProsperoController : IDisposable
    {
        private readonly object logLock = new object();
        private readonly System.Windows.Forms.Timer refreshTimer;
        private Process managedProcess;
        private bool expectedStop;
        private bool disposed;
        private string logText = "";

        public readonly SettingsStore Settings = new SettingsStore();
        public readonly List<DeviceInfo> Devices = new List<DeviceInfo>();
        public readonly List<SessionInfo> Sessions = new List<SessionInfo>();
        public readonly List<AccountInfo> Accounts = new List<AccountInfo>();
        public readonly List<OrchestrationRunInfo> Runs = new List<OrchestrationRunInfo>();
        public readonly List<OrchestrationTaskInfo> Tasks = new List<OrchestrationTaskInfo>();
        public readonly List<GateInfo> Gates = new List<GateInfo>();
        public readonly List<string> Projects = new List<string>();

        public event EventHandler SnapshotChanged;

        public int Port { get; private set; }
        public string Bind { get; private set; }
        public int DaemonPid { get; private set; }
        public string ControlToken { get; private set; }
        public bool PtyPersistent { get; private set; }
        public bool StructuredPersistent { get; private set; }
        public string StateLabel { get; private set; }
        public string LastError { get; private set; }
        public string LastAccountSessionId { get; private set; }
        public bool RelayEnabled { get; private set; }
        public string RelayUrl { get; private set; }
        public string RelayState { get; private set; }
        public string RelayError { get; private set; }

        public string Home
        {
            get
            {
                string overrideHome = Environment.GetEnvironmentVariable("PROSPERO_HOME");
                return string.IsNullOrWhiteSpace(overrideHome)
                    ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".prospero")
                    : Path.GetFullPath(overrideHome);
            }
        }

        public bool RuntimeReady { get { return FindNode() != null && FindCli() != null; } }
        public bool IsRunning { get { return DaemonPid > 0 && IsProcessAlive(DaemonPid); } }
        public bool ManagedByShell { get { return managedProcess != null && !managedProcess.HasExited; } }

        public string LogText
        {
            get { lock (logLock) { return logText; } }
        }

        public ProsperoController()
        {
            Port = 7423;
            Bind = "全部网卡";
            RelayUrl = ""; RelayState = "disabled"; RelayError = "";
            ControlToken = "";
            StateLabel = "已停止";
            EnsureUtf8LogEpoch();
            LoadLogTail();
            Refresh();
            refreshTimer = new System.Windows.Forms.Timer();
            refreshTimer.Interval = 1000;
            refreshTimer.Tick += delegate { Refresh(); };
            refreshTimer.Start();
        }

        public void StartIfNeeded()
        {
            if (Settings.StartDaemonOnLaunch && !IsRunning) StartDaemon();
        }

        public void Refresh()
        {
            if (disposed) return;
            LoadConfig();
            LoadDevices();
            LoadRuntime();
            LoadOrchestration();
            EventHandler handler = SnapshotChanged;
            if (handler != null) handler(this, EventArgs.Empty);
        }

        private void LoadConfig()
        {
            Dictionary<string, object> config = JsonValue.ReadObject(Path.Combine(Home, "config.json"));
            Port = JsonValue.Int(config, "port", 7423);
            Bind = JsonValue.String(config, "bind", "全部网卡");
            if (string.IsNullOrWhiteSpace(Bind) || Bind == "0.0.0.0") Bind = "全部网卡";
            object relayRaw;
            Dictionary<string, object> relay = config.TryGetValue("relay", out relayRaw)
                ? JsonValue.AsObject(relayRaw) : new Dictionary<string, object>();
            RelayEnabled = JsonValue.Bool(relay, "enabled", false);
            RelayUrl = JsonValue.String(relay, "url", "");
        }

        private void LoadDevices()
        {
            Dictionary<string, object> root = JsonValue.ReadObject(Path.Combine(Home, "devices.json"));
            object raw;
            object[] values = root.TryGetValue("devices", out raw) ? JsonValue.AsArray(raw) : new object[0];
            Devices.Clear();
            foreach (object item in values)
            {
                Dictionary<string, object> device = JsonValue.AsObject(item);
                Devices.Add(new DeviceInfo
                {
                    Name = JsonValue.String(device, "name", "(未命名)"),
                    AllowShell = JsonValue.Bool(device, "allowShell", false),
                    AllowOrchestration = JsonValue.Bool(device, "allowOrchestration", JsonValue.Bool(device, "allowShell", false)),
                    Bound = device.ContainsKey("clientPubKey"),
                    LastSeenAt = JsonValue.Double(device, "lastSeenAt", 0)
                });
            }
        }

        private void LoadRuntime()
        {
            Dictionary<string, object> root = JsonValue.ReadObject(Path.Combine(Home, "status.json"));
            int pid = JsonValue.Int(root, "pid", 0);
            bool alive = pid > 0 && IsProcessAlive(pid);
            DaemonPid = alive ? pid : 0;
            ControlToken = alive ? JsonValue.String(root, "controlToken", "") : "";
            if (alive)
            {
                Port = JsonValue.Int(root, "port", Port);
                string runtimeBind = JsonValue.String(root, "bind", Bind);
                if (!string.IsNullOrWhiteSpace(runtimeBind)) Bind = runtimeBind;
                StateLabel = managedProcess != null && !managedProcess.HasExited
                    ? "运行中（桌面端管理，PID " + pid + "）"
                    : "运行中（外部进程，PID " + pid + "）";
            }
            else if (managedProcess != null && !managedProcess.HasExited)
            {
                StateLabel = "启动中…";
            }
            else if (!string.IsNullOrEmpty(LastError))
            {
                StateLabel = "出错";
            }
            else
            {
                StateLabel = "已停止";
            }

            Dictionary<string, object> persistence = new Dictionary<string, object>();
            object persistenceRaw;
            if (root.TryGetValue("persistence", out persistenceRaw)) persistence = JsonValue.AsObject(persistenceRaw);
            PtyPersistent = JsonValue.Bool(persistence, "pty", false);
            StructuredPersistent = JsonValue.Bool(persistence, "structured", false);
            object runtimeRelayRaw;
            Dictionary<string, object> runtimeRelay = root.TryGetValue("relay", out runtimeRelayRaw)
                ? JsonValue.AsObject(runtimeRelayRaw) : new Dictionary<string, object>();
            RelayState = JsonValue.String(runtimeRelay, "state", RelayEnabled ? "offline" : "disabled");
            RelayError = JsonValue.String(runtimeRelay, "lastError", "");

            Sessions.Clear();
            object sessionsRaw;
            foreach (object item in root.TryGetValue("sessions", out sessionsRaw) ? JsonValue.AsArray(sessionsRaw) : new object[0])
            {
                Dictionary<string, object> session = JsonValue.AsObject(item);
                Sessions.Add(new SessionInfo
                {
                    Id = JsonValue.String(session, "id", ""),
                    Agent = JsonValue.String(session, "agent", ""),
                    Kind = JsonValue.String(session, "kind", ""),
                    Title = JsonValue.String(session, "title", "(未命名会话)"),
                    Cwd = JsonValue.String(session, "cwd", ""),
                    Status = JsonValue.String(session, "status", "unknown"),
                    Pending = JsonValue.Int(session, "pendingPermissions", 0) + JsonValue.Int(session, "pendingQuestions", 0),
                    CreatedAt = JsonValue.Double(session, "createdAt", 0),
                    Preview = JsonValue.String(session, "preview", "")
                });
            }
            LoadProjects();
        }

        private void LoadProjects()
        {
            Projects.Clear();
            foreach (string raw in Settings.RecentProjects.Split(new string[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries))
            {
                string path = raw.Trim(); if (path.Length > 0 && !ContainsProject(path)) Projects.Add(path);
            }
            bool changed = false;
            foreach (SessionInfo session in Sessions)
            {
                if (!string.IsNullOrWhiteSpace(session.Cwd) && !ContainsProject(session.Cwd)) { Projects.Add(session.Cwd); changed = true; }
            }
            if (changed) Settings.RecentProjects = string.Join(Environment.NewLine, Projects.ToArray());
        }

        public void RememberProject(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) return;
            path = Path.GetFullPath(path.Trim()); RemoveProjectInMemory(path); Projects.Insert(0, path);
            Settings.RecentProjects = string.Join(Environment.NewLine, Projects.ToArray()); RaiseSnapshotChanged();
        }

        public void RemoveProject(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) return;
            RemoveProjectInMemory(path); Settings.RecentProjects = string.Join(Environment.NewLine, Projects.ToArray()); RaiseSnapshotChanged();
        }

        private bool ContainsProject(string path) { return Projects.Exists(delegate(string item) { return string.Equals(item, path, StringComparison.OrdinalIgnoreCase); }); }
        private void RemoveProjectInMemory(string path) { Projects.RemoveAll(delegate(string item) { return string.Equals(item, path, StringComparison.OrdinalIgnoreCase); }); }

        private void LoadOrchestration()
        {
            Dictionary<string, object> root = JsonValue.ReadObject(Path.Combine(Home, "orchestration.json"));
            Runs.Clear(); Tasks.Clear(); Gates.Clear();
            AddDictionaryValues(root, "runs", delegate(Dictionary<string, object> value)
            {
                Runs.Add(new OrchestrationRunInfo
                {
                    Id = JsonValue.String(value, "id", ""), Objective = JsonValue.String(value, "objective", ""),
                    Status = JsonValue.String(value, "status", ""), UpdatedAt = JsonValue.Double(value, "updatedAt", 0)
                });
            });
            AddDictionaryValues(root, "tasks", delegate(Dictionary<string, object> value)
            {
                Tasks.Add(new OrchestrationTaskInfo
                {
                    Id = JsonValue.String(value, "id", ""), RunId = JsonValue.String(value, "runId", ""),
                    Title = JsonValue.String(value, "title", ""), Status = JsonValue.String(value, "status", ""),
                    Result = JsonValue.String(value, "result", "")
                });
            });
            AddDictionaryValues(root, "gates", delegate(Dictionary<string, object> value)
            {
                Gates.Add(new GateInfo
                {
                    Id = JsonValue.String(value, "id", ""), RunId = JsonValue.String(value, "runId", ""),
                    Question = JsonValue.String(value, "question", ""), Status = JsonValue.String(value, "status", ""),
                    Decision = JsonValue.String(value, "decision", "")
                });
            });
        }

        private static void AddDictionaryValues(Dictionary<string, object> root, string key, Action<Dictionary<string, object>> add)
        {
            object raw;
            if (!root.TryGetValue(key, out raw)) return;
            Dictionary<string, object> values = JsonValue.AsObject(raw);
            foreach (KeyValuePair<string, object> pair in values) add(JsonValue.AsObject(pair.Value));
        }

        public void StartDaemon()
        {
            StartDaemon(null);
        }

        internal void StartDaemon(int? portOverride)
        {
            if (IsRunning) return;
            if (managedProcess != null && managedProcess.HasExited)
            {
                managedProcess.Dispose(); managedProcess = null;
            }
            string node = FindNode();
            string cli = FindCli();
            if (node == null || cli == null)
            {
                LastError = "找不到 Node.js 或 apps/daemon/dist/cli.js；请在设置中指定路径。";
                StateLabel = "出错";
                RaiseSnapshotChanged();
                return;
            }

            Directory.CreateDirectory(Home);
            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = node;
            start.Arguments = Quote(cli) + " start";
            if (portOverride.HasValue)
                start.Arguments += " --port " + portOverride.Value;
            if (!string.IsNullOrWhiteSpace(Settings.PendingBind))
                start.Arguments += " --bind " + Quote(Settings.PendingBind);
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            start.StandardOutputEncoding = Encoding.UTF8;
            start.StandardErrorEncoding = Encoding.UTF8;
            start.WorkingDirectory = FindRepositoryRoot(cli) ?? Environment.CurrentDirectory;

            try
            {
                LastError = "";
                expectedStop = false;
                managedProcess = new Process();
                managedProcess.StartInfo = start;
                managedProcess.EnableRaisingEvents = true;
                managedProcess.OutputDataReceived += OnDaemonOutput;
                managedProcess.ErrorDataReceived += OnDaemonOutput;
                managedProcess.Exited += delegate
                {
                    try
                    {
                        if (!expectedStop && managedProcess != null && managedProcess.ExitCode != 0 && string.IsNullOrEmpty(LastError))
                            LastError = "daemon 退出，状态码 " + managedProcess.ExitCode;
                    }
                    catch (InvalidOperationException) { }
                };
                managedProcess.Start();
                managedProcess.BeginOutputReadLine();
                managedProcess.BeginErrorReadLine();
                StateLabel = "启动中…";
                try { Settings.PendingBind = ""; }
                catch (Exception settingsError) { AppendLog("[windows-shell] daemon 已启动，但清理待应用监听地址失败：" + settingsError.Message + Environment.NewLine); }
                RaiseSnapshotChanged();
            }
            catch (Exception error)
            {
                LastError = error.Message;
                StateLabel = "出错";
                AppendLog("[windows-shell] 启动失败：" + error.Message);
                RaiseSnapshotChanged();
            }
        }

        public void StopDaemon()
        {
            int pid = DaemonPid;
            if (pid <= 0 && managedProcess != null && !managedProcess.HasExited) pid = managedProcess.Id;
            if (pid <= 0) return;
            try
            {
                expectedStop = true;
                using (Process target = Process.GetProcessById(pid))
                {
                    target.Kill();
                    target.WaitForExit(5000);
                }
                DaemonPid = 0;
                ControlToken = "";
                LastError = "";
                StateLabel = "已停止";
                AppendLog("[windows-shell] daemon 已停止；Windows Session Host 中的会话保持独立。\r\n");
            }
            catch (Exception error)
            {
                LastError = "停止 daemon 失败：" + error.Message;
            }
            RaiseSnapshotChanged();
        }

        public async Task RestartDaemonAsync()
        {
            StopDaemon();
            await Task.Delay(450);
            StartDaemon();
        }

        public async Task<PairingResult> PairDeviceAsync(string name, bool allowShell, bool allowOrchestration)
        {
            List<string> arguments = new List<string>();
            arguments.Add("pair"); arguments.Add("--name"); arguments.Add(name);
            if (!allowShell) arguments.Add("--no-shell");
            if (!allowOrchestration || !allowShell) arguments.Add("--no-orchestration");
            ProcessResult process = await RunCliAsync(arguments.ToArray(), false);
            string uri = "";
            Match match = Regex.Match(process.Output, @"prospero://\S+", RegexOptions.IgnoreCase);
            if (match.Success) uri = match.Value.Trim();
            Refresh();
            return new PairingResult { Success = process.ExitCode == 0 && uri.Length > 0, Output = process.Output, PairingUri = uri };
        }

        public async Task<string> RevokeDeviceAsync(string name)
        {
            ProcessResult result = await RunCliAsync(new string[] { "revoke", name }, false);
            Refresh();
            return result.ExitCode == 0 ? null : result.Output.Trim();
        }

        public async Task<string> RelayCommandAsync(string action, string url)
        {
            List<string> arguments = new List<string>(); arguments.Add("relay"); arguments.Add(action);
            if (action == "enable" && !string.IsNullOrWhiteSpace(url)) { arguments.Add("--url"); arguments.Add(url.Trim()); }
            if (action == "status") arguments.Add("--json");
            if (action == "rotate-key") arguments.Add("--yes");
            ProcessResult result = await RunCliAsync(arguments.ToArray(), true); Refresh();
            return result.ExitCode == 0 ? result.Output.Trim() : "错误：" + result.Output.Trim();
        }

        public async Task<string> CreateSessionAsync(string agent, string kind, string cwd, string policy, string accountId)
        {
            Dictionary<string, object> body = new Dictionary<string, object>();
            body["agent"] = agent; body["kind"] = kind; body["cwd"] = cwd;
            body["cols"] = 120; body["rows"] = 40;
            if (kind == "structured") body["approvalPolicy"] = policy;
            if (!string.IsNullOrWhiteSpace(accountId)) body["accountId"] = accountId;
            string response = await PostControlAsync("/_prospero/control/session/create", body);
            string error = ExtractError(response);
            if (error == null) RememberProject(cwd);
            Refresh();
            return error;
        }

        public async Task<string> ControlSessionAsync(string id, string action)
        {
            string response = await PostControlAsync("/_prospero/control/session/" + Uri.EscapeDataString(id) + "/" + action, null);
            Refresh();
            return ExtractError(response);
        }

        public async Task<string> LoadSessionViewAsync(string id)
        {
            return await GetControlAsync("/_prospero/control/session/" + Uri.EscapeDataString(id) + "/view");
        }

        public async Task<string> InteractSessionAsync(string id, Dictionary<string, object> body)
        {
            string response = await PostControlAsync("/_prospero/control/session/" + Uri.EscapeDataString(id) + "/interact", body);
            return ExtractError(response);
        }

        public async Task<string> ResolveGateAsync(string id, string decision)
        {
            Dictionary<string, object> body = new Dictionary<string, object>();
            body["decision"] = decision;
            string response = await PostControlAsync("/_prospero/control/orchestration/gate/" + Uri.EscapeDataString(id) + "/resolve", body);
            Refresh();
            return ExtractError(response);
        }

        public async Task<string> OrchestrationActionAsync(string method, Dictionary<string, object> parameters)
        {
            Dictionary<string, object> body = new Dictionary<string, object>();
            body["method"] = method; body["params"] = parameters;
            string response = await PostControlAsync("/_prospero/control/orchestration/action", body);
            Refresh();
            return ExtractError(response);
        }

        public async Task<string> AccountOperationAsync(Dictionary<string, object> body)
        {
            body["requestId"] = Guid.NewGuid().ToString("N");
            string response = await PostControlAsync("/_prospero/control/accounts", body);
            try
            {
                Dictionary<string, object> root = JsonValue.ParseObject(response);
                string error = JsonValue.String(root, "error", "");
                if (!string.IsNullOrWhiteSpace(error)) return error;
                LastAccountSessionId = JsonValue.String(root, "sessionId", "");
                Accounts.Clear();
                object raw;
                foreach (object item in root.TryGetValue("accounts", out raw) ? JsonValue.AsArray(raw) : new object[0])
                {
                    Dictionary<string, object> account = JsonValue.AsObject(item);
                    object profileRaw;
                    Dictionary<string, object> profile = account.TryGetValue("apiProfile", out profileRaw)
                        ? JsonValue.AsObject(profileRaw) : new Dictionary<string, object>();
                    Accounts.Add(new AccountInfo
                    {
                        Id = JsonValue.String(account, "id", ""), Agent = JsonValue.String(account, "agent", ""),
                        Name = JsonValue.String(account, "name", ""), Managed = JsonValue.Bool(account, "managed", false),
                        IsDefault = JsonValue.Bool(account, "isDefault", false), Status = JsonValue.String(account, "status", ""),
                        Detail = JsonValue.String(account, "detail", ""), ActiveSessions = JsonValue.Int(account, "activeSessions", 0),
                        HasApiProfile = profile.Count > 0, BaseUrl = JsonValue.String(profile, "baseUrl", ""), Model = JsonValue.String(profile, "model", "")
                    });
                }
                RaiseSnapshotChanged();
                return JsonValue.Bool(root, "ok", true) ? null : JsonValue.String(root, "error", "账号操作失败");
            }
            catch (Exception error) { return string.IsNullOrWhiteSpace(response) ? error.Message : response; }
        }

        public Task<string> RefreshAccountsAsync()
        {
            Dictionary<string, object> body = new Dictionary<string, object>();
            body["type"] = "agent.accounts.list";
            return AccountOperationAsync(body);
        }

        public void ClearLog()
        {
            lock (logLock) { logText = ""; }
            try { File.WriteAllText(Path.Combine(Home, "windows-shell.log"), "", Encoding.UTF8); } catch { }
            RaiseSnapshotChanged();
        }

        public string FindNode()
        {
            if (Settings.NodeMode == "explicit") return File.Exists(Settings.NodePath) ? Settings.NodePath : null;
            return FindSystemNode();
        }

        public string FindSystemNode()
        {
            string nvmSymlink = Environment.GetEnvironmentVariable("NVM_SYMLINK");
            if (!string.IsNullOrWhiteSpace(nvmSymlink))
            {
                string nvmNode = Path.Combine(nvmSymlink.Trim().Trim('"'), "node.exe");
                if (File.Exists(nvmNode)) return nvmNode;
            }
            string fromPath = FindOnPath("node.exe");
            if (fromPath != null) return fromPath;
            string[] candidates = {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs", "node.exe")
            };
            foreach (string candidate in candidates) if (File.Exists(candidate)) return candidate;
            return null;
        }

        public string FindCli()
        {
            if (File.Exists(Settings.CliPath)) return Settings.CliPath;
            string[] starts = { AppDomain.CurrentDomain.BaseDirectory, Environment.CurrentDirectory };
            foreach (string start in starts)
            {
                DirectoryInfo current = new DirectoryInfo(start);
                for (int i = 0; i < 8 && current != null; i++, current = current.Parent)
                {
                    string candidate = Path.Combine(current.FullName, "apps", "daemon", "dist", "cli.js");
                    if (File.Exists(candidate)) return candidate;
                }
            }
            return null;
        }

        public string SelfCheck()
        {
            Refresh();
            StringBuilder value = new StringBuilder();
            value.AppendLine("Prospero Windows 桌面端自检");
            value.AppendLine("  executable: " + Process.GetCurrentProcess().MainModule.FileName);
            value.AppendLine("  node:       " + (FindNode() ?? "❌ 找不到"));
            value.AppendLine("  node mode:  " + (Settings.NodeMode == "explicit" ? "指定 node.exe" : "系统 / NVM 当前版本"));
            value.AppendLine("  prosperod:  " + (FindCli() ?? "❌ 找不到"));
            value.AppendLine("  home:       " + Home);
            value.AppendLine("  daemon:     " + StateLabel);
            value.AppendLine("  port:       " + Port);
            value.AppendLine("  bind:       " + Bind);
            value.AppendLine("  sessions:   " + Sessions.Count);
            value.AppendLine("  devices:    " + Devices.Count);
            value.AppendLine("  startup:    " + (StartupManager.IsEnabled ? "已启用" : "未启用"));
            return value.ToString();
        }

        private async Task<ProcessResult> RunCliAsync(string[] arguments, bool writeLog)
        {
            string node = FindNode(); string cli = FindCli();
            if (node == null || cli == null) return new ProcessResult(1, "找不到 Node.js 或 prosperod CLI");
            ProcessStartInfo start = new ProcessStartInfo(node);
            StringBuilder command = new StringBuilder(Quote(cli));
            foreach (string argument in arguments) command.Append(" ").Append(Quote(argument));
            start.Arguments = command.ToString();
            start.UseShellExecute = false; start.CreateNoWindow = true;
            start.RedirectStandardOutput = true; start.RedirectStandardError = true;
            start.StandardOutputEncoding = Encoding.UTF8; start.StandardErrorEncoding = Encoding.UTF8;
            start.WorkingDirectory = FindRepositoryRoot(cli) ?? Environment.CurrentDirectory;
            return await Task.Run(delegate
            {
                try
                {
                    using (Process process = Process.Start(start))
                    {
                        string output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
                        process.WaitForExit();
                        if (writeLog) AppendLog(output);
                        return new ProcessResult(process.ExitCode, output);
                    }
                }
                catch (Exception error) { return new ProcessResult(1, error.Message); }
            });
        }

        private async Task<string> PostControlAsync(string path, Dictionary<string, object> body)
        {
            if (!IsRunning || string.IsNullOrWhiteSpace(ControlToken)) return "daemon 尚未提供本机控制接口";
            return await Task.Run(delegate
            {
                try
                {
                    HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + Port + path);
                    request.Method = "POST";
                    request.Headers[HttpRequestHeader.Authorization] = "Bearer " + ControlToken;
                    request.Timeout = 15000;
                    if (body != null)
                    {
                        byte[] data = Encoding.UTF8.GetBytes(JsonValue.Serialize(body));
                        request.ContentType = "application/json";
                        request.ContentLength = data.Length;
                        using (Stream stream = request.GetRequestStream()) stream.Write(data, 0, data.Length);
                    }
                    using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                    using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                        return reader.ReadToEnd();
                }
                catch (WebException error)
                {
                    HttpWebResponse response = error.Response as HttpWebResponse;
                    if (response != null)
                        using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) return reader.ReadToEnd();
                    return error.Message;
                }
                catch (Exception error) { return error.Message; }
            });
        }

        private async Task<string> GetControlAsync(string path)
        {
            if (!IsRunning || string.IsNullOrWhiteSpace(ControlToken)) return "{\"error\":\"daemon 尚未提供本机控制接口\"}";
            return await Task.Run(delegate
            {
                try
                {
                    HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + Port + path);
                    request.Method = "GET";
                    request.Headers[HttpRequestHeader.Authorization] = "Bearer " + ControlToken;
                    request.Timeout = 15000;
                    using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                    using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                        return reader.ReadToEnd();
                }
                catch (WebException error)
                {
                    HttpWebResponse response = error.Response as HttpWebResponse;
                    if (response != null)
                        using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) return "{\"error\":" + JsonValue.Serialize(reader.ReadToEnd()) + "}";
                    return "{\"error\":" + JsonValue.Serialize(error.Message) + "}";
                }
                catch (Exception error) { return "{\"error\":" + JsonValue.Serialize(error.Message) + "}"; }
            });
        }

        private static string ExtractError(string response)
        {
            if (string.IsNullOrWhiteSpace(response)) return null;
            try
            {
                Dictionary<string, object> root = JsonValue.ParseObject(response);
                string error = JsonValue.String(root, "error", "");
                return string.IsNullOrWhiteSpace(error) ? null : error;
            }
            catch { return response.Trim(); }
        }

        private void OnDaemonOutput(object sender, DataReceivedEventArgs args)
        {
            if (args.Data != null) AppendLog(args.Data + Environment.NewLine);
        }

        private void LoadLogTail()
        {
            string path = Path.Combine(Home, "windows-shell.log");
            try
            {
                if (!File.Exists(path)) return;
                string[] lines = File.ReadAllLines(path, Encoding.UTF8);
                int first = Math.Max(0, lines.Length - 300);
                lock (logLock) { logText = string.Join(Environment.NewLine, lines, first, lines.Length - first); }
            }
            catch { }
        }

        private void EnsureUtf8LogEpoch()
        {
            string marker = Path.Combine(Home, "windows-shell.log.encoding");
            if (File.Exists(marker)) return;
            try
            {
                Directory.CreateDirectory(Home);
                string current = Path.Combine(Home, "windows-shell.log");
                if (File.Exists(current) && new FileInfo(current).Length > 0)
                {
                    string archive = Path.Combine(Home, "windows-shell.pre-utf8.log");
                    if (File.Exists(archive)) archive = Path.Combine(Home, "windows-shell.pre-utf8-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".log");
                    File.Move(current, archive);
                }
                File.WriteAllText(marker, "utf-8-v1", new UTF8Encoding(false));
            }
            catch { }
        }

        private void AppendLog(string value)
        {
            string safe = Regex.Replace(value ?? "", @"(?i)(hostSecret|token|ticket|authorization)(\s*[:=]\s*)([^\s,}\]]+)", "$1$2[REDACTED]");
            lock (logLock)
            {
                logText += safe;
                string[] lines = logText.Split(new string[] { "\r\n", "\n" }, StringSplitOptions.None);
                if (lines.Length > 300) logText = string.Join(Environment.NewLine, lines, lines.Length - 300, 300);
            }
            try
            {
                Directory.CreateDirectory(Home);
                string path = Path.Combine(Home, "windows-shell.log");
                if (File.Exists(path) && new FileInfo(path).Length > 1024 * 1024) File.WriteAllText(path, "", Encoding.UTF8);
                File.AppendAllText(path, safe, Encoding.UTF8);
            }
            catch { }
        }

        private static string FindOnPath(string fileName)
        {
            string path = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string item in path.Split(Path.PathSeparator))
            {
                try
                {
                    string candidate = Path.Combine(item.Trim().Trim('"'), fileName);
                    if (File.Exists(candidate)) return candidate;
                }
                catch { }
            }
            return null;
        }

        private static string FindRepositoryRoot(string cli)
        {
            DirectoryInfo current = new FileInfo(cli).Directory;
            while (current != null)
            {
                if (File.Exists(Path.Combine(current.FullName, "package.json")) && Directory.Exists(Path.Combine(current.FullName, "apps")))
                    return current.FullName;
                current = current.Parent;
            }
            return null;
        }

        private static bool IsProcessAlive(int pid)
        {
            try { return !Process.GetProcessById(pid).HasExited; }
            catch { return false; }
        }

        private static string Quote(string value) { return "\"" + (value ?? "").Replace("\"", "\\\"") + "\""; }

        private void RaiseSnapshotChanged()
        {
            EventHandler handler = SnapshotChanged;
            if (handler != null) handler(this, EventArgs.Empty);
        }

        public void Dispose()
        {
            disposed = true;
            if (refreshTimer != null) refreshTimer.Dispose();
            if (managedProcess != null) managedProcess.Dispose();
        }

        private sealed class ProcessResult
        {
            public readonly int ExitCode;
            public readonly string Output;
            public ProcessResult(int exitCode, string output) { ExitCode = exitCode; Output = output ?? ""; }
        }
    }
}
