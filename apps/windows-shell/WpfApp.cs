using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using Microsoft.Win32;
using Forms = System.Windows.Forms;

namespace Prospero.WindowsShell
{
    internal static class ThemeManager
    {
        public static string CurrentMode { get; private set; }
        public static bool IsDark { get; private set; }

        public static void Initialize(Application application, string mode)
        {
            application.Resources.MergedDictionaries.Add(new ResourceDictionary { Source = new Uri("Themes/Controls.xaml", UriKind.Relative) });
            Apply(application, mode);
        }

        public static void Apply(Application application, string mode)
        {
            if (mode != "light" && mode != "dark") mode = "system";
            CurrentMode = mode;
            IsDark = mode == "dark" || (mode == "system" && SystemUsesDarkTheme());
            for (int i = application.Resources.MergedDictionaries.Count - 1; i >= 0; i--)
            {
                Uri source = application.Resources.MergedDictionaries[i].Source;
                if (source != null && (source.OriginalString.IndexOf("Themes/Light.xaml", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    source.OriginalString.IndexOf("Themes/Dark.xaml", StringComparison.OrdinalIgnoreCase) >= 0))
                    application.Resources.MergedDictionaries.RemoveAt(i);
            }
            application.Resources.MergedDictionaries.Insert(0, new ResourceDictionary
            {
                Source = new Uri(IsDark ? "Themes/Dark.xaml" : "Themes/Light.xaml", UriKind.Relative)
            });
            foreach (Window window in application.Windows) ApplyWindow(window);
        }

        public static void ApplyWindow(Window window)
        {
            if (window == null) return;
            window.SetResourceReference(Control.BackgroundProperty, "CanvasBrush");
            window.SetResourceReference(Control.ForegroundProperty, "TextBrush");
            window.SourceInitialized += delegate { ApplyWindowHandle(new WindowInteropHelper(window).Handle); };
            if (new WindowInteropHelper(window).Handle != IntPtr.Zero) ApplyWindowHandle(new WindowInteropHelper(window).Handle);
        }

        private static bool SystemUsesDarkTheme()
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
                    return Convert.ToInt32(key == null ? 1 : key.GetValue("AppsUseLightTheme", 1)) == 0;
            }
            catch { return false; }
        }

        private static void ApplyWindowHandle(IntPtr handle)
        {
            try
            {
                int dark = IsDark ? 1 : 0;
                DwmSetWindowAttribute(handle, 20, ref dark, sizeof(int));
                int rounded = 2;
                DwmSetWindowAttribute(handle, 33, ref rounded, sizeof(int));
            }
            catch { }
        }

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
    }

    internal sealed class ProsperoApplication : Application, IDisposable
    {
        private ProsperoController controller;
        private MainWindow window;
        private Forms.NotifyIcon tray;
        private bool exiting;

        public int RunShell(bool background)
        {
            ShutdownMode = ShutdownMode.OnExplicitShutdown;
            controller = new ProsperoController();
            ThemeManager.Initialize(this, controller.Settings.ThemeMode);
            SystemEvents.UserPreferenceChanged += SystemEvents_UserPreferenceChanged;
            window = new MainWindow(controller);
            window.RequestExit += delegate { ExitProspero(); };
            CreateTray();
            controller.StartIfNeeded();
            if (!background) ShowWindow();
            return Run();
        }

        private void CreateTray()
        {
            Forms.ContextMenuStrip menu = new Forms.ContextMenuStrip();
            menu.Items.Add("打开 Prospero", null, delegate { Dispatcher.Invoke(ShowWindow); });
            menu.Items.Add("启动 daemon", null, delegate { controller.StartDaemon(); });
            menu.Items.Add("重启 daemon", null, async delegate { await controller.RestartDaemonAsync(); });
            menu.Items.Add(new Forms.ToolStripSeparator());
            Forms.ToolStripMenuItem startup = new Forms.ToolStripMenuItem("开机自启动") { Checked = StartupManager.IsEnabled, CheckOnClick = true };
            startup.CheckedChanged += delegate
            {
                try { StartupManager.SetEnabled(startup.Checked); }
                catch (Exception error) { Dispatcher.Invoke(delegate { WpfDialogs.Error(window, error.Message); }); }
            };
            menu.Items.Add(startup); menu.Items.Add(new Forms.ToolStripSeparator());
            menu.Items.Add("退出", null, delegate { Dispatcher.Invoke(ExitProspero); });

            tray = new Forms.NotifyIcon
            {
                Icon = Icon.ExtractAssociatedIcon(System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName),
                Text = "Prospero", Visible = true, ContextMenuStrip = menu
            };
            tray.DoubleClick += delegate { Dispatcher.Invoke(ShowWindow); };
            controller.SnapshotChanged += delegate
            {
                if (tray != null) tray.Text = controller.IsRunning ? "Prospero — daemon 运行中" : "Prospero — daemon 未运行";
            };
        }

        private void ShowWindow()
        {
            window.Show();
            if (window.WindowState == WindowState.Minimized) window.WindowState = WindowState.Normal;
            window.Activate();
        }

        private void ExitProspero()
        {
            if (exiting) return;
            exiting = true;
            if (tray != null) tray.Visible = false;
            if (controller.ManagedByShell) controller.StopDaemon();
            window.AllowClose = true;
            window.Close();
            Shutdown();
        }

        protected override void OnExit(ExitEventArgs e)
        {
            Dispose();
            base.OnExit(e);
        }

        public void Dispose()
        {
            SystemEvents.UserPreferenceChanged -= SystemEvents_UserPreferenceChanged;
            if (tray != null) { tray.Dispose(); tray = null; }
            if (controller != null) { controller.Dispose(); controller = null; }
        }

        private void SystemEvents_UserPreferenceChanged(object sender, UserPreferenceChangedEventArgs e)
        {
            if (ThemeManager.CurrentMode == "system") Dispatcher.BeginInvoke(new Action(delegate { ThemeManager.Apply(this, "system"); }));
        }
    }
}
