using System;
using System.Collections.Generic;

namespace Prospero.WindowsShell
{
    internal sealed class DeviceInfo
    {
        public string Name;
        public bool AllowShell;
        public bool AllowOrchestration;
        public bool Bound;
        public double LastSeenAt;
    }

    internal sealed class SessionInfo
    {
        public string Id;
        public string Agent;
        public string Kind;
        public string Title;
        public string Cwd;
        public string Status;
        public int Pending;
        public double CreatedAt;
        public string Preview;
    }

    internal sealed class AccountInfo
    {
        public string Id;
        public string Agent;
        public string Name;
        public bool Managed;
        public bool IsDefault;
        public string Status;
        public string Detail;
        public int ActiveSessions;
        public bool HasApiProfile;
        public string BaseUrl;
        public string Model;
    }

    internal sealed class OrchestrationRunInfo
    {
        public string Id;
        public string Objective;
        public string Status;
        public double UpdatedAt;
    }

    internal sealed class OrchestrationTaskInfo
    {
        public string Id;
        public string RunId;
        public string Title;
        public string Status;
        public string Result;
    }

    internal sealed class GateInfo
    {
        public string Id;
        public string RunId;
        public string Question;
        public string Status;
        public string Decision;
    }

    internal sealed class PairingResult
    {
        public bool Success;
        public string Output;
        public string PairingUri;
    }
}
