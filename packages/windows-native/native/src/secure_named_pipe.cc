#include "prospero_windows_native.h"

#if defined(_WIN32)

#include <windows.h>
#include <sddl.h>

#include <atomic>
#include <cstddef>
#include <condition_variable>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>
#include <wchar.h>

namespace {

constexpr uint32_t kMaximumSecurityDescriptorBytes = 64U * 1024U;
constexpr size_t kMaximumPipeNameChars = 256;

prospero_status StatusFromLastError(DWORD error);

struct TokenIdentity {
  std::vector<BYTE> user_sid;
  std::vector<BYTE> logon_sid;
  std::wstring user_sid_text;
  DWORD session_id = 0;
  DWORD integrity_rid = 0;
};

/**
 * Owns exactly one pipe HANDLE. Blocking I/O borrows it through Begin/End;
 * close cancels all overlapped operations, waits for those borrowers to leave,
 * and only then closes it. This prevents a second CloseHandle from ever racing
 * a newly recycled OS handle value.
 */
class CancelablePipeHandle {
 public:
  explicit CancelablePipeHandle(HANDLE handle) : handle_(handle) {}
  ~CancelablePipeHandle() { CancelAndClose(); }

  CancelablePipeHandle(const CancelablePipeHandle&) = delete;
  CancelablePipeHandle& operator=(const CancelablePipeHandle&) = delete;

  bool Begin(HANDLE* out_handle) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (stopped_ || handle_ == INVALID_HANDLE_VALUE) return false;
    ++in_flight_;
    *out_handle = handle_;
    return true;
  }

  void End() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (in_flight_ != 0) --in_flight_;
    if (stopped_ && in_flight_ == 0) drained_.notify_all();
  }

  void CancelAndClose() noexcept {
    std::lock_guard<std::mutex> termination_lock(termination_mutex_);
    const HANDLE handle = StopAndDrain();
    if (handle == INVALID_HANDLE_VALUE) return;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      handle_ = INVALID_HANDLE_VALUE;
    }
    // This is the only code path that calls CloseHandle for the endpoint.
    CloseHandle(handle);
  }

  prospero_status CancelAndDisconnect() noexcept {
    std::lock_guard<std::mutex> termination_lock(termination_mutex_);
    const HANDLE handle = StopAndDrain();
    if (handle == INVALID_HANDLE_VALUE) return PROSPERO_STATUS_NOT_FOUND;
    if (!DisconnectNamedPipe(handle)) return StatusFromLastError(GetLastError());
    // stopped_ deliberately stays true: once disconnected, this connection
    // handle cannot be borrowed for a second client or concurrent I/O.
    return PROSPERO_STATUS_OK;
  }

 private:
  HANDLE StopAndDrain() noexcept {
    HANDLE handle = INVALID_HANDLE_VALUE;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (handle_ == INVALID_HANDLE_VALUE) return INVALID_HANDLE_VALUE;
      stopped_ = true;
      handle = handle_;
    }
    // CancelIoEx is intentionally outside the mutex: completion needs End()
    // to acquire it. The handle stays open until every borrower has drained.
    CancelIoEx(handle, nullptr);
    std::unique_lock<std::mutex> lock(mutex_);
    drained_.wait(lock, [this] { return in_flight_ == 0; });
    return handle_;
  }

  std::mutex mutex_;
  std::mutex termination_mutex_;
  std::condition_variable drained_;
  HANDLE handle_ = INVALID_HANDLE_VALUE;
  uint32_t in_flight_ = 0;
  bool stopped_ = false;
};

class PipeIoLease {
 public:
  explicit PipeIoLease(const std::shared_ptr<CancelablePipeHandle>& endpoint)
      : endpoint_(endpoint), acquired_(endpoint_ != nullptr && endpoint_->Begin(&handle_)) {}
  ~PipeIoLease() {
    if (acquired_) endpoint_->End();
  }

  bool acquired() const { return acquired_; }
  HANDLE handle() const { return handle_; }

 private:
  std::shared_ptr<CancelablePipeHandle> endpoint_;
  HANDLE handle_ = INVALID_HANDLE_VALUE;
  bool acquired_ = false;
};

struct PipeServer {
  std::mutex mutex;
  std::wstring pipe_name;
  std::wstring allowed_user_sid;
  std::vector<BYTE> security_descriptor;
  TokenIdentity owner;
  DWORD max_instances = 0;
  DWORD inbound_buffer_bytes = 0;
  DWORD outbound_buffer_bytes = 0;
  std::shared_ptr<CancelablePipeHandle> listener;
  bool first_instance = true;
  bool accept_in_progress = false;
  bool closed = false;
};

