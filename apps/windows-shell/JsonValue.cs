using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace Prospero.WindowsShell
{
    internal static class JsonValue
    {
        private static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer();

        public static Dictionary<string, object> ReadObject(string path)
        {
            try
            {
                if (!File.Exists(path)) return new Dictionary<string, object>();
                return AsObject(Serializer.DeserializeObject(File.ReadAllText(path, Encoding.UTF8)));
            }
            catch
            {
                return new Dictionary<string, object>();
            }
        }

        public static Dictionary<string, object> ParseObject(string json)
        {
            return AsObject(Serializer.DeserializeObject(json));
        }

        public static string Serialize(object value)
        {
            return Serializer.Serialize(value);
        }

        public static Dictionary<string, object> AsObject(object value)
        {
            Dictionary<string, object> result = value as Dictionary<string, object>;
            return result ?? new Dictionary<string, object>();
        }

        public static object[] AsArray(object value)
        {
            object[] array = value as object[];
            if (array != null) return array;
            ArrayList list = value as ArrayList;
            return list == null ? new object[0] : list.ToArray();
        }

        public static string String(Dictionary<string, object> value, string key, string fallback)
        {
            object raw;
            if (!value.TryGetValue(key, out raw) || raw == null) return fallback;
            return Convert.ToString(raw, CultureInfo.InvariantCulture) ?? fallback;
        }

        public static int Int(Dictionary<string, object> value, string key, int fallback)
        {
            object raw;
            if (!value.TryGetValue(key, out raw) || raw == null) return fallback;
            try { return Convert.ToInt32(raw, CultureInfo.InvariantCulture); }
            catch { return fallback; }
        }

        public static bool Bool(Dictionary<string, object> value, string key, bool fallback)
        {
            object raw;
            if (!value.TryGetValue(key, out raw) || raw == null) return fallback;
            try { return Convert.ToBoolean(raw, CultureInfo.InvariantCulture); }
            catch { return fallback; }
        }

        public static double Double(Dictionary<string, object> value, string key, double fallback)
        {
            object raw;
            if (!value.TryGetValue(key, out raw) || raw == null) return fallback;
            try { return Convert.ToDouble(raw, CultureInfo.InvariantCulture); }
            catch { return fallback; }
        }
    }
}
