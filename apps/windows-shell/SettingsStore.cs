using System;
using System.Diagnostics;
using System.IO;
using Microsoft.Win32;

namespace Prospero.WindowsShell
{
    internal sealed class SettingsStore
    {
        private const string KeyPath = @"Software\Prospero\WindowsShell";

        public string NodePath { get { return Read("NodePath", ""); } set { Write("NodePath", value); } }
        public string NodeMode
        {
            get
            {
                string value = Read("NodeMode", "");
                if (value == "system" || value == "explicit") return value;
                return string.IsNullOrWhiteSpace(NodePath) ? "system" : "explicit";
            }
            set { Write("NodeMode", value == "explicit" ? "explicit" : "system"); }
        }
        public string CliPath { get { return Read("CliPath", ""); } set { Write("CliPath", value); } }
        public string PendingBind { get { return Read("PendingBind", ""); } set { Write("PendingBind", value); } }
        public bool StartDaemonOnLaunch { get { return ReadBool("StartDaemonOnLaunch", true); } set { Write("StartDaemonOnLaunch", value ? "1" : "0"); } }
        public string RecentProjects { get { return Read("RecentProjects", ""); } set { Write("RecentProjects", value); } }
        public string ThemeMode { get { return Read("ThemeMode", "system"); } set { Write("ThemeMode", value); } }

        private static string Read(string name, string fallback)
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(KeyPath))
            {
                object value = key == null ? null : key.GetValue(name);
                return value == null ? fallback : Convert.ToString(value);
            }
        }

        private static bool ReadBool(string name, bool fallback)
        {
            string value = Read(name, fallback ? "1" : "0");
            return value == "1" || value.Equals("true", StringComparison.OrdinalIgnoreCase);
        }

        private static void Write(string name, string value)
        {
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(KeyPath))
            {
                key.SetValue(name, value ?? "", RegistryValueKind.String);
            }
        }
    }

    internal static class StartupManager
    {
        private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string ValueName = "Prospero";

        public static bool IsEnabled
        {
            get
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunKey))
                {
                    return key != null && key.GetValue(ValueName) != null;
                }
            }
        }

        public static void SetEnabled(bool enabled)
        {
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(RunKey))
            {
                if (enabled)
                {
                    string executable = Process.GetCurrentProcess().MainModule.FileName;
                    key.SetValue(ValueName, BuildCommand(executable), RegistryValueKind.String);
                }
                else
                {
                    key.DeleteValue(ValueName, false);
                }
            }
        }

        public static string BuildCommand(string executable)
        {
            return "\"" + executable + "\" --background";
        }
    }
}