struct PipeConnection {
  std::shared_ptr<CancelablePipeHandle> endpoint;
  std::vector<BYTE> expected_user_sid;
  std::vector<BYTE> expected_logon_sid;
  DWORD expected_session_id = 0;
  DWORD minimum_integrity_rid = 0;
  std::atomic<bool> received_message{false};
};

std::mutex g_registry_mutex;
std::unordered_map<uint64_t, std::shared_ptr<PipeServer>> g_servers;
std::unordered_map<uint64_t, std::shared_ptr<PipeConnection>> g_connections;
std::atomic<uint64_t> g_next_handle{1};
thread_local std::wstring g_peer_sid_copy;

prospero_status StatusFromLastError(DWORD error) {
  switch (error) {
    case ERROR_ACCESS_DENIED:
      return PROSPERO_STATUS_ACCESS_DENIED;
    case ERROR_FILE_NOT_FOUND:
    case ERROR_PATH_NOT_FOUND:
    case ERROR_INVALID_HANDLE:
    case ERROR_BROKEN_PIPE:
    case ERROR_PIPE_NOT_CONNECTED:
    case ERROR_OPERATION_ABORTED:
      return PROSPERO_STATUS_NOT_FOUND;
    case ERROR_INVALID_PARAMETER:
    case ERROR_BAD_PIPE:
      return PROSPERO_STATUS_INVALID_ARGUMENT;
    default:
      return PROSPERO_STATUS_SYSTEM_ERROR;
  }
}

uint64_t AllocateHandle() {
  uint64_t value = g_next_handle.fetch_add(1, std::memory_order_relaxed);
  if (value == 0) value = g_next_handle.fetch_add(1, std::memory_order_relaxed);
  return value;
}

std::shared_ptr<PipeServer> FindServer(prospero_secure_pipe_server_handle handle) {
  std::lock_guard<std::mutex> lock(g_registry_mutex);
  const auto found = g_servers.find(handle);
  return found == g_servers.end() ? nullptr : found->second;
}

std::shared_ptr<PipeConnection> FindConnection(
    prospero_secure_pipe_connection_handle handle) {
  std::lock_guard<std::mutex> lock(g_registry_mutex);
  const auto found = g_connections.find(handle);
  return found == g_connections.end() ? nullptr : found->second;
}

bool QueryTokenBuffer(HANDLE token,
                      TOKEN_INFORMATION_CLASS information_class,
                      std::vector<BYTE>* output) {
  DWORD needed = 0;
  if (GetTokenInformation(token, information_class, nullptr, 0, &needed) ||
      GetLastError() != ERROR_INSUFFICIENT_BUFFER || needed == 0) {
    return false;
  }
  output->resize(needed);
  return GetTokenInformation(token, information_class, output->data(), needed, &needed) != FALSE;
}

bool CopySidValue(PSID source, std::vector<BYTE>* destination) {
  if (source == nullptr || !IsValidSid(source)) return false;
  const DWORD size = GetLengthSid(source);
  if (size == 0) return false;
  destination->resize(size);
  return ::CopySid(size, destination->data(), source) != FALSE;
}

bool SidToString(PSID sid, std::wstring* output) {
  LPWSTR raw = nullptr;
  if (!ConvertSidToStringSidW(sid, &raw) || raw == nullptr) return false;
  *output = raw;
  LocalFree(raw);
  return true;
}

