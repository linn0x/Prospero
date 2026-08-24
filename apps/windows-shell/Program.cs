using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace Prospero.WindowsShell
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            int logSmokeIndex = Array.IndexOf(args, "--log-smoke-test");
            if (logSmokeIndex >= 0 && logSmokeIndex + 1 < args.Length)
                using (ProsperoController controller = new ProsperoController()) return controller.LogText.IndexOf(args[logSmokeIndex + 1], StringComparison.Ordinal) >= 0 ? 0 : 7;

            if (Array.IndexOf(args, "--self-check") >= 0)
            {
                int result; using (ProsperoController controller = new ProsperoController()) { TryWriteSelfCheck(controller.SelfCheck()); result = controller.RuntimeReady ? 0 : 1; }
                Environment.Exit(result); return result;
            }

            if (Array.IndexOf(args, "--daemon-smoke-test") >= 0)
            {
                using (ProsperoController controller = new ProsperoController())
                {
                    try
                    {
                        if (!controller.RuntimeReady) return 1; controller.StartDaemon(FindAvailablePort());
                        for (int i = 0; i < 120 && !controller.IsRunning; i++) { Thread.Sleep(100); controller.Refresh(); }
                        if (!controller.IsRunning) return 4; controller.StopDaemon(); for (int i = 0; i < 50 && controller.IsRunning; i++) Thread.Sleep(100);
                        return controller.IsRunning ? 5 : 0;
                    }
                    catch (Exception error) { try { Directory.CreateDirectory(controller.Home); File.WriteAllText(Path.Combine(controller.Home, "daemon-smoke-error.txt"), error.ToString()); } catch { } return 9; }
                }
            }

            if (Array.IndexOf(args, "--smoke-test") >= 0) return RunUiSmoke();
            int pairingPreview = Array.IndexOf(args, "--render-pairing-preview"); if (pairingPreview >= 0 && pairingPreview + 1 < args.Length) return RenderPairingPreview(args, pairingPreview);
            int preview = Array.IndexOf(args, "--render-preview"); if (preview >= 0 && preview + 1 < args.Length) return RenderMainPreview(args, preview);

            bool created;
            using (Mutex mutex = new Mutex(true, "Local\\Prospero.WindowsShell", out created))
            {
                if (!created) { MessageBox.Show("Prospero Windows 桌面端已经在运行。请从系统托盘打开。", "Prospero"); return 0; }
                bool background = Array.IndexOf(args, "--background") >= 0;
                using (ProsperoApplication application = new ProsperoApplication()) return application.RunShell(background);
            }
        }

        private static int RunUiSmoke()
        {
            Application application = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
            using (ProsperoController controller = new ProsperoController())
            {
                ThemeManager.Initialize(application, "light"); MainWindow window = new MainWindow(controller) { AllowClose = true };
                window.ApplyTemplate(); window.UpdateLayout(); if (window.NavigationPageCount != 7) return 2;
                if (!window.VerifyNodeModeUi()) return 8;
                PairingDialog pairing = new PairingDialog(null, controller); pairing.SetPreviewOutput(PairingPreviewOutput()); pairing.ApplyTemplate(); pairing.UpdateLayout(); pairing.Close();
                SessionWindow session = new SessionWindow(null, controller, new SessionInfo { Id = "smoke", Agent = "codex", Kind = "structured", Title = "Smoke", Cwd = Environment.CurrentDirectory }); session.ApplyTemplate(); session.UpdateLayout(); session.Close();
                ThemeManager.Apply(application, "dark"); window.UpdateLayout(); if (!ThemeManager.IsDark) return 6;
                string startup = StartupManager.BuildCommand(System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName); if (startup.IndexOf("--background", StringComparison.Ordinal) < 0) return 3;
                window.Close(); return controller.RuntimeReady ? 0 : 1;
            }
        }

        private static int RenderMainPreview(string[] args, int index)
        {
            Application application = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
            using (ProsperoController controller = new ProsperoController())
            {
                ThemeManager.Initialize(application, PreviewTheme(args)); MainWindow window = new MainWindow(controller) { AllowClose = true };
                int width; int height; int page; if (index + 2 < args.Length && int.TryParse(args[index + 2], out width)) window.Width = Math.Max(window.MinWidth, width); if (index + 3 < args.Length && int.TryParse(args[index + 3], out height)) window.Height = Math.Max(window.MinHeight, height); if (index + 4 < args.Length && int.TryParse(args[index + 4], out page)) window.SelectPreviewPage(page);
                int nodeMode = Array.IndexOf(args, "--node-mode"); if (nodeMode >= 0 && nodeMode + 1 < args.Length) window.SelectPreviewNodeMode(args[nodeMode + 1]);
                window.Show(); window.UpdateLayout(); RenderWindow(window, Path.GetFullPath(args[index + 1])); window.Close(); return 0;
            }
        }

        private static int RenderPairingPreview(string[] args, int index)
        {
            Application application = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
            using (ProsperoController controller = new ProsperoController())
            {
                ThemeManager.Initialize(application, PreviewTheme(args)); PairingDialog window = new PairingDialog(null, controller); int width; int height; if (index + 2 < args.Length && int.TryParse(args[index + 2], out width)) window.Width = Math.Max(window.MinWidth, width); if (index + 3 < args.Length && int.TryParse(args[index + 3], out height)) window.Height = Math.Max(window.MinHeight, height);
                window.SetPreviewOutput(PairingPreviewOutput()); window.Show(); window.UpdateLayout(); RenderWindow(window, Path.GetFullPath(args[index + 1])); window.Close(); return 0;
            }
        }

        private static string PreviewTheme(string[] args) { int index = Array.IndexOf(args, "--theme"); return index >= 0 && index + 1 < args.Length ? args[index + 1] : "light"; }
        private static void RenderWindow(Window window, string path)
        {
            int width = Math.Max(1, (int)Math.Ceiling(window.ActualWidth)); int height = Math.Max(1, (int)Math.Ceiling(window.ActualHeight));
            RenderTargetBitmap bitmap = new RenderTargetBitmap(width, height, 96, 96, PixelFormats.Pbgra32); bitmap.Render(window); PngBitmapEncoder encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap)); using (FileStream stream = File.Create(path)) encoder.Save(stream);
        }

        private static int FindAvailablePort() { System.Net.Sockets.TcpListener listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0); listener.Start(); int port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port; listener.Stop(); return port; }
        private static string PairingPreviewOutput() { StringBuilder value = new StringBuilder(); value.AppendLine("█████████████████████████████████████████"); for (int row = 0; row < 21; row++) { value.Append("██"); for (int column = 0; column < 37; column++) value.Append(((row * 7 + column * 11 + row * column) % 5) < 2 ? "█" : " "); value.AppendLine("██"); } value.AppendLine("█████████████████████████████████████████"); return value.ToString(); }
        private static void TryWriteSelfCheck(string value) { try { AttachConsole(0xffffffff); Console.OutputEncoding = Encoding.UTF8; Console.Write(value); Console.Out.Flush(); } catch { } }
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AttachConsole(uint processId);
    }
}