bool QueryTokenIdentity(HANDLE token, TokenIdentity* output) {
  std::vector<BYTE> user_buffer;
  std::vector<BYTE> group_buffer;
  std::vector<BYTE> integrity_buffer;
  if (!QueryTokenBuffer(token, TokenUser, &user_buffer) ||
      !QueryTokenBuffer(token, TokenGroups, &group_buffer) ||
      !QueryTokenBuffer(token, TokenIntegrityLevel, &integrity_buffer)) {
    return false;
  }
  const TOKEN_USER* user = reinterpret_cast<const TOKEN_USER*>(user_buffer.data());
  if (!CopySidValue(user->User.Sid, &output->user_sid) ||
      !SidToString(user->User.Sid, &output->user_sid_text)) {
    return false;
  }
  const TOKEN_GROUPS* groups = reinterpret_cast<const TOKEN_GROUPS*>(group_buffer.data());
  PSID logon_sid = nullptr;
  for (DWORD index = 0; index < groups->GroupCount; ++index) {
    if ((groups->Groups[index].Attributes & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID) {
      logon_sid = groups->Groups[index].Sid;
      break;
    }
  }
  if (!CopySidValue(logon_sid, &output->logon_sid)) return false;
  const TOKEN_MANDATORY_LABEL* integrity =
      reinterpret_cast<const TOKEN_MANDATORY_LABEL*>(integrity_buffer.data());
  const UCHAR* count = GetSidSubAuthorityCount(integrity->Label.Sid);
  if (count == nullptr || *count == 0) return false;
  const DWORD* rid = GetSidSubAuthority(integrity->Label.Sid, *count - 1);
  if (rid == nullptr) return false;
  output->integrity_rid = *rid;
  DWORD session_size = 0;
  if (!GetTokenInformation(token, TokenSessionId, &output->session_id,
                           static_cast<DWORD>(sizeof(output->session_id)), &session_size) ||
      session_size != static_cast<DWORD>(sizeof(output->session_id))) {
    return false;
  }
  return true;
}

bool QueryCurrentTokenIdentity(TokenIdentity* output) {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  const bool result = QueryTokenIdentity(token, output);
  CloseHandle(token);
  return result;
}

bool SidsEqual(const std::vector<BYTE>& left, const std::vector<BYTE>& right) {
  return !left.empty() && !right.empty() &&
         EqualSid(const_cast<BYTE*>(left.data()), const_cast<BYTE*>(right.data())) != FALSE;
}

bool StringSidMatches(const wchar_t* string_sid, const std::vector<BYTE>& expected_sid) {
  if (string_sid == nullptr || expected_sid.empty()) return false;
  PSID parsed = nullptr;
  if (!ConvertStringSidToSidW(string_sid, &parsed) || parsed == nullptr) return false;
  const bool matches = EqualSid(parsed, const_cast<BYTE*>(expected_sid.data())) != FALSE;
  LocalFree(parsed);
  return matches;
}

bool IsStrictLocalPipeName(const wchar_t* value) {
  static const wchar_t kPrefix[] = L"\\\\.\\pipe\\";
  if (value == nullptr || wcsncmp(value, kPrefix, wcslen(kPrefix)) != 0 ||
      value[wcslen(kPrefix)] == L'\0') {
    return false;
  }
  size_t suffix_length = 0;
  for (const wchar_t* current = value + wcslen(kPrefix); *current != L'\0'; ++current) {
    if (++suffix_length > kMaximumPipeNameChars) return false;
    if (*current < 0x20 || *current == L'\\' || *current == L'/' || *current == L':') {
      return false;
    }
  }
  return true;
}

bool IsSidWithinDescriptor(const BYTE* bytes, uint32_t byte_count, DWORD offset) {
  if (offset == 0) return true;
  if (offset > byte_count || byte_count - offset < 8) return false;
  const BYTE* sid = bytes + offset;
  const size_t sid_bytes = 8U + static_cast<size_t>(sid[1]) * sizeof(DWORD);
  return sid_bytes <= byte_count - offset && IsValidSid(const_cast<BYTE*>(sid)) != FALSE;
}

bool IsAclWithinDescriptor(const BYTE* bytes,
                           uint32_t byte_count,
                           DWORD offset,
                           const ACL** out_dacl) {
  if (offset == 0 || offset > byte_count || byte_count - offset < sizeof(ACL)) return false;
  const ACL* dacl = reinterpret_cast<const ACL*>(bytes + offset);
  if (dacl->AclSize < sizeof(ACL) || dacl->AclSize > byte_count - offset) return false;
  *out_dacl = dacl;
  return true;
}

bool IsExplicitCurrentLogonDacl(const void* descriptor,
                                uint32_t supplied_bytes,
                                const std::vector<BYTE>& expected_logon_sid) {
  if (descriptor == nullptr || supplied_bytes < sizeof(SECURITY_DESCRIPTOR_RELATIVE) ||
      supplied_bytes > kMaximumSecurityDescriptorBytes || expected_logon_sid.empty()) {
    return false;
  }
  const BYTE* bytes = static_cast<const BYTE*>(descriptor);
  const SECURITY_DESCRIPTOR_RELATIVE* relative =
      reinterpret_cast<const SECURITY_DESCRIPTOR_RELATIVE*>(bytes);
  if (relative->Revision != SECURITY_DESCRIPTOR_REVISION ||
      (relative->Control & (SE_SELF_RELATIVE | SE_DACL_PROTECTED | SE_DACL_PRESENT)) !=
          (SE_SELF_RELATIVE | SE_DACL_PROTECTED | SE_DACL_PRESENT) ||
      (relative->Control & SE_SACL_PRESENT) != 0 || relative->Sacl != 0 ||
      !IsSidWithinDescriptor(bytes, supplied_bytes, relative->Owner) ||
      !IsSidWithinDescriptor(bytes, supplied_bytes, relative->Group)) {
    return false;
  }
  const ACL* bounded_dacl = nullptr;
  if (!IsAclWithinDescriptor(bytes, supplied_bytes, relative->Dacl, &bounded_dacl)) return false;
  if (bounded_dacl->AceCount != 1 || bounded_dacl->AclSize < sizeof(ACL) + sizeof(ACE_HEADER)) {
    return false;
  }
  const ACE_HEADER* bounded_header = reinterpret_cast<const ACE_HEADER*>(
      reinterpret_cast<const BYTE*>(bounded_dacl) + sizeof(ACL));
  if (bounded_header->AceType != ACCESS_ALLOWED_ACE_TYPE || bounded_header->AceFlags != 0 ||
      bounded_header->AceSize < offsetof(ACCESS_ALLOWED_ACE, SidStart) + 8 ||
      bounded_header->AceSize != bounded_dacl->AclSize - sizeof(ACL)) {
    return false;
  }
  const ACCESS_ALLOWED_ACE* bounded_ace =
      reinterpret_cast<const ACCESS_ALLOWED_ACE*>(bounded_header);
  const size_t ace_sid_bytes = 8U +
      static_cast<size_t>(reinterpret_cast<const BYTE*>(&bounded_ace->SidStart)[1]) * sizeof(DWORD);
  if (ace_sid_bytes > bounded_header->AceSize - offsetof(ACCESS_ALLOWED_ACE, SidStart)) {
    return false;
  }
  const PSECURITY_DESCRIPTOR security_descriptor =
      reinterpret_cast<PSECURITY_DESCRIPTOR>(const_cast<void*>(descriptor));
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  if (!IsValidSecurityDescriptor(security_descriptor) ||
      !GetSecurityDescriptorControl(security_descriptor, &control, &revision) ||
      (control & (SE_SELF_RELATIVE | SE_DACL_PROTECTED)) !=
          (SE_SELF_RELATIVE | SE_DACL_PROTECTED) ||
      GetSecurityDescriptorLength(security_descriptor) != supplied_bytes) {
    return false;
  }
  BOOL dacl_present = FALSE;
  BOOL dacl_defaulted = FALSE;
  PACL dacl = nullptr;
  if (!GetSecurityDescriptorDacl(security_descriptor, &dacl_present, &dacl, &dacl_defaulted) ||
      !dacl_present || dacl == nullptr || dacl_defaulted || dacl != bounded_dacl) {
    return false;
  }
  ACL_SIZE_INFORMATION info{};
  if (!GetAclInformation(dacl, &info, static_cast<DWORD>(sizeof(info)), AclSizeInformation) ||
      info.AceCount != 1) {
    return false;
  }
  void* raw_ace = nullptr;
  if (!GetAce(dacl, 0, &raw_ace) || raw_ace == nullptr) return false;
  const ACE_HEADER* header = reinterpret_cast<const ACE_HEADER*>(raw_ace);
  if (header->AceType != ACCESS_ALLOWED_ACE_TYPE || header->AceFlags != 0) return false;
  const ACCESS_ALLOWED_ACE* ace = reinterpret_cast<const ACCESS_ALLOWED_ACE*>(raw_ace);
  const PSID ace_sid = reinterpret_cast<PSID>(const_cast<DWORD*>(&ace->SidStart));
  // One exact allow ACE rules out NULL DACLs, Everyone/Users broad grants,
  // inherited grants, deny/allow mixtures, and any caller-controlled SID.
  return ace->Mask == GENERIC_ALL && IsValidSid(ace_sid) &&
         EqualSid(ace_sid, const_cast<BYTE*>(expected_logon_sid.data())) != FALSE;
}

prospero_status AwaitOverlapped(HANDLE handle, OVERLAPPED* overlapped, DWORD* out_bytes) {
  const DWORD wait = WaitForSingleObject(overlapped->hEvent, INFINITE);
  if (wait != WAIT_OBJECT_0) return PROSPERO_STATUS_SYSTEM_ERROR;
  DWORD bytes = 0;
  if (!GetOverlappedResult(handle, overlapped, &bytes, FALSE)) {
    return StatusFromLastError(GetLastError());
  }
  *out_bytes = bytes;
  return PROSPERO_STATUS_OK;
}

prospero_status ConnectCancelable(HANDLE handle) {
  HANDLE event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (event == nullptr) return StatusFromLastError(GetLastError());
  OVERLAPPED overlapped{};
  overlapped.hEvent = event;
  BOOL connected = ConnectNamedPipe(handle, &overlapped);
  DWORD error = connected ? ERROR_SUCCESS : GetLastError();
  prospero_status status = PROSPERO_STATUS_OK;
  if (!connected && error != ERROR_PIPE_CONNECTED) {
    if (error == ERROR_IO_PENDING) {
      DWORD ignored = 0;
      status = AwaitOverlapped(handle, &overlapped, &ignored);
    } else if (error == ERROR_NO_DATA) {
      // A client disappeared between instance creation and accept. Reset the
      // same owned instance once; caller may retry on a later new client.
      DisconnectNamedPipe(handle);
      ResetEvent(event);
      memset(&overlapped, 0, sizeof(overlapped));
      overlapped.hEvent = event;
      connected = ConnectNamedPipe(handle, &overlapped);
      error = connected ? ERROR_SUCCESS : GetLastError();
      if (!connected && error != ERROR_PIPE_CONNECTED) {
        if (error == ERROR_IO_PENDING) {
          DWORD ignored = 0;
          status = AwaitOverlapped(handle, &overlapped, &ignored);
        } else {
          status = StatusFromLastError(error);
        }
      }
    } else {
      status = StatusFromLastError(error);
    }
  }
  CloseHandle(event);
  return status;
}

prospero_status ReadCancelable(HANDLE handle,
                              uint8_t* buffer,
                              uint32_t capacity,
                              uint32_t* out_read) {
  HANDLE event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (event == nullptr) return StatusFromLastError(GetLastError());
  OVERLAPPED overlapped{};
  overlapped.hEvent = event;
  DWORD read = 0;
  const BOOL succeeded = ReadFile(handle, buffer, capacity, &read, &overlapped);
  const DWORD error = succeeded ? ERROR_SUCCESS : GetLastError();
  prospero_status status = PROSPERO_STATUS_OK;
  if (!succeeded) {
    if (error == ERROR_IO_PENDING) {
      status = AwaitOverlapped(handle, &overlapped, &read);
    } else {
      status = StatusFromLastError(error);
    }
  }
  CloseHandle(event);
  if (status == PROSPERO_STATUS_OK) *out_read = read;
  return status;
}

prospero_status WriteCancelable(HANDLE handle,
                               const uint8_t* buffer,
                               uint32_t length,
                               uint32_t* out_written) {
  HANDLE event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (event == nullptr) return StatusFromLastError(GetLastError());
  OVERLAPPED overlapped{};
  overlapped.hEvent = event;
  DWORD written = 0;
  const BOOL succeeded = WriteFile(handle, buffer, length, &written, &overlapped);
  const DWORD error = succeeded ? ERROR_SUCCESS : GetLastError();
  prospero_status status = PROSPERO_STATUS_OK;
  if (!succeeded) {
    if (error == ERROR_IO_PENDING) {
      status = AwaitOverlapped(handle, &overlapped, &written);
    } else {
      status = StatusFromLastError(error);
    }
  }
  CloseHandle(event);
  if (status == PROSPERO_STATUS_OK) *out_written = written;
  return status;
}

prospero_status CreateListeningInstanceLocked(PipeServer* server) {
  if (server->closed) return PROSPERO_STATUS_NOT_FOUND;
  if (server->listener != nullptr) return PROSPERO_STATUS_OK;
  SECURITY_ATTRIBUTES attributes{};
  attributes.nLength = sizeof(attributes);
  attributes.lpSecurityDescriptor = server->security_descriptor.data();
  attributes.bInheritHandle = FALSE;
  DWORD open_mode = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED;
  if (server->first_instance) open_mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
  const HANDLE pipe = CreateNamedPipeW(
      server->pipe_name.c_str(), open_mode,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
      server->max_instances, server->outbound_buffer_bytes, server->inbound_buffer_bytes,
      0, &attributes);
  if (pipe == INVALID_HANDLE_VALUE) return StatusFromLastError(GetLastError());
  try {
    server->listener = std::make_shared<CancelablePipeHandle>(pipe);
  } catch (...) {
    CloseHandle(pipe);
    throw;
  }
  server->first_instance = false;
  return PROSPERO_STATUS_OK;
}

void ClearPeer(prospero_pipe_peer_identity* out_peer) {
  out_peer->process.pid = 0;
  out_peer->process.creation_time_100ns = 0;
  out_peer->user_sid = nullptr;
  out_peer->session_id = 0;
}

}  // namespace

extern "C" prospero_status prospero_secure_pipe_server_create(
    const prospero_secure_pipe_server_options* options,
    prospero_secure_pipe_server_handle* out_server) {
  if (out_server != nullptr) *out_server = 0;
  if (options == nullptr || out_server == nullptr || !IsStrictLocalPipeName(options->pipe_name) ||
      options->security.allowed_user_sid == nullptr ||
      options->security.allowed_user_sid[0] == L'\0' ||
      options->security.self_relative_security_descriptor == nullptr ||
      options->security.security_descriptor_bytes == 0 ||
      options->security.security_descriptor_bytes > kMaximumSecurityDescriptorBytes ||
      options->max_instances == 0 ||
      options->max_instances > PIPE_UNLIMITED_INSTANCES) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  try {
    TokenIdentity current;
    if (!QueryCurrentTokenIdentity(&current)) return StatusFromLastError(GetLastError());
    std::vector<BYTE> security_descriptor(
        static_cast<const BYTE*>(options->security.self_relative_security_descriptor),
        static_cast<const BYTE*>(options->security.self_relative_security_descriptor) +
            options->security.security_descriptor_bytes);
    if (!StringSidMatches(options->security.allowed_user_sid, current.user_sid) ||
        !IsExplicitCurrentLogonDacl(security_descriptor.data(),
                                    static_cast<uint32_t>(security_descriptor.size()),
                                    current.logon_sid)) {
      return PROSPERO_STATUS_ACCESS_DENIED;
    }
    auto server = std::make_shared<PipeServer>();
    server->pipe_name = options->pipe_name;
    server->allowed_user_sid = options->security.allowed_user_sid;
    server->owner = std::move(current);
    server->max_instances = options->max_instances;
    server->inbound_buffer_bytes = options->inbound_buffer_bytes;
    server->outbound_buffer_bytes = options->outbound_buffer_bytes;
    server->security_descriptor = std::move(security_descriptor);
    {
      std::lock_guard<std::mutex> lock(server->mutex);
      const prospero_status status = CreateListeningInstanceLocked(server.get());
      if (status != PROSPERO_STATUS_OK) return status;
    }
    const uint64_t id = AllocateHandle();
    {
      std::lock_guard<std::mutex> lock(g_registry_mutex);
      g_servers.emplace(id, std::move(server));
    }
    *out_server = id;
    return PROSPERO_STATUS_OK;
  } catch (...) {
    *out_server = 0;
    return PROSPERO_STATUS_SYSTEM_ERROR;
  }
}

extern "C" prospero_status prospero_secure_pipe_server_accept(
    prospero_secure_pipe_server_handle server_handle,
    prospero_secure_pipe_connection_handle* out_connection) {
  if (out_connection != nullptr) *out_connection = 0;
  if (server_handle == 0 || out_connection == nullptr) return PROSPERO_STATUS_INVALID_ARGUMENT;
  try {
    const std::shared_ptr<PipeServer> server = FindServer(server_handle);
    if (server == nullptr) return PROSPERO_STATUS_NOT_FOUND;
    std::shared_ptr<CancelablePipeHandle> listener;
    {
      std::lock_guard<std::mutex> lock(server->mutex);
      if (server->closed || server->accept_in_progress) return PROSPERO_STATUS_SYSTEM_ERROR;
      const prospero_status ensure = CreateListeningInstanceLocked(server.get());
      if (ensure != PROSPERO_STATUS_OK) return ensure;
      listener = server->listener;
      server->accept_in_progress = true;
    }
    PipeIoLease lease(listener);
    const prospero_status accept_status = lease.acquired()
        ? ConnectCancelable(lease.handle())
        : PROSPERO_STATUS_NOT_FOUND;
    {
      std::lock_guard<std::mutex> lock(server->mutex);
      server->accept_in_progress = false;
      if (server->closed) return PROSPERO_STATUS_NOT_FOUND;
      if (accept_status != PROSPERO_STATUS_OK) return accept_status;
      if (server->listener == listener) {
        server->listener.reset();  // Ownership transfers to the connection below.
        // Keep the next endpoint pre-created whenever Windows permits it. With
        // maxInstances=1 it remains absent until the connection closes.
        const prospero_status next = CreateListeningInstanceLocked(server.get());
        if (next != PROSPERO_STATUS_OK && next != PROSPERO_STATUS_SYSTEM_ERROR) return next;
      }
    }
    auto connection = std::make_shared<PipeConnection>();
    connection->endpoint = std::move(listener);
    connection->expected_user_sid = server->owner.user_sid;
    connection->expected_logon_sid = server->owner.logon_sid;
    connection->expected_session_id = server->owner.session_id;
    connection->minimum_integrity_rid = server->owner.integrity_rid;
    const uint64_t id = AllocateHandle();
    {
      std::lock_guard<std::mutex> lock(g_registry_mutex);
      g_connections.emplace(id, std::move(connection));
    }
    *out_connection = id;
    return PROSPERO_STATUS_OK;
  } catch (...) {
    *out_connection = 0;
    return PROSPERO_STATUS_SYSTEM_ERROR;
  }
}

extern "C" prospero_status prospero_secure_pipe_server_close(
    prospero_secure_pipe_server_handle server_handle) {
  if (server_handle == 0) return PROSPERO_STATUS_INVALID_ARGUMENT;
  std::shared_ptr<PipeServer> server;
  {
    std::lock_guard<std::mutex> lock(g_registry_mutex);
    const auto found = g_servers.find(server_handle);
    if (found == g_servers.end()) return PROSPERO_STATUS_NOT_FOUND;
    server = found->second;
    g_servers.erase(found);
  }
  std::shared_ptr<CancelablePipeHandle> listener;
  {
    std::lock_guard<std::mutex> lock(server->mutex);
    server->closed = true;
    listener = std::move(server->listener);
  }
  if (listener != nullptr) listener->CancelAndClose();
  return PROSPERO_STATUS_OK;
}

extern "C" prospero_status prospero_secure_pipe_connection_read(
    prospero_secure_pipe_connection_handle connection_handle,
    uint8_t* buffer,
    uint32_t capacity,
    uint32_t* out_read) {
  if (out_read != nullptr) *out_read = 0;
  if (connection_handle == 0 || buffer == nullptr || capacity == 0 || out_read == nullptr) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  const std::shared_ptr<PipeConnection> connection = FindConnection(connection_handle);
  if (connection == nullptr) return PROSPERO_STATUS_NOT_FOUND;
  PipeIoLease lease(connection->endpoint);
  if (!lease.acquired()) return PROSPERO_STATUS_NOT_FOUND;
  const prospero_status status = ReadCancelable(lease.handle(), buffer, capacity, out_read);
  if (status == PROSPERO_STATUS_OK && *out_read != 0) {
    // Windows binds ImpersonateNamedPipeClient to the last message read. The
    // peer proof intentionally cannot be requested before this first frame.
    connection->received_message.store(true, std::memory_order_release);
  }
  return status;
}

extern "C" prospero_status prospero_secure_pipe_connection_write(
    prospero_secure_pipe_connection_handle connection_handle,
    const uint8_t* buffer,
    uint32_t length,
    uint32_t* out_written) {
  if (out_written != nullptr) *out_written = 0;
  if (connection_handle == 0 || buffer == nullptr || length == 0 || out_written == nullptr) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  const std::shared_ptr<PipeConnection> connection = FindConnection(connection_handle);
  if (connection == nullptr) return PROSPERO_STATUS_NOT_FOUND;
  PipeIoLease lease(connection->endpoint);
  if (!lease.acquired()) return PROSPERO_STATUS_NOT_FOUND;
  return WriteCancelable(lease.handle(), buffer, length, out_written);
}

extern "C" prospero_status prospero_secure_pipe_connection_peer_identity(
    prospero_secure_pipe_connection_handle connection_handle,
    prospero_pipe_peer_identity* out_peer) {
  if (out_peer != nullptr) ClearPeer(out_peer);
  if (connection_handle == 0 || out_peer == nullptr) return PROSPERO_STATUS_INVALID_ARGUMENT;
  try {
    const std::shared_ptr<PipeConnection> connection = FindConnection(connection_handle);
    if (connection == nullptr) return PROSPERO_STATUS_NOT_FOUND;
    if (!connection->received_message.load(std::memory_order_acquire)) {
      return PROSPERO_STATUS_ACCESS_DENIED;
    }
    PipeIoLease lease(connection->endpoint);
    if (!lease.acquired()) return PROSPERO_STATUS_NOT_FOUND;
    DWORD client_pid = 0;
    if (!GetNamedPipeClientProcessId(lease.handle(), &client_pid) || client_pid == 0) {
      return StatusFromLastError(GetLastError());
    }
    prospero_process_identity process{};
    const prospero_status process_status = prospero_get_process_identity(client_pid, &process);
    if (process_status != PROSPERO_STATUS_OK) return process_status;

    // Do not allocate, parse token groups, or take locks while impersonating.
    // The temporary thread token remains valid after RevertToSelf, so acquire
    // it first and immediately restore this native worker's original token.
    if (!ImpersonateNamedPipeClient(lease.handle())) return StatusFromLastError(GetLastError());
    HANDLE client_token = nullptr;
    const BOOL opened_token = OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &client_token);
    const DWORD token_error = opened_token ? ERROR_SUCCESS : GetLastError();
    if (!RevertToSelf()) {
      if (client_token != nullptr) CloseHandle(client_token);
      // Continuing this worker while it still impersonates the pipe client
      // would make every later native call attacker-context dependent.
      TerminateProcess(GetCurrentProcess(), ERROR_ACCESS_DENIED);
      RaiseFailFastException(nullptr, nullptr, 0);
      return PROSPERO_STATUS_SYSTEM_ERROR;
    }
    if (!opened_token) return StatusFromLastError(token_error);

    TokenIdentity client;
    if (!QueryTokenIdentity(client_token, &client)) {
      const prospero_status token_status = StatusFromLastError(GetLastError());
      CloseHandle(client_token);
      return token_status;
    }
    CloseHandle(client_token);
    if (!SidsEqual(client.user_sid, connection->expected_user_sid) ||
        !SidsEqual(client.logon_sid, connection->expected_logon_sid) ||
        client.session_id != connection->expected_session_id ||
        client.integrity_rid < SECURITY_MANDATORY_MEDIUM_RID ||
        client.integrity_rid < connection->minimum_integrity_rid) {
      return PROSPERO_STATUS_ACCESS_DENIED;
    }
    uint8_t still_matches = 0;
    const prospero_status match_status =
        prospero_process_identity_matches(process, &still_matches);
    if (match_status != PROSPERO_STATUS_OK) return match_status;
    if (still_matches == 0) return PROSPERO_STATUS_NOT_FOUND;
    g_peer_sid_copy = client.user_sid_text;
    out_peer->process = process;
    out_peer->user_sid = g_peer_sid_copy.c_str();
    out_peer->session_id = client.session_id;
    return PROSPERO_STATUS_OK;
  } catch (...) {
    ClearPeer(out_peer);
    return PROSPERO_STATUS_SYSTEM_ERROR;
  }
}

extern "C" prospero_status prospero_secure_pipe_connection_disconnect(
    prospero_secure_pipe_connection_handle connection_handle) {
  if (connection_handle == 0) return PROSPERO_STATUS_INVALID_ARGUMENT;
  const std::shared_ptr<PipeConnection> connection = FindConnection(connection_handle);
  if (connection == nullptr) return PROSPERO_STATUS_NOT_FOUND;
  const prospero_status status = connection->endpoint->CancelAndDisconnect();
  if (status != PROSPERO_STATUS_OK) return status;
  connection->received_message.store(false, std::memory_order_release);
  return PROSPERO_STATUS_OK;
}

extern "C" prospero_status prospero_secure_pipe_connection_close(
    prospero_secure_pipe_connection_handle connection_handle) {
  if (connection_handle == 0) return PROSPERO_STATUS_INVALID_ARGUMENT;
  std::shared_ptr<PipeConnection> connection;
  {
    std::lock_guard<std::mutex> lock(g_registry_mutex);
    const auto found = g_connections.find(connection_handle);
    if (found == g_connections.end()) return PROSPERO_STATUS_NOT_FOUND;
    connection = found->second;
    g_connections.erase(found);
  }
  connection->endpoint->CancelAndClose();
  return PROSPERO_STATUS_OK;
}

#else

extern "C" prospero_status prospero_secure_pipe_server_create(
    const prospero_secure_pipe_server_options* options,
    prospero_secure_pipe_server_handle* out_server) {
  if (out_server != nullptr) *out_server = 0;
  if (options == nullptr || out_server == nullptr || options->pipe_name == nullptr ||
      options->security.allowed_user_sid == nullptr ||
      options->security.self_relative_security_descriptor == nullptr ||
      options->security.security_descriptor_bytes == 0) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_secure_pipe_server_accept(
    prospero_secure_pipe_server_handle server,
    prospero_secure_pipe_connection_handle* out_connection) {
  if (out_connection != nullptr) *out_connection = 0;
  if (server == 0 || out_connection == nullptr) return PROSPERO_STATUS_INVALID_ARGUMENT;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_secure_pipe_server_close(
    prospero_secure_pipe_server_handle server) {
  return server == 0 ? PROSPERO_STATUS_INVALID_ARGUMENT : PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_secure_pipe_connection_read(
    prospero_secure_pipe_connection_handle connection,
    uint8_t* buffer,
    uint32_t capacity,
    uint32_t* out_read) {
  if (out_read != nullptr) *out_read = 0;
  if (connection == 0 || buffer == nullptr || capacity == 0 || out_read == nullptr) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_secure_pipe_connection_write(
    prospero_secure_pipe_connection_handle connection,
    const uint8_t* buffer,
    uint32_t length,
    uint32_t* out_written) {
  if (out_written != nullptr) *out_written = 0;
  if (connection == 0 || buffer == nullptr || length == 0 || out_written == nullptr) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_secure_pipe_connection_peer_identity(
    prospero_secure_pipe_connection_handle connection,
    prospero_pipe_peer_identity* out_peer) {
  if (out_peer != nullptr) {
    out_peer->process.pid = 0;
    out_peer->process.creation_time_100ns = 0;
    out_peer->user_sid = nullptr;
    out_peer->session_id = 0;
  }
  if (connection == 0 || out_peer == nullptr) return PROSPERO_STATUS_INVALID_ARGUMENT;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_secure_pipe_connection_disconnect(
    prospero_secure_pipe_connection_handle connection) {
  return connection == 0 ? PROSPERO_STATUS_INVALID_ARGUMENT : PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_secure_pipe_connection_close(
    prospero_secure_pipe_connection_handle connection) {
  return connection == 0 ? PROSPERO_STATUS_INVALID_ARGUMENT : PROSPERO_STATUS_NOT_AVAILABLE;
}

#endif
