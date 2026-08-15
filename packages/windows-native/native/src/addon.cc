#include <node_api.h>

#include "prospero_windows_native.h"

#if defined(_WIN32)
#include <windows.h>
#include <sddl.h>
#endif

#include <array>
#include <cstdint>
#include <cstring>
#include <limits>
#include <string>
#include <algorithm>
#include <cwchar>
#include <mutex>
#include <new>
#include <unordered_map>
#include <utility>
#include <vector>

namespace {

constexpr uint32_t kMaximumPipeIoBytes = 16U * 1024U * 1024U;
#if defined(_WIN32)
constexpr uint32_t kMaxNativeIoBytes = 16u * 1024u * 1024u;
// CreateProcessW accepts at most 32,767 UTF-16 code units including its
// required terminators. The block builder counts every separator and final
// NUL before passing the owned memory to Windows.
constexpr size_t kMaxCreateProcessEnvironmentCodeUnits = 32767;
#endif

napi_value ThrowNotAvailable(napi_env env, napi_callback_info info) {
  (void)info;
  napi_throw_error(env, "PROSPERO_NATIVE_NOT_AVAILABLE",
                   "This Windows native capability is not implemented in this build");
  return nullptr;
}

napi_value ThrowInvalidArgument(napi_env env) {
  napi_throw_error(env, "PROSPERO_NATIVE_INVALID_ARGUMENT",
                   "Windows native operation received an invalid argument");
  return nullptr;
}

napi_value ThrowStatus(napi_env env, prospero_status status) {
  switch (status) {
    case PROSPERO_STATUS_INVALID_ARGUMENT:
      return ThrowInvalidArgument(env);
    case PROSPERO_STATUS_NOT_AVAILABLE:
      napi_throw_error(env, "PROSPERO_NATIVE_NOT_AVAILABLE",
                       "This Windows native capability is not available");
      return nullptr;
    case PROSPERO_STATUS_ACCESS_DENIED:
      napi_throw_error(env, "PROSPERO_NATIVE_ACCESS_DENIED",
                       "Windows native security validation rejected the operation");
      return nullptr;
    case PROSPERO_STATUS_NOT_FOUND:
      napi_throw_error(env, "PROSPERO_NATIVE_NOT_FOUND",
                       "Windows native handle or resource was not found");
      return nullptr;
    case PROSPERO_STATUS_SYSTEM_ERROR:
    default:
      napi_throw_error(env, "PROSPERO_NATIVE_SYSTEM_ERROR",
                       "Windows native operation failed");
      return nullptr;
  }
}

/**
 * N-API argument parsing uses ThrowInvalidArgument above. A valid JS call can
 * still fail inside the native atomic-write pipeline, so report that stage
 * without surfacing the state path, filename, bytes, or raw OS error.
 */
napi_value ThrowSecureStateWriteFailure(
    napi_env env,
    prospero_secure_state_write_stage stage) {
  const char* code = "PROSPERO_NATIVE_SECURE_STATE_WRITE_UNKNOWN";
  const char* message = "Secure-state atomic write failed during a native operation";
  switch (stage) {
    case PROSPERO_SECURE_STATE_WRITE_STAGE_VALIDATE:
      code = "PROSPERO_NATIVE_SECURE_STATE_WRITE_VALIDATE";
      message = "Secure-state atomic write native validation rejected an invalid argument";
      break;
    case PROSPERO_SECURE_STATE_WRITE_STAGE_DIRECTORY:
      code = "PROSPERO_NATIVE_SECURE_STATE_WRITE_DIRECTORY";
      message = "Secure-state atomic write failed while resolving its native directory handle";
      break;
    case PROSPERO_SECURE_STATE_WRITE_STAGE_TARGET:
      code = "PROSPERO_NATIVE_SECURE_STATE_WRITE_TARGET";
      message = "Secure-state atomic write failed while validating its existing target";
      break;
    case PROSPERO_SECURE_STATE_WRITE_STAGE_CREATE_TEMPORARY:
      code = "PROSPERO_NATIVE_SECURE_STATE_WRITE_CREATE_TEMPORARY";
      message = "Secure-state atomic write failed while creating its temporary file";
      break;
    case PROSPERO_SECURE_STATE_WRITE_STAGE_VERIFY_TEMPORARY:
      code = "PROSPERO_NATIVE_SECURE_STATE_WRITE_VERIFY_TEMPORARY";
      message = "Secure-state atomic write failed while validating temporary-file security";
      break;
    case PROSPERO_SECURE_STATE_WRITE_STAGE_WRITE:
      code = "PROSPERO_NATIVE_SECURE_STATE_WRITE_WRITE";
      message = "Secure-state atomic write failed while writing its temporary file";
      break;
    case PROSPERO_SECURE_STATE_WRITE_STAGE_FLUSH:
      code = "PROSPERO_NATIVE_SECURE_STATE_WRITE_FLUSH";
      message = "Secure-state atomic write failed while flushing its temporary file";
      break;
    case PROSPERO_SECURE_STATE_WRITE_STAGE_RENAME:
      code = "PROSPERO_NATIVE_SECURE_STATE_WRITE_RENAME";
      message = "Secure-state atomic write failed during native atomic rename";
      break;
    case PROSPERO_SECURE_STATE_WRITE_STAGE_CLEANUP:
      code = "PROSPERO_NATIVE_SECURE_STATE_WRITE_CLEANUP";
      message = "Secure-state atomic write failed while cleaning up its temporary file";
      break;
    case PROSPERO_SECURE_STATE_WRITE_STAGE_NONE:
    default:
      break;
  }
  napi_throw_error(env, code, message);
  return nullptr;
}

bool GetArguments(napi_env env,
                  napi_callback_info info,
                  size_t maximum,
                  napi_value* argv,
                  size_t* argc) {
  *argc = maximum;
  return napi_get_cb_info(env, info, argc, argv, nullptr, nullptr) == napi_ok;
}

bool IsObject(napi_env env, napi_value value) {
  napi_valuetype type = napi_undefined;
  return napi_typeof(env, value, &type) == napi_ok && type == napi_object;
}

bool GetNamed(napi_env env, napi_value object, const char* name, napi_value* out) {
  bool present = false;
  return napi_has_named_property(env, object, name, &present) == napi_ok && present &&
         napi_get_named_property(env, object, name, out) == napi_ok;
}

/** Reject legacy/caller-selected security inputs instead of silently ignoring them. */
#if defined(_WIN32)
bool DoesNotHaveNamed(napi_env env, napi_value object, const char* name) {
  bool present = false;
  return napi_has_named_property(env, object, name, &present) == napi_ok && !present;
}
#endif

// char16_t and wchar_t are distinct C++ types even on Windows, where both use
// UTF-16 code units. Do not type-pun one buffer as the other: Release builds
// may optimize that undefined behavior and corrupt CreateProcessW arguments.
bool CopyUtf16CodeUnitsToWide(const char16_t* code_units,
                               size_t length,
                               std::wstring* out) {
  if (code_units == nullptr || out == nullptr) return false;
  try {
    std::wstring converted;
    converted.reserve(length);
    for (size_t index = 0; index < length; ++index) {
      // Preserve every UTF-16 code unit, including a valid surrogate pair or
      // an unpaired surrogate that JavaScript can represent in a string.
      converted.push_back(static_cast<wchar_t>(code_units[index]));
    }
    *out = std::move(converted);
    return true;
  } catch (...) {
    return false;
  }
}

bool GetUtf16(napi_env env, napi_value value, std::wstring* out) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  try {
    size_t length = 0;
    if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok) return false;
    std::vector<char16_t> storage(length + 1);
    if (napi_get_value_string_utf16(env, value, storage.data(), storage.size(), &length) != napi_ok) {
      return false;
    }
    if (!CopyUtf16CodeUnitsToWide(storage.data(), length, out)) return false;
    return out->find(L'\0') == std::wstring::npos;
  } catch (...) {
    return false;
  }
}

bool GetUtf8(napi_env env, napi_value value, std::string* out) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  try {
    size_t length = 0;
    if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return false;
    std::vector<char> storage(length + 1);
    if (napi_get_value_string_utf8(env, value, storage.data(), storage.size(), &length) != napi_ok) {
      return false;
    }
    out->assign(storage.data(), length);
    return out->find('\0') == std::string::npos;
  } catch (...) {
    return false;
  }
}

bool GetUint32(napi_env env, napi_value value, uint32_t* out) {
  napi_valuetype type = napi_undefined;
  double numeric = 0;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number ||
      napi_get_value_double(env, value, &numeric) != napi_ok || numeric < 0 ||
      numeric > std::numeric_limits<uint32_t>::max() || numeric != static_cast<uint32_t>(numeric)) {
    return false;
  }
  *out = static_cast<uint32_t>(numeric);
  return true;
}

bool GetUint64Handle(napi_env env, napi_value value, uint64_t* out) {
  napi_valuetype type = napi_undefined;
  bool lossless = false;
  return napi_typeof(env, value, &type) == napi_ok && type == napi_bigint &&
         napi_get_value_bigint_uint64(env, value, out, &lossless) == napi_ok && lossless && *out != 0;
}

bool GetUint8Array(napi_env env,
                   napi_value value,
                   uint8_t** data,
                   uint32_t* length,
                   bool require_nonempty) {
  napi_typedarray_type type = napi_int8_array;
  size_t element_count = 0;
  void* raw_data = nullptr;
  napi_value array_buffer = nullptr;
  size_t byte_offset = 0;
  if (napi_get_typedarray_info(env, value, &type, &element_count, &raw_data,
                               &array_buffer, &byte_offset) != napi_ok ||
      type != napi_uint8_array || element_count > std::numeric_limits<uint32_t>::max() ||
      (require_nonempty && element_count == 0)) {
    return false;
  }
  *data = static_cast<uint8_t*>(raw_data);
  *length = static_cast<uint32_t>(element_count);
  return true;
}

bool SetUint32(napi_env env, napi_value object, const char* name, uint32_t value) {
  napi_value js_value = nullptr;
  return napi_create_uint32(env, value, &js_value) == napi_ok &&
         napi_set_named_property(env, object, name, js_value) == napi_ok;
}

bool SetBool(napi_env env, napi_value object, const char* name, bool value) {
  napi_value js_value = nullptr;
  return napi_get_boolean(env, value, &js_value) == napi_ok &&
         napi_set_named_property(env, object, name, js_value) == napi_ok;
}

bool SetString(napi_env env, napi_value object, const char* name, const char* value) {
  napi_value js_value = nullptr;
  return napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &js_value) == napi_ok &&
         napi_set_named_property(env, object, name, js_value) == napi_ok;
}

bool CreateJsUtf16StringFromWide(napi_env env,
                                 const wchar_t* value,
                                 napi_value* out_value) {
  if (value == nullptr || out_value == nullptr) return false;
  try {
    std::u16string code_units;
    for (const wchar_t* cursor = value; *cursor != L'\0'; ++cursor) {
      const uint32_t value_unit = static_cast<uint32_t>(*cursor);
      if (value_unit <= 0xffff) {
        code_units.push_back(static_cast<char16_t>(value_unit));
      } else if (value_unit <= 0x10ffff) {
        const uint32_t supplementary = value_unit - 0x10000;
        code_units.push_back(static_cast<char16_t>(0xd800 + (supplementary >> 10)));
        code_units.push_back(static_cast<char16_t>(0xdc00 + (supplementary & 0x3ff)));
      } else {
        return false;
      }
    }
    const char16_t* data = code_units.empty() ? u"" : code_units.data();
    return napi_create_string_utf16(env, data, code_units.size(), out_value) == napi_ok;
  } catch (...) {
    return false;
  }
}

bool SetWideString(napi_env env, napi_value object, const char* name, const wchar_t* value) {
  napi_value js_value = nullptr;
  return value != nullptr &&
         CreateJsUtf16StringFromWide(env, value, &js_value) &&
         napi_set_named_property(env, object, name, js_value) == napi_ok;
}

napi_value ReturnUndefined(napi_env env) {
  napi_value value = nullptr;
  return napi_get_undefined(env, &value) == napi_ok ? value : nullptr;
}

bool ParseFileTime(const std::string& value, uint64_t* out) {
  if (value.empty()) return false;
  uint64_t parsed = 0;
  for (const char character : value) {
    if (character < '0' || character > '9' ||
        parsed > (std::numeric_limits<uint64_t>::max() - (character - '0')) / 10) {
      return false;
    }
    parsed = parsed * 10 + static_cast<uint64_t>(character - '0');
  }
  *out = parsed;
  return parsed != 0;
}

bool GetProcessIdentity(napi_env env, napi_value value, prospero_process_identity* identity) {
  if (!IsObject(env, value)) return false;
  napi_value pid_value = nullptr;
  napi_value creation_time_value = nullptr;
  uint32_t pid = 0;
  std::string creation_time;
  if (!GetNamed(env, value, "pid", &pid_value) || !GetUint32(env, pid_value, &pid) || pid == 0 ||
      !GetNamed(env, value, "creationTime100ns", &creation_time_value) ||
      !GetUtf8(env, creation_time_value, &creation_time) ||
      !ParseFileTime(creation_time, &identity->creation_time_100ns)) {
    return false;
  }
  identity->pid = pid;
  return true;
}

napi_value MakeProcessIdentity(napi_env env, const prospero_process_identity& identity) {
  try {
    napi_value object = nullptr;
    napi_value creation_time = nullptr;
    const std::string value = std::to_string(identity.creation_time_100ns);
    if (napi_create_object(env, &object) != napi_ok ||
        !SetUint32(env, object, "pid", identity.pid) ||
        napi_create_string_utf8(env, value.c_str(), value.size(), &creation_time) != napi_ok ||
        napi_set_named_property(env, object, "creationTime100ns", creation_time) != napi_ok) {
      return nullptr;
    }
    return object;
  } catch (...) {
    return nullptr;
  }
}

napi_value MakeUint8Array(napi_env env, const uint8_t* data, uint32_t length) {
  void* raw = nullptr;
  napi_value buffer = nullptr;
  napi_value output = nullptr;
  if (napi_create_arraybuffer(env, length, &raw, &buffer) != napi_ok ||
      napi_create_typedarray(env, napi_uint8_array, length, buffer, 0, &output) != napi_ok) {
    return nullptr;
  }
  if (length != 0) memcpy(raw, data, length);
  return output;
}

napi_value MakeOwnedBuffer(napi_env env, prospero_owned_buffer* value) {
  napi_value result = MakeUint8Array(env, value->data, value->length);
  const prospero_status release = prospero_owned_buffer_release(value);
  if (result == nullptr || release != PROSPERO_STATUS_OK) {
    if (result != nullptr) napi_throw_error(env, "PROSPERO_NATIVE_SYSTEM_ERROR",
                                            "Windows native buffer release failed");
    return nullptr;
  }
  return result;
}

#if defined(_WIN32)

bool GetCurrentLogonSid(std::wstring* output) {
  HANDLE token = nullptr;
  LPWSTR string_sid = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  DWORD bytes = 0;
  const BOOL first = GetTokenInformation(token, TokenGroups, nullptr, 0, &bytes);
  if (first || GetLastError() != ERROR_INSUFFICIENT_BUFFER || bytes == 0) {
    CloseHandle(token);
    return false;
  }
  try {
    std::vector<uint8_t> storage(bytes);
    const BOOL read = GetTokenInformation(token, TokenGroups, storage.data(), bytes, &bytes);
    CloseHandle(token);
    token = nullptr;
    if (!read) return false;
    const TOKEN_GROUPS* groups = reinterpret_cast<const TOKEN_GROUPS*>(storage.data());
    for (DWORD index = 0; index < groups->GroupCount; ++index) {
      if ((groups->Groups[index].Attributes & SE_GROUP_LOGON_ID) != SE_GROUP_LOGON_ID) continue;
      if (!ConvertSidToStringSidW(groups->Groups[index].Sid, &string_sid) || string_sid == nullptr) {
        if (string_sid != nullptr) LocalFree(string_sid);
        string_sid = nullptr;
        return false;
      }
      *output = string_sid;
      LocalFree(string_sid);
      string_sid = nullptr;
      return true;
    }
  } catch (...) {
    if (string_sid != nullptr) LocalFree(string_sid);
    if (token != nullptr) CloseHandle(token);
    return false;
  }
  return false;
}

bool IsFullLocalPipeName(const std::wstring& value) {
  static const std::wstring prefix = L"\\\\.\\pipe\\";
  if (value.size() <= prefix.size() || value.size() > prefix.size() + 256 ||
      value.compare(0, prefix.size(), prefix) != 0) {
    return false;
  }
  for (size_t index = prefix.size(); index < value.size(); ++index) {
    const wchar_t character = value[index];
    if (character < 0x20 || character == L'\\' || character == L'/' || character == L':') {
      return false;
    }
  }
  return true;
}

#endif

bool ExportMethod(napi_env env, napi_value exports, const char* name, napi_callback callback) {
  napi_value function = nullptr;
  return napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, nullptr, &function) == napi_ok &&
         napi_set_named_property(env, exports, name, function) == napi_ok;
}

napi_value GetAbiInfo(napi_env env, napi_callback_info info) {
  (void)info;
  prospero_capability_report native_report;
  if (prospero_query_capability_report(&native_report) != PROSPERO_STATUS_OK) {
    napi_throw_error(env, "PROSPERO_NATIVE_INTERNAL", "Could not query native ABI report");
    return nullptr;
  }
  napi_value report = nullptr;
  napi_value capabilities = nullptr;
  if (napi_create_object(env, &report) != napi_ok || napi_create_object(env, &capabilities) != napi_ok) {
    return nullptr;
  }
  // The addon merely reports native code that is present. It deliberately has
  // no signature/hash claim: the JavaScript loader creates that trust fact
  // after it validates the exact prebuilt artifact.
  if (!SetUint32(env, report, "abiVersion", native_report.abi_version) ||
      !SetUint32(env, report, "napiVersion", native_report.napi_version) ||
      !SetString(env, report, "platform", "win32") ||
#if defined(_M_ARM64) || defined(__aarch64__)
      !SetString(env, report, "arch", "arm64") ||
#else
      !SetString(env, report, "arch", "x64") ||
#endif
      !SetString(env, report, "buildId", "win32-native-v3") ||
      !SetBool(env, capabilities, "processIdentity",
               (native_report.capability_mask & PROSPERO_CAPABILITY_PROCESS_IDENTITY) != 0) ||
      !SetBool(env, capabilities, "secureNamedPipe",
               (native_report.capability_mask & PROSPERO_CAPABILITY_SECURE_NAMED_PIPE) != 0) ||
      !SetBool(env, capabilities, "jobObject",
               (native_report.capability_mask & PROSPERO_CAPABILITY_JOB_OBJECT) != 0) ||
      !SetBool(env, capabilities, "parentJobCompatibility",
               (native_report.capability_mask & PROSPERO_CAPABILITY_PARENT_JOB_COMPATIBILITY) != 0) ||
      !SetBool(env, capabilities, "detachedHost",
               (native_report.capability_mask & PROSPERO_CAPABILITY_DETACHED_HOST) != 0) ||
      !SetBool(env, capabilities, "conPty",
               (native_report.capability_mask & PROSPERO_CAPABILITY_CONPTY) != 0) ||
      !SetBool(env, capabilities, "dpapiCurrentUser",
               (native_report.capability_mask & PROSPERO_CAPABILITY_DPAPI_CURRENT_USER) != 0) ||
      !SetBool(env, capabilities, "secureStateDirectory",
               (native_report.capability_mask & PROSPERO_CAPABILITY_SECURE_STATE_DIRECTORY) != 0) ||
      napi_set_named_property(env, report, "capabilities", capabilities) != napi_ok) {
    return nullptr;
  }
  return report;
}

napi_value GetCurrentProcessIdentity(napi_env env, napi_callback_info info) {
  (void)info;
  prospero_process_identity identity{};
  const prospero_status status = prospero_get_current_process_identity(&identity);
  if (status != PROSPERO_STATUS_OK) return ThrowStatus(env, status);
  return MakeProcessIdentity(env, identity);
}

napi_value GetProcessIdentityForPid(napi_env env, napi_callback_info info) {
  napi_value argv[1] = {nullptr};
  size_t argc = 0;
  uint32_t pid = 0;
  if (!GetArguments(env, info, 1, argv, &argc) || argc != 1 || !GetUint32(env, argv[0], &pid) || pid == 0) {
    return ThrowInvalidArgument(env);
  }
  prospero_process_identity identity{};
  const prospero_status status = prospero_get_process_identity(pid, &identity);
  if (status != PROSPERO_STATUS_OK) return ThrowStatus(env, status);
  return MakeProcessIdentity(env, identity);
}

napi_value MatchesProcessIdentity(napi_env env, napi_callback_info info) {
  napi_value argv[1] = {nullptr};
  size_t argc = 0;
  prospero_process_identity identity{};
  if (!GetArguments(env, info, 1, argv, &argc) || argc != 1 ||
      !GetProcessIdentity(env, argv[0], &identity)) {
    return ThrowInvalidArgument(env);
  }
  uint8_t matches = 0;
  const prospero_status status = prospero_process_identity_matches(identity, &matches);
  if (status != PROSPERO_STATUS_OK) return ThrowStatus(env, status);
  napi_value result = nullptr;
  return napi_get_boolean(env, matches != 0, &result) == napi_ok ? result : nullptr;
}

napi_value CreateSecureNamedPipeServer(napi_env env, napi_callback_info info) {
#if !defined(_WIN32)
  return ThrowNotAvailable(env, info);
#else
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  try {
  napi_value argv[1] = {nullptr};
  size_t argc = 0;
  napi_value pipe_name_value = nullptr;
  napi_value max_instances_value = nullptr;
  napi_value inbound_value = nullptr;
  napi_value outbound_value = nullptr;
  std::wstring pipe_name;
  uint32_t max_instances = 0;
  uint32_t inbound = 0;
  uint32_t outbound = 0;
  if (!GetArguments(env, info, 1, argv, &argc) || argc != 1 || !IsObject(env, argv[0]) ||
      !GetNamed(env, argv[0], "pipeName", &pipe_name_value) ||
      !GetUtf16(env, pipe_name_value, &pipe_name) || !IsFullLocalPipeName(pipe_name) ||
      !DoesNotHaveNamed(env, argv[0], "allowedUserSid") ||
      !GetNamed(env, argv[0], "maxInstances", &max_instances_value) ||
      !GetUint32(env, max_instances_value, &max_instances) || max_instances == 0 ||
      !GetNamed(env, argv[0], "inboundBufferBytes", &inbound_value) ||
      !GetUint32(env, inbound_value, &inbound) ||
      !GetNamed(env, argv[0], "outboundBufferBytes", &outbound_value) ||
      !GetUint32(env, outbound_value, &outbound)) {
    return ThrowInvalidArgument(env);
  }
  std::wstring logon_sid;
  if (!GetCurrentLogonSid(&logon_sid)) {
    napi_throw_error(env, "PROSPERO_NATIVE_ACCESS_DENIED",
                     "Could not obtain the current logon SID for pipe security");
    return nullptr;
  }
  const std::wstring sddl = L"D:P(A;;GA;;;" + logon_sid + L")";
  DWORD descriptor_bytes = 0;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
          sddl.c_str(), SDDL_REVISION_1, &descriptor, &descriptor_bytes) || descriptor == nullptr ||
      descriptor_bytes == 0) {
    if (descriptor != nullptr) LocalFree(descriptor);
    return ThrowStatus(env, PROSPERO_STATUS_SYSTEM_ERROR);
  }
  prospero_secure_pipe_server_options options{};
  options.pipe_name = pipe_name.c_str();
  options.security.self_relative_security_descriptor = descriptor;
  options.security.security_descriptor_bytes = descriptor_bytes;
  options.security.reserved_legacy_allowed_user_sid = nullptr;
  options.max_instances = max_instances;
  options.inbound_buffer_bytes = inbound;
  options.outbound_buffer_bytes = outbound;
  prospero_secure_pipe_server_handle server = 0;
  const prospero_status status = prospero_secure_pipe_server_create(&options, &server);
  LocalFree(descriptor);
  descriptor = nullptr;
  if (status != PROSPERO_STATUS_OK) return ThrowStatus(env, status);
  napi_value result = nullptr;
  return napi_create_bigint_uint64(env, server, &result) == napi_ok ? result : nullptr;
  } catch (...) {
    if (descriptor != nullptr) LocalFree(descriptor);
    return ThrowStatus(env, PROSPERO_STATUS_SYSTEM_ERROR);
  }
#endif
}

napi_value AcceptSecureNamedPipeConnection(napi_env env, napi_callback_info info) {
  napi_value argv[1] = {nullptr};
  size_t argc = 0;
  uint64_t server = 0;
  if (!GetArguments(env, info, 1, argv, &argc) || argc != 1 ||
      !GetUint64Handle(env, argv[0], &server)) {
    return ThrowInvalidArgument(env);
  }
  prospero_secure_pipe_connection_handle connection = 0;
  const prospero_status status = prospero_secure_pipe_server_accept(server, &connection);
  if (status != PROSPERO_STATUS_OK) return ThrowStatus(env, status);
  napi_value result = nullptr;
  return napi_create_bigint_uint64(env, connection, &result) == napi_ok ? result : nullptr;
}

napi_value CloseSecureNamedPipeServer(napi_env env, napi_callback_info info) {
  napi_value argv[1] = {nullptr};
  size_t argc = 0;
  uint64_t server = 0;
  if (!GetArguments(env, info, 1, argv, &argc) || argc != 1 ||
      !GetUint64Handle(env, argv[0], &server)) {
    return ThrowInvalidArgument(env);
  }
  const prospero_status status = prospero_secure_pipe_server_close(server);
  return status == PROSPERO_STATUS_OK ? ReturnUndefined(env) : ThrowStatus(env, status);
}

napi_value ReadSecureNamedPipeConnection(napi_env env, napi_callback_info info) {
  napi_value argv[2] = {nullptr};
  size_t argc = 0;
  uint64_t connection = 0;
  uint32_t maximum = 0;
  if (!GetArguments(env, info, 2, argv, &argc) || argc != 2 ||
      !GetUint64Handle(env, argv[0], &connection) || !GetUint32(env, argv[1], &maximum) ||
      maximum == 0 || maximum > kMaximumPipeIoBytes) {
    return ThrowInvalidArgument(env);
  }
  try {
    std::vector<uint8_t> data(maximum);
    uint32_t read = 0;
    const prospero_status status = prospero_secure_pipe_connection_read(
        connection, data.data(), maximum, &read);
    if (status != PROSPERO_STATUS_OK) return ThrowStatus(env, status);
    return MakeUint8Array(env, data.data(), read);
  } catch (...) {
    return ThrowStatus(env, PROSPERO_STATUS_SYSTEM_ERROR);
  }
}

napi_value WriteSecureNamedPipeConnection(napi_env env, napi_callback_info info) {
  napi_value argv[2] = {nullptr};
  size_t argc = 0;
  uint64_t connection = 0;
  uint8_t* data = nullptr;
  uint32_t length = 0;
  if (!GetArguments(env, info, 2, argv, &argc) || argc != 2 ||
      !GetUint64Handle(env, argv[0], &connection) ||
      !GetUint8Array(env, argv[1], &data, &length, true) || length > kMaximumPipeIoBytes) {
    return ThrowInvalidArgument(env);
  }
  uint32_t written = 0;
  const prospero_status status = prospero_secure_pipe_connection_write(
      connection, data, length, &written);
  if (status != PROSPERO_STATUS_OK) return ThrowStatus(env, status);
  napi_value result = nullptr;
  return napi_create_uint32(env, written, &result) == napi_ok ? result : nullptr;
}

napi_value GetSecureNamedPipePeerIdentity(napi_env env, napi_callback_info info) {
  napi_value argv[1] = {nullptr};
  size_t argc = 0;
  uint64_t connection = 0;
  if (!GetArguments(env, info, 1, argv, &argc) || argc != 1 ||
      !GetUint64Handle(env, argv[0], &connection)) {
    return ThrowInvalidArgument(env);
  }
  prospero_pipe_peer_identity peer{};
  const prospero_status status = prospero_secure_pipe_connection_peer_identity(connection, &peer);
  if (status != PROSPERO_STATUS_OK) return ThrowStatus(env, status);
  // The C ABI returns a thread-local view so it can never retain endpoint
  // ownership. Copy it before any later N-API operation can re-enter native
  // code on this thread.
  std::wstring peer_sid;
  try {
    if (peer.user_sid == nullptr) return ThrowStatus(env, PROSPERO_STATUS_SYSTEM_ERROR);
    peer_sid.assign(peer.user_sid);
  } catch (...) {
    return ThrowStatus(env, PROSPERO_STATUS_SYSTEM_ERROR);
  }
  napi_value result = nullptr;
  napi_value process = MakeProcessIdentity(env, peer.process);
  if (process == nullptr || napi_create_object(env, &result) != napi_ok ||
      napi_set_named_property(env, result, "process", process) != napi_ok ||
      !SetWideString(env, result, "userSid", peer_sid.c_str()) ||
      !SetUint32(env, result, "sessionId", peer.session_id)) {
    return nullptr;
  }
  return result;
}

napi_value DisconnectSecureNamedPipeConnection(napi_env env, napi_callback_info info) {
  napi_value argv[1] = {nullptr};
  size_t argc = 0;
  uint64_t connection = 0;
  if (!GetArguments(env, info, 1, argv, &argc) || argc != 1 ||
      !GetUint64Handle(env, argv[0], &connection)) {
    return ThrowInvalidArgument(env);
  }
  const prospero_status status = prospero_secure_pipe_connection_disconnect(connection);
  return status == PROSPERO_STATUS_OK ? ReturnUndefined(env) : ThrowStatus(env, status);
}

napi_value CloseSecureNamedPipeConnection(napi_env env, napi_callback_info info) {
  napi_value argv[1] = {nullptr};
  size_t argc = 0;
  uint64_t connection = 0;
  if (!GetArguments(env, info, 1, argv, &argc) || argc != 1 ||
      !GetUint64Handle(env, argv[0], &connection)) {
    return ThrowInvalidArgument(env);
  }
  const prospero_status status = prospero_secure_pipe_connection_close(connection);
  return status == PROSPERO_STATUS_OK ? ReturnUndefined(env) : ThrowStatus(env, status);
}

napi_value DpapiProtectCurrentUser(napi_env env, napi_callback_info info) {
  napi_value argv[2] = {nullptr};
  size_t argc = 0;
  uint8_t* plaintext = nullptr;
  uint8_t* entropy = nullptr;
  uint32_t plaintext_length = 0;
  uint32_t entropy_length = 0;
  // A durable session's entropy is an opaque UTF-8/bytes encoding of its
  // session ID and lifecycle epoch. It never enters argv, environment, logs,
  // errors, or state metadata; only DPAPI sees it as optional entropy.
  if (!GetArguments(env, info, 2, argv, &argc) || argc != 2 ||
      !GetUint8Array(env, argv[0], &plaintext, &plaintext_length, true) ||
      !GetUint8Array(env, argv[1], &entropy, &entropy_length, true)) {
    return ThrowInvalidArgument(env);
  }
  prospero_owned_buffer ciphertext{};
  const prospero_status status = prospero_dpapi_current_user_protect(
      plaintext, plaintext_length, entropy, entropy_length, &ciphertext);
  if (status != PROSPERO_STATUS_OK) return ThrowStatus(env, status);
  return MakeOwnedBuffer(env, &ciphertext);
}

napi_value DpapiUnprotectCurrentUser(napi_env env, napi_callback_info info) {
  napi_value argv[2] = {nullptr};
  size_t argc = 0;
  uint8_t* ciphertext = nullptr;
  uint8_t* entropy = nullptr;
  uint32_t ciphertext_length = 0;
  uint32_t entropy_length = 0;
  if (!GetArguments(env, info, 2, argv, &argc) || argc != 2 ||
      !GetUint8Array(env, argv[0], &ciphertext, &ciphertext_length, true) ||
      !GetUint8Array(env, argv[1], &entropy, &entropy_length, true)) {
    return ThrowInvalidArgument(env);
  }
  prospero_owned_buffer plaintext{};
  const prospero_status status = prospero_dpapi_current_user_unprotect(
      ciphertext, ciphertext_length, entropy, entropy_length, &plaintext);
  if (status != PROSPERO_STATUS_OK) return ThrowStatus(env, status);
  return MakeOwnedBuffer(env, &plaintext);
}

napi_value OpenSecureStateDirectory(napi_env env, napi_callback_info info) {
  napi_value argv[1] = {nullptr};
  size_t argc = 0;
  napi_value path_value = nullptr;
  std::wstring path;
  if (!GetArguments(env, info, 1, argv, &argc) || argc != 1 || !IsObject(env, argv[0]) ||
      !GetNamed(env, argv[0], "path", &path_value) || !GetUtf16(env, path_value, &path) ||
      path.empty()) {
    return ThrowInvalidArgument(env);
  }
  prospero_secure_state_directory_options options{};
  options.absolute_path = path.c_str();
  prospero_secure_state_directory_handle directory = 0;
  const prospero_status status = prospero_secure_state_directory_open(&options, &directory);
  if (status != PROSPERO_STATUS_OK) return ThrowStatus(env, status);
  napi_value result = nullptr;
  return napi_create_bigint_uint64(env, directory, &result) == napi_ok ? result : nullptr;
}

napi_value WriteSecureStateFileAtomically(napi_env env, napi_callback_info info) {
  napi_value argv[3] = {nullptr};
  size_t argc = 0;
  uint64_t directory = 0;
  std::wstring file_name;
  uint8_t* data = nullptr;
  uint32_t length = 0;
  if (!GetArguments(env, info, 3, argv, &argc) || argc != 3 ||
      !GetUint64Handle(env, argv[0], &directory) || !GetUtf16(env, argv[1], &file_name) ||
      !GetUint8Array(env, argv[2], &data, &length, true)) {
    return ThrowInvalidArgument(env);
  }
  const prospero_status status = prospero_secure_state_directory_write_atomic(
      directory, file_name.c_str(), data, length);
  return status == PROSPERO_STATUS_OK
             ? ReturnUndefined(env)
             : ThrowSecureStateWriteFailure(
                   env, prospero_secure_state_directory_last_write_stage());
}

napi_value ReadSecureStateFile(napi_env env, napi_callback_info info) {
  napi_value argv[2] = {nullptr};
  size_t argc = 0;
  uint64_t directory = 0;
  std::wstring file_name;
  if (!GetArguments(env, info, 2, argv, &argc) || argc != 2 ||
      !GetUint64Handle(env, argv[0], &directory) || !GetUtf16(env, argv[1], &file_name)) {
    return ThrowInvalidArgument(env);
  }
  prospero_owned_buffer data{};
  const prospero_status status = prospero_secure_state_directory_read(
      directory, file_name.c_str(), &data);
  if (status != PROSPERO_STATUS_OK) return ThrowStatus(env, status);
  return MakeOwnedBuffer(env, &data);
}

napi_value ListSecureStateEntries(napi_env env, napi_callback_info info) {
  napi_value argv[1] = {nullptr};
  size_t argc = 0;
  uint64_t directory = 0;
  if (!GetArguments(env, info, 1, argv, &argc) || argc != 1 ||
      !GetUint64Handle(env, argv[0], &directory)) {
    return ThrowInvalidArgument(env);
  }
  prospero_secure_state_entry_list entries{};
  const prospero_status status = prospero_secure_state_directory_list(directory, &entries);
  if (status != PROSPERO_STATUS_OK) return ThrowStatus(env, status);
  napi_value result = nullptr;
  if (napi_create_array_with_length(env, entries.count, &result) != napi_ok) {
    prospero_secure_state_entry_list_release(&entries);
    return nullptr;
  }
  for (uint32_t index = 0; index < entries.count; ++index) {
    napi_value value = nullptr;
    if (!CreateJsUtf16StringFromWide(env, entries.entries[index], &value) ||
        napi_set_element(env, result, index, value) != napi_ok) {
      prospero_secure_state_entry_list_release(&entries);
      return nullptr;
    }
  }
  prospero_secure_state_entry_list_release(&entries);
  return result;
}

napi_value RemoveSecureStateFile(napi_env env, napi_callback_info info) {
  napi_value argv[2] = {nullptr};
  size_t argc = 0;
  uint64_t directory = 0;
  std::wstring file_name;
  if (!GetArguments(env, info, 2, argv, &argc) || argc != 2 ||
      !GetUint64Handle(env, argv[0], &directory) || !GetUtf16(env, argv[1], &file_name)) {
    return ThrowInvalidArgument(env);
  }
  const prospero_status status = prospero_secure_state_directory_remove(
      directory, file_name.c_str());
  return status == PROSPERO_STATUS_OK ? ReturnUndefined(env) : ThrowStatus(env, status);
}

napi_value CloseSecureStateDirectory(napi_env env, napi_callback_info info) {
  napi_value argv[1] = {nullptr};
  size_t argc = 0;
  uint64_t directory = 0;
  if (!GetArguments(env, info, 1, argv, &argc) || argc != 1 ||
      !GetUint64Handle(env, argv[0], &directory)) {
    return ThrowInvalidArgument(env);
  }
  const prospero_status status = prospero_secure_state_directory_close(directory);
  return status == PROSPERO_STATUS_OK ? ReturnUndefined(env) : ThrowStatus(env, status);
}

namespace process_terminal {

#if defined(_WIN32)

void ThrowStatus(napi_env env, prospero_status status, const char* operation) {
  const char* code = "PROSPERO_NATIVE_SYSTEM_ERROR";
  const char* detail = "Windows native operation failed";
  switch (status) {
    case PROSPERO_STATUS_INVALID_ARGUMENT:
      code = "PROSPERO_NATIVE_INVALID_ARGUMENT";
      detail = "Windows native operation received invalid arguments";
      break;
    case PROSPERO_STATUS_NOT_AVAILABLE:
      code = "PROSPERO_NATIVE_NOT_AVAILABLE";
      detail = "Windows native operation is unavailable on this system";
      break;
    case PROSPERO_STATUS_ACCESS_DENIED:
      code = "PROSPERO_NATIVE_ACCESS_DENIED";
      detail = "Windows denied the native operation";
      break;
    case PROSPERO_STATUS_NOT_FOUND:
      code = "PROSPERO_NATIVE_NOT_FOUND";
      detail = "Windows native handle or process was not found";
      break;
    case PROSPERO_STATUS_SYSTEM_ERROR:
      break;
    case PROSPERO_STATUS_OK:
      return;
  }
  std::string message(operation);
  message.append(": ");
  message.append(detail);
  napi_throw_error(env, code, message.c_str());
}

void ThrowTypeError(napi_env env, const char* message) {
  napi_throw_type_error(env, "PROSPERO_NATIVE_INVALID_ARGUMENT", message);
}

bool GetArguments(
    napi_env env,
    napi_callback_info info,
    size_t max_count,
    size_t* out_count,
    napi_value* out_values) {
  size_t count = max_count;
  if (napi_get_cb_info(env, info, &count, out_values, nullptr, nullptr) != napi_ok) return false;
  *out_count = count;
  return true;
}

bool IsObject(napi_env env, napi_value value) {
  napi_valuetype type;
  return napi_typeof(env, value, &type) == napi_ok && type == napi_object;
}

bool GetRequiredObjectArgument(
    napi_env env,
    napi_callback_info info,
    napi_value* out_options) {
  napi_value arguments[1] = {nullptr};
  size_t count = 0;
  if (!GetArguments(env, info, 1, &count, arguments) || count != 1 ||
      !IsObject(env, arguments[0])) {
    ThrowTypeError(env, "expected one options object");
    return false;
  }
  *out_options = arguments[0];
  return true;
}

bool GetNamedProperty(
    napi_env env,
    napi_value object,
    const char* name,
    napi_value* out_value,
    bool* out_present) {
  if (out_value == nullptr) return false;
  *out_value = nullptr;
  if (out_present != nullptr) *out_present = false;
  bool present = false;
  if (napi_has_named_property(env, object, name, &present) != napi_ok) return false;
  if (!present) return true;
  napi_value value = nullptr;
  if (napi_get_named_property(env, object, name, &value) != napi_ok || value == nullptr) return false;
  *out_value = value;
  if (out_present != nullptr) *out_present = true;
  return true;
}

bool GetUtf16String(napi_env env, napi_value value, std::wstring* out_value) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) {
    ThrowTypeError(env, "expected a string");
    return false;
  }
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok) return false;
  std::vector<char16_t> buffer(length + 1);
  if (napi_get_value_string_utf16(env, value, buffer.data(), buffer.size(), &length) != napi_ok) {
    return false;
  }
  if (!CopyUtf16CodeUnitsToWide(buffer.data(), length, out_value)) return false;
  if (out_value->find(L'\0') != std::wstring::npos) {
    ThrowTypeError(env, "embedded NUL is not allowed in a Windows path or argument");
    return false;
  }
  return true;
}

bool GetRequiredStringProperty(
    napi_env env,
    napi_value object,
    const char* name,
    std::wstring* out_value) {
  napi_value value = nullptr;
  bool present = false;
  if (!GetNamedProperty(env, object, name, &value, &present) || !present) {
    ThrowTypeError(env, "required string option is missing");
    return false;
  }
  return GetUtf16String(env, value, out_value);
}

bool GetOptionalStringProperty(
    napi_env env,
    napi_value object,
    const char* name,
    std::wstring* out_value,
    bool* out_present) {
  napi_value value = nullptr;
  bool present = false;
  if (!GetNamedProperty(env, object, name, &value, &present)) return false;
  if (!present) {
    *out_present = false;
    return true;
  }
  if (!GetUtf16String(env, value, out_value)) return false;
  *out_present = true;
  return true;
}

bool GetBoolProperty(
    napi_env env,
    napi_value object,
    const char* name,
    bool required,
    bool* out_value,
    bool* out_present = nullptr) {
  napi_value value = nullptr;
  bool present = false;
  if (!GetNamedProperty(env, object, name, &value, &present)) return false;
  if (!present) {
    if (required) ThrowTypeError(env, "required boolean option is missing");
    if (out_present != nullptr) *out_present = false;
    return !required;
  }
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_boolean ||
      napi_get_value_bool(env, value, out_value) != napi_ok) {
    ThrowTypeError(env, "expected a boolean option");
    return false;
  }
  if (out_present != nullptr) *out_present = true;
  return true;
}

bool GetUint32Value(napi_env env, napi_value value, uint32_t* out_value) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number ||
      napi_get_value_uint32(env, value, out_value) != napi_ok) {
    ThrowTypeError(env, "expected an unsigned 32-bit integer");
    return false;
  }
  return true;
}

bool GetUint16Value(napi_env env, napi_value value, uint16_t* out_value) {
  uint32_t number = 0;
  if (!GetUint32Value(env, value, &number)) return false;
  if (number == 0 || number > std::numeric_limits<uint16_t>::max()) {
    ThrowTypeError(env, "expected a non-zero unsigned 16-bit integer");
    return false;
  }
  *out_value = static_cast<uint16_t>(number);
  return true;
}

bool GetOptionalUint32Property(
    napi_env env,
    napi_value object,
    const char* name,
    uint32_t* out_value,
    bool* out_present) {
  napi_value value = nullptr;
  bool present = false;
  if (!GetNamedProperty(env, object, name, &value, &present)) return false;
  if (!present) {
    *out_present = false;
    return true;
  }
  if (!GetUint32Value(env, value, out_value)) return false;
  if (*out_value == 0) {
    ThrowTypeError(env, "expected a non-zero unsigned 32-bit integer");
    return false;
  }
  *out_present = true;
  return true;
}

bool GetStringArrayProperty(
    napi_env env,
    napi_value object,
    const char* name,
    std::vector<std::wstring>* out_values) {
  napi_value value = nullptr;
  bool present = false;
  if (!GetNamedProperty(env, object, name, &value, &present) || !present) {
    ThrowTypeError(env, "required arguments array is missing");
    return false;
  }
  bool is_array = false;
  if (napi_is_array(env, value, &is_array) != napi_ok || !is_array) {
    ThrowTypeError(env, "expected an arguments array");
    return false;
  }
  uint32_t length = 0;
  if (napi_get_array_length(env, value, &length) != napi_ok || length > 4096) {
    ThrowTypeError(env, "arguments array is too large");
    return false;
  }
  out_values->clear();
  out_values->reserve(length);
  for (uint32_t index = 0; index < length; ++index) {
    napi_value element = nullptr;
    if (napi_get_element(env, value, index, &element) != napi_ok) return false;
    std::wstring argument;
    if (!GetUtf16String(env, element, &argument)) return false;
    out_values->push_back(std::move(argument));
  }
  return true;
}

struct EnvironmentBlock {
  std::vector<wchar_t> data;

  const wchar_t* value() const {
    return data.empty() ? nullptr : data.data();
  }
};

bool ContainsInvalidEnvironmentText(const std::wstring& value) {
  return value.find(L'\0') != std::wstring::npos ||
         value.find(L'\r') != std::wstring::npos ||
         value.find(L'\n') != std::wstring::npos;
}

bool BuildEnvironmentBlock(napi_env env, napi_value options, EnvironmentBlock* out_block) {
  napi_value environment = nullptr;
  bool present = false;
  if (!GetNamedProperty(env, options, "environment", &environment, &present)) return false;
  if (!present) {
    out_block->data.clear();
    return true;
  }
  if (!IsObject(env, environment)) {
    ThrowTypeError(env, "environment must be an object of string values");
    return false;
  }
  napi_value keys = nullptr;
  if (napi_get_property_names(env, environment, &keys) != napi_ok) return false;
  uint32_t key_count = 0;
  if (napi_get_array_length(env, keys, &key_count) != napi_ok || key_count > 4096) {
    ThrowTypeError(env, "environment has too many entries");
    return false;
  }
  struct EnvironmentEntry {
    std::wstring key;
    std::wstring value;
  };
  std::vector<EnvironmentEntry> entries;
  entries.reserve(key_count);
  for (uint32_t index = 0; index < key_count; ++index) {
    napi_value key_value = nullptr;
    napi_value value = nullptr;
    if (napi_get_element(env, keys, index, &key_value) != napi_ok ||
        napi_get_property(env, environment, key_value, &value) != napi_ok) {
      return false;
    }
    std::wstring key;
    std::wstring string_value;
    if (!GetUtf16String(env, key_value, &key) || !GetUtf16String(env, value, &string_value)) {
      return false;
    }
    if (key.empty() || key.find(L'=') != std::wstring::npos ||
        ContainsInvalidEnvironmentText(key) || ContainsInvalidEnvironmentText(string_value)) {
      ThrowTypeError(env, "environment keys and values must be newline- and NUL-free strings");
      return false;
    }
    entries.push_back({std::move(key), std::move(string_value)});
  }
  std::sort(entries.begin(), entries.end(), [](const EnvironmentEntry& left,
                                                const EnvironmentEntry& right) {
    return CompareStringOrdinal(left.key.c_str(),
                                -1,
                                right.key.c_str(),
                                -1,
                                TRUE) == CSTR_LESS_THAN;
  });
  for (size_t index = 1; index < entries.size(); ++index) {
    if (CompareStringOrdinal(entries[index - 1].key.c_str(),
                             -1,
                             entries[index].key.c_str(),
                             -1,
                             TRUE) == CSTR_EQUAL) {
      ThrowTypeError(env, "environment keys must be unique without regard to case");
      return false;
    }
  }

  size_t environment_code_units = entries.empty() ? 2 : 1;
  for (const EnvironmentEntry& entry : entries) {
    if (entry.key.size() > kMaxCreateProcessEnvironmentCodeUnits - environment_code_units ||
        entry.value.size() > kMaxCreateProcessEnvironmentCodeUnits -
                                 environment_code_units - entry.key.size() ||
        kMaxCreateProcessEnvironmentCodeUnits - environment_code_units -
                entry.key.size() - entry.value.size() < 2) {
      ThrowTypeError(env, "environment block exceeds the CreateProcessW UTF-16 limit");
      return false;
    }
    environment_code_units += entry.key.size() + entry.value.size() + 2;
  }
  if (environment_code_units > kMaxCreateProcessEnvironmentCodeUnits) {
    ThrowTypeError(env, "environment block exceeds the CreateProcessW UTF-16 limit");
    return false;
  }

  out_block->data.clear();
  if (entries.empty()) {
    // CreateProcessW specifies a double-NUL terminator even for an explicitly
    // empty environment block. Keep both NULs in the owned vector so value()
    // can never turn an explicit empty object into inherited environment.
    out_block->data.assign(2, L'\0');
    return true;
  }
  out_block->data.reserve(environment_code_units);
  for (const EnvironmentEntry& entry : entries) {
    out_block->data.insert(out_block->data.end(), entry.key.begin(), entry.key.end());
    out_block->data.push_back(L'=');
    out_block->data.insert(out_block->data.end(), entry.value.begin(), entry.value.end());
    out_block->data.push_back(L'\0');
  }
  out_block->data.push_back(L'\0');
  return true;
}

class NativeHandleRegistry {
 public:
  uint64_t StoreJob(prospero_job_object_handle raw_handle) {
    std::lock_guard<std::mutex> lock(mutex_);
    const uint64_t token = NextTokenLocked();
    jobs_.emplace(token, raw_handle);
    return token;
  }

  uint64_t StoreConPty(prospero_conpty_handle raw_handle) {
    std::lock_guard<std::mutex> lock(mutex_);
    const uint64_t token = NextTokenLocked();
    terminals_.emplace(token, raw_handle);
    return token;
  }

  bool GetJob(uint64_t token, prospero_job_object_handle* out_handle) {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto found = jobs_.find(token);
    if (found == jobs_.end()) return false;
    *out_handle = found->second;
    return true;
  }

  bool TakeJob(uint64_t token, prospero_job_object_handle* out_handle) {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto found = jobs_.find(token);
    if (found == jobs_.end()) return false;
    *out_handle = found->second;
    jobs_.erase(found);
    return true;
  }

  bool GetConPty(uint64_t token, prospero_conpty_handle* out_handle) {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto found = terminals_.find(token);
    if (found == terminals_.end()) return false;
    *out_handle = found->second;
    return true;
  }

  bool TakeConPty(uint64_t token, prospero_conpty_handle* out_handle) {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto found = terminals_.find(token);
    if (found == terminals_.end()) return false;
    *out_handle = found->second;
    terminals_.erase(found);
    return true;
  }

 private:
  uint64_t NextTokenLocked() {
    do {
      ++next_token_;
      if (next_token_ == 0) ++next_token_;
    } while (jobs_.count(next_token_) != 0 || terminals_.count(next_token_) != 0);
    return next_token_;
  }

  std::mutex mutex_;
  uint64_t next_token_ = 0;
  std::unordered_map<uint64_t, prospero_job_object_handle> jobs_;
  std::unordered_map<uint64_t, prospero_conpty_handle> terminals_;
};

NativeHandleRegistry& HandleRegistry() {
  static NativeHandleRegistry registry;
  return registry;
}

bool GetBigIntToken(napi_env env, napi_value value, uint64_t* out_token) {
  bool lossless = false;
  if (napi_get_value_bigint_uint64(env, value, out_token, &lossless) != napi_ok || !lossless ||
      *out_token == 0) {
    ThrowTypeError(env, "expected an opaque native bigint handle");
    return false;
  }
  return true;
}

napi_value MakeBigInt(napi_env env, uint64_t value) {
  napi_value result = nullptr;
  if (napi_create_bigint_uint64(env, value, &result) != napi_ok) return nullptr;
  return result;
}

bool GetRequiredJobHandle(napi_env env, napi_value value, prospero_job_object_handle* out_handle) {
  uint64_t token = 0;
  if (!GetBigIntToken(env, value, &token)) return false;
  if (!HandleRegistry().GetJob(token, out_handle)) {
    napi_throw_error(env, "PROSPERO_NATIVE_NOT_FOUND", "unknown or closed Job Object handle");
    return false;
  }
  return true;
}

bool GetRequiredConPtyHandle(napi_env env, napi_value value, prospero_conpty_handle* out_handle) {
  uint64_t token = 0;
  if (!GetBigIntToken(env, value, &token)) return false;
  if (!HandleRegistry().GetConPty(token, out_handle)) {
    napi_throw_error(env, "PROSPERO_NATIVE_NOT_FOUND", "unknown or closed ConPTY handle");
    return false;
  }
  return true;
}

bool GetOptionalJobProperty(
    napi_env env,
    napi_value options,
    prospero_job_object_handle* out_job,
    uint8_t* out_has_job) {
  napi_value value = nullptr;
  bool present = false;
  if (!GetNamedProperty(env, options, "job", &value, &present)) return false;
  if (!present) {
    *out_job = 0;
    *out_has_job = 0;
    return true;
  }
  if (!GetRequiredJobHandle(env, value, out_job)) return false;
  *out_has_job = 1;
  return true;
}

bool MakeProcessIdentity(
    napi_env env,
    const prospero_process_identity& identity,
    napi_value* out_value) {
  napi_value result = nullptr;
  napi_value pid = nullptr;
  napi_value creation_time = nullptr;
  const std::string ticks = std::to_string(identity.creation_time_100ns);
  if (napi_create_object(env, &result) != napi_ok ||
      napi_create_uint32(env, identity.pid, &pid) != napi_ok ||
      napi_create_string_utf8(env, ticks.c_str(), NAPI_AUTO_LENGTH, &creation_time) != napi_ok ||
      napi_set_named_property(env, result, "pid", pid) != napi_ok ||
      napi_set_named_property(env, result, "creationTime100ns", creation_time) != napi_ok) {
    return false;
  }
  *out_value = result;
  return true;
}

bool MakeParentJobCompatibility(
    napi_env env,
    const prospero_parent_job_compatibility& value,
    napi_value* out_value) {
  napi_value result = nullptr;
  if (napi_create_object(env, &result) != napi_ok ||
      !SetBool(env, result, "parentJobDetected", value.parent_job_detected != 0) ||
      !SetBool(env, result, "breakawayAllowed", value.breakaway_allowed != 0) ||
      !SetBool(env, result, "detachedLaunchAllowed", value.detached_launch_allowed != 0)) {
    return false;
  }
  *out_value = result;
  return true;
}

struct ParsedProcessLaunchOptions {
  std::wstring executable_path;
  std::vector<std::wstring> argument_values;
  std::vector<const wchar_t*> argument_pointers;
  std::wstring working_directory;
  bool has_working_directory = false;
  EnvironmentBlock environment;
  prospero_job_object_handle job = 0;
  uint8_t has_job = 0;
};

bool ParseProcessLaunchOptions(
    napi_env env,
    napi_value options,
    bool allow_job,
    ParsedProcessLaunchOptions* out_options) {
  if (!GetRequiredStringProperty(env, options, "executablePath", &out_options->executable_path) ||
      out_options->executable_path.empty() ||
      !GetStringArrayProperty(env, options, "arguments", &out_options->argument_values) ||
      !GetOptionalStringProperty(env,
                                 options,
                                 "workingDirectory",
                                 &out_options->working_directory,
                                 &out_options->has_working_directory) ||
      !BuildEnvironmentBlock(env, options, &out_options->environment)) {
    return false;
  }
  out_options->argument_pointers.clear();
  out_options->argument_pointers.reserve(out_options->argument_values.size());
  for (const std::wstring& argument : out_options->argument_values) {
    out_options->argument_pointers.push_back(argument.c_str());
  }
  if (allow_job) return GetOptionalJobProperty(env, options, &out_options->job, &out_options->has_job);
  return true;
}

napi_value CreateJobObject(napi_env env, napi_callback_info info) {
  napi_value options_value = nullptr;
  if (!GetRequiredObjectArgument(env, info, &options_value)) return nullptr;
  bool kill_on_close = false;
  if (!GetBoolProperty(env, options_value, "killOnClose", true, &kill_on_close)) return nullptr;
  uint32_t active_process_limit = 0;
  bool has_active_process_limit = false;
  if (!GetOptionalUint32Property(env,
                                 options_value,
                                 "activeProcessLimit",
                                 &active_process_limit,
                                 &has_active_process_limit)) {
    return nullptr;
  }
  const prospero_job_object_options options = {
      static_cast<uint8_t>(kill_on_close ? 1 : 0),
      active_process_limit,
      static_cast<uint8_t>(has_active_process_limit ? 1 : 0),
  };
  prospero_job_object_handle raw_job = 0;
  const prospero_status status = prospero_job_object_create(&options, &raw_job);
  if (status != PROSPERO_STATUS_OK) {
    ThrowStatus(env, status, "createJobObject");
    return nullptr;
  }
  return MakeBigInt(env, HandleRegistry().StoreJob(raw_job));
}

napi_value AssignProcessToJob(napi_env env, napi_callback_info info) {
  napi_value arguments[2] = {nullptr};
  size_t count = 0;
  if (!GetArguments(env, info, 2, &count, arguments) || count != 2) {
    ThrowTypeError(env, "assignProcessToJob expects a Job Object and process identity");
    return nullptr;
  }
  prospero_job_object_handle job = 0;
  if (!GetRequiredJobHandle(env, arguments[0], &job) || !IsObject(env, arguments[1])) return nullptr;
  napi_value pid_value = nullptr;
  napi_value creation_value = nullptr;
  bool has_pid = false;
  bool has_creation = false;
  if (!GetNamedProperty(env, arguments[1], "pid", &pid_value, &has_pid) ||
      !GetNamedProperty(env, arguments[1], "creationTime100ns", &creation_value, &has_creation) ||
      !has_pid || !has_creation) {
    ThrowTypeError(env, "process identity requires pid and creationTime100ns");
    return nullptr;
  }
  prospero_process_identity process = {};
  if (!GetUint32Value(env, pid_value, &process.pid) || process.pid == 0) {
    if (process.pid == 0) ThrowTypeError(env, "process identity pid must be non-zero");
    return nullptr;
  }
  std::wstring creation_time_text;
  if (!GetUtf16String(env, creation_value, &creation_time_text) || creation_time_text.empty()) return nullptr;
  wchar_t* end = nullptr;
  const unsigned long long creation_time = wcstoull(creation_time_text.c_str(), &end, 10);
  if (end == nullptr || *end != L'\0' || creation_time == 0) {
    ThrowTypeError(env, "creationTime100ns must be a non-zero unsigned decimal FILETIME");
    return nullptr;
  }
  process.creation_time_100ns = static_cast<uint64_t>(creation_time);
  const prospero_status status = prospero_job_object_assign_process(job, process);
  if (status != PROSPERO_STATUS_OK) {
    ThrowStatus(env, status, "assignProcessToJob");
    return nullptr;
  }
  return ReturnUndefined(env);
}

napi_value TerminateJobObject(napi_env env, napi_callback_info info) {
  napi_value arguments[2] = {nullptr};
  size_t count = 0;
  if (!GetArguments(env, info, 2, &count, arguments) || count != 2) {
    ThrowTypeError(env, "terminateJobObject expects a Job Object and exit code");
    return nullptr;
  }
  prospero_job_object_handle job = 0;
  uint32_t exit_code = 0;
  if (!GetRequiredJobHandle(env, arguments[0], &job) ||
      !GetUint32Value(env, arguments[1], &exit_code)) return nullptr;
  const prospero_status status = prospero_job_object_terminate(job, exit_code);
  if (status != PROSPERO_STATUS_OK) {
    ThrowStatus(env, status, "terminateJobObject");
    return nullptr;
  }
  return ReturnUndefined(env);
}

napi_value CloseJobObject(napi_env env, napi_callback_info info) {
  napi_value arguments[1] = {nullptr};
  size_t count = 0;
  if (!GetArguments(env, info, 1, &count, arguments) || count != 1) {
    ThrowTypeError(env, "closeJobObject expects a Job Object");
    return nullptr;
  }
  uint64_t token = 0;
  prospero_job_object_handle job = 0;
  if (!GetBigIntToken(env, arguments[0], &token)) return nullptr;
  if (!HandleRegistry().TakeJob(token, &job)) {
    napi_throw_error(env, "PROSPERO_NATIVE_NOT_FOUND", "unknown or closed Job Object handle");
    return nullptr;
  }
  const prospero_status status = prospero_job_object_close(job);
  if (status != PROSPERO_STATUS_OK) {
    ThrowStatus(env, status, "closeJobObject");
    return nullptr;
  }
  return ReturnUndefined(env);
}

napi_value GetParentJobCompatibility(napi_env env, napi_callback_info info) {
  napi_value unused[1] = {nullptr};
  size_t count = 0;
  if (!GetArguments(env, info, 1, &count, unused) || count != 0) {
    ThrowTypeError(env, "getParentJobCompatibility expects no arguments");
    return nullptr;
  }
  prospero_parent_job_compatibility compatibility = {};
  const prospero_status status = prospero_query_parent_job_compatibility(&compatibility);
  if (status != PROSPERO_STATUS_OK) {
    ThrowStatus(env, status, "getParentJobCompatibility");
    return nullptr;
  }
  napi_value result = nullptr;
  return MakeParentJobCompatibility(env, compatibility, &result) ? result : nullptr;
}

napi_value LaunchDetachedHost(napi_env env, napi_callback_info info) {
  napi_value options_value = nullptr;
  if (!GetRequiredObjectArgument(env, info, &options_value)) return nullptr;
  ParsedProcessLaunchOptions parsed;
  if (!ParseProcessLaunchOptions(env, options_value, true, &parsed)) return nullptr;
  const prospero_detached_host_launch_options options = {
      parsed.executable_path.c_str(),
      parsed.argument_pointers.empty() ? nullptr : parsed.argument_pointers.data(),
      static_cast<uint32_t>(parsed.argument_pointers.size()),
      parsed.has_working_directory ? parsed.working_directory.c_str() : nullptr,
      parsed.environment.value(),
      parsed.job,
      parsed.has_job,
  };
  prospero_detached_host_launch_result result = {};
  const prospero_status status = prospero_detached_host_launch(&options, &result);
  if (status != PROSPERO_STATUS_OK) {
    ThrowStatus(env, status, "launchDetachedHost");
    return nullptr;
  }
  napi_value response = nullptr;
  if (napi_create_object(env, &response) != napi_ok) return nullptr;
  if (result.outcome == PROSPERO_DETACHED_HOST_PARENT_JOB_PREVENTS_DETACH) {
    napi_value parent_job = nullptr;
    if (!SetString(env, response, "status", "parent_job_prevents_detach") ||
        !MakeParentJobCompatibility(env, result.parent_job, &parent_job) ||
        napi_set_named_property(env, response, "parentJob", parent_job) != napi_ok) {
      return nullptr;
    }
    return response;
  }
  napi_value process = nullptr;
  if (result.outcome != PROSPERO_DETACHED_HOST_LAUNCHED ||
      !SetString(env, response, "status", "launched") ||
      !MakeProcessIdentity(env, result.process, &process) ||
      napi_set_named_property(env, response, "process", process) != napi_ok) {
    napi_throw_error(env, "PROSPERO_NATIVE_SYSTEM_ERROR", "detached host returned an invalid result");
    return nullptr;
  }
  return response;
}

napi_value SpawnConPty(napi_env env, napi_callback_info info) {
  napi_value options_value = nullptr;
  if (!GetRequiredObjectArgument(env, info, &options_value)) return nullptr;
  ParsedProcessLaunchOptions parsed;
  if (!ParseProcessLaunchOptions(env, options_value, true, &parsed)) return nullptr;
  napi_value columns_value = nullptr;
  napi_value rows_value = nullptr;
  bool has_columns = false;
  bool has_rows = false;
  if (!GetNamedProperty(env, options_value, "columns", &columns_value, &has_columns) ||
      !GetNamedProperty(env, options_value, "rows", &rows_value, &has_rows) ||
      !has_columns || !has_rows) {
    ThrowTypeError(env, "ConPTY options require columns and rows");
    return nullptr;
  }
  uint16_t columns = 0;
  uint16_t rows = 0;
  if (!GetUint16Value(env, columns_value, &columns) ||
      !GetUint16Value(env, rows_value, &rows)) return nullptr;
  const prospero_conpty_spawn_options options = {
      parsed.executable_path.c_str(),
      parsed.argument_pointers.empty() ? nullptr : parsed.argument_pointers.data(),
      static_cast<uint32_t>(parsed.argument_pointers.size()),
      columns,
      rows,
      parsed.has_working_directory ? parsed.working_directory.c_str() : nullptr,
      parsed.environment.value(),
      parsed.job,
      parsed.has_job,
  };
  prospero_conpty_handle raw_terminal = 0;
  const prospero_status status = prospero_conpty_spawn(&options, &raw_terminal);
  if (status != PROSPERO_STATUS_OK) {
    ThrowStatus(env, status, "spawnConPty");
    return nullptr;
  }
  return MakeBigInt(env, HandleRegistry().StoreConPty(raw_terminal));
}

napi_value ResizeConPty(napi_env env, napi_callback_info info) {
  napi_value arguments[3] = {nullptr};
  size_t count = 0;
  if (!GetArguments(env, info, 3, &count, arguments) || count != 3) {
    ThrowTypeError(env, "resizeConPty expects a terminal, columns, and rows");
    return nullptr;
  }
  prospero_conpty_handle terminal = 0;
  uint16_t columns = 0;
  uint16_t rows = 0;
  if (!GetRequiredConPtyHandle(env, arguments[0], &terminal) ||
      !GetUint16Value(env, arguments[1], &columns) ||
      !GetUint16Value(env, arguments[2], &rows)) return nullptr;
  const prospero_status status = prospero_conpty_resize(terminal, columns, rows);
  if (status != PROSPERO_STATUS_OK) {
    ThrowStatus(env, status, "resizeConPty");
    return nullptr;
  }
  return ReturnUndefined(env);
}

bool GetByteArray(napi_env env, napi_value value, const uint8_t** out_data, size_t* out_length) {
  napi_typedarray_type array_type;
  size_t length = 0;
  void* data = nullptr;
  napi_value array_buffer = nullptr;
  size_t byte_offset = 0;
  if (napi_get_typedarray_info(env,
                               value,
                               &array_type,
                               &length,
                               &data,
                               &array_buffer,
                               &byte_offset) != napi_ok ||
      array_type != napi_uint8_array) {
    ThrowTypeError(env, "expected a Uint8Array");
    return false;
  }
  *out_data = static_cast<const uint8_t*>(data);
  *out_length = length;
  return true;
}

napi_value ReadConPty(napi_env env, napi_callback_info info) {
  napi_value arguments[2] = {nullptr};
  size_t count = 0;
  if (!GetArguments(env, info, 2, &count, arguments) || count != 2) {
    ThrowTypeError(env, "readConPty expects a terminal and maxBytes");
    return nullptr;
  }
  prospero_conpty_handle terminal = 0;
  uint32_t max_bytes = 0;
  if (!GetRequiredConPtyHandle(env, arguments[0], &terminal) ||
      !GetUint32Value(env, arguments[1], &max_bytes) ||
      max_bytes == 0 || max_bytes > kMaxNativeIoBytes) {
    if (max_bytes == 0 || max_bytes > kMaxNativeIoBytes) {
      ThrowTypeError(env, "maxBytes must be between 1 and 16 MiB");
    }
    return nullptr;
  }
  std::vector<uint8_t> data(max_bytes);
  uint32_t read = 0;
  const prospero_status status = prospero_conpty_read(terminal, data.data(), max_bytes, &read);
  if (status != PROSPERO_STATUS_OK) {
    ThrowStatus(env, status, "readConPty");
    return nullptr;
  }
  napi_value array_buffer = nullptr;
  void* target = nullptr;
  if (napi_create_arraybuffer(env, read, &target, &array_buffer) != napi_ok) return nullptr;
  if (read != 0) memcpy(target, data.data(), read);
  napi_value result = nullptr;
  if (napi_create_typedarray(env, napi_uint8_array, read, array_buffer, 0, &result) != napi_ok) {
    return nullptr;
  }
  return result;
}

napi_value WriteConPty(napi_env env, napi_callback_info info) {
  napi_value arguments[2] = {nullptr};
  size_t count = 0;
  if (!GetArguments(env, info, 2, &count, arguments) || count != 2) {
    ThrowTypeError(env, "writeConPty expects a terminal and Uint8Array");
    return nullptr;
  }
  prospero_conpty_handle terminal = 0;
  const uint8_t* data = nullptr;
  size_t length = 0;
  if (!GetRequiredConPtyHandle(env, arguments[0], &terminal) ||
      !GetByteArray(env, arguments[1], &data, &length)) return nullptr;
  if (length == 0) {
    napi_value zero = nullptr;
    return napi_create_uint32(env, 0, &zero) == napi_ok ? zero : nullptr;
  }
  if (length > kMaxNativeIoBytes) {
    ThrowTypeError(env, "Uint8Array must not exceed 16 MiB");
    return nullptr;
  }
  uint32_t written = 0;
  const prospero_status status = prospero_conpty_write(
      terminal, data, static_cast<uint32_t>(length), &written);
  if (status != PROSPERO_STATUS_OK) {
    ThrowStatus(env, status, "writeConPty");
    return nullptr;
  }
  napi_value result = nullptr;
  if (napi_create_uint32(env, written, &result) != napi_ok) return nullptr;
  return result;
}

napi_value KillConPty(napi_env env, napi_callback_info info) {
  napi_value arguments[2] = {nullptr};
  size_t count = 0;
  if (!GetArguments(env, info, 2, &count, arguments) || count != 2) {
    ThrowTypeError(env, "killConPty expects a terminal and exit code");
    return nullptr;
  }
  prospero_conpty_handle terminal = 0;
  uint32_t exit_code = 0;
  if (!GetRequiredConPtyHandle(env, arguments[0], &terminal) ||
      !GetUint32Value(env, arguments[1], &exit_code)) return nullptr;
  const prospero_status status = prospero_conpty_kill(terminal, exit_code);
  if (status != PROSPERO_STATUS_OK) {
    ThrowStatus(env, status, "killConPty");
    return nullptr;
  }
  return ReturnUndefined(env);
}

napi_value CloseConPty(napi_env env, napi_callback_info info) {
  napi_value arguments[1] = {nullptr};
  size_t count = 0;
  if (!GetArguments(env, info, 1, &count, arguments) || count != 1) {
    ThrowTypeError(env, "closeConPty expects a terminal");
    return nullptr;
  }
  uint64_t token = 0;
  prospero_conpty_handle terminal = 0;
  if (!GetBigIntToken(env, arguments[0], &token)) return nullptr;
  if (!HandleRegistry().TakeConPty(token, &terminal)) {
    napi_throw_error(env, "PROSPERO_NATIVE_NOT_FOUND", "unknown or closed ConPTY handle");
    return nullptr;
  }
  const prospero_status status = prospero_conpty_close(terminal);
  if (status != PROSPERO_STATUS_OK) {
    ThrowStatus(env, status, "closeConPty");
    return nullptr;
  }
  return ReturnUndefined(env);
}

#endif  // defined(_WIN32)

}  // namespace process_terminal

}  // namespace

extern "C" prospero_status prospero_query_capability_report(
    prospero_capability_report* out_report) {
  if (out_report == nullptr) return PROSPERO_STATUS_INVALID_ARGUMENT;
  out_report->abi_version = PROSPERO_WINDOWS_NATIVE_ABI_VERSION;
  out_report->napi_version = PROSPERO_WINDOWS_NATIVE_NAPI_VERSION;
#if defined(_WIN32)
  out_report->capability_mask = PROSPERO_CAPABILITY_PROCESS_IDENTITY |
      PROSPERO_CAPABILITY_SECURE_NAMED_PIPE |
      PROSPERO_CAPABILITY_JOB_OBJECT |
      PROSPERO_CAPABILITY_PARENT_JOB_COMPATIBILITY |
      PROSPERO_CAPABILITY_DETACHED_HOST |
      PROSPERO_CAPABILITY_CONPTY |
      PROSPERO_CAPABILITY_DPAPI_CURRENT_USER |
      PROSPERO_CAPABILITY_SECURE_STATE_DIRECTORY;
#else
  out_report->capability_mask = 0;
#endif
  return PROSPERO_STATUS_OK;
}

NAPI_MODULE_INIT() {
  if (!ExportMethod(env, exports, "getAbiInfo", GetAbiInfo) ||
      !ExportMethod(env, exports, "getCurrentProcessIdentity", GetCurrentProcessIdentity) ||
      !ExportMethod(env, exports, "getProcessIdentity", GetProcessIdentityForPid) ||
      !ExportMethod(env, exports, "matchesProcessIdentity", MatchesProcessIdentity) ||
      !ExportMethod(env, exports, "createSecureNamedPipeServer", CreateSecureNamedPipeServer) ||
      !ExportMethod(env, exports, "acceptSecureNamedPipeConnection", AcceptSecureNamedPipeConnection) ||
      !ExportMethod(env, exports, "closeSecureNamedPipeServer", CloseSecureNamedPipeServer) ||
      !ExportMethod(env, exports, "readSecureNamedPipeConnection", ReadSecureNamedPipeConnection) ||
      !ExportMethod(env, exports, "writeSecureNamedPipeConnection", WriteSecureNamedPipeConnection) ||
      !ExportMethod(env, exports, "getSecureNamedPipePeerIdentity", GetSecureNamedPipePeerIdentity) ||
      !ExportMethod(env, exports, "disconnectSecureNamedPipeConnection", DisconnectSecureNamedPipeConnection) ||
      !ExportMethod(env, exports, "closeSecureNamedPipeConnection", CloseSecureNamedPipeConnection) ||
#if defined(_WIN32)
      !ExportMethod(env, exports, "createJobObject", process_terminal::CreateJobObject) ||
      !ExportMethod(env, exports, "assignProcessToJob", process_terminal::AssignProcessToJob) ||
      !ExportMethod(env, exports, "terminateJobObject", process_terminal::TerminateJobObject) ||
      !ExportMethod(env, exports, "closeJobObject", process_terminal::CloseJobObject) ||
      !ExportMethod(env, exports, "getParentJobCompatibility", process_terminal::GetParentJobCompatibility) ||
      !ExportMethod(env, exports, "launchDetachedHost", process_terminal::LaunchDetachedHost) ||
      !ExportMethod(env, exports, "spawnConPty", process_terminal::SpawnConPty) ||
      !ExportMethod(env, exports, "resizeConPty", process_terminal::ResizeConPty) ||
      !ExportMethod(env, exports, "readConPty", process_terminal::ReadConPty) ||
      !ExportMethod(env, exports, "writeConPty", process_terminal::WriteConPty) ||
      !ExportMethod(env, exports, "killConPty", process_terminal::KillConPty) ||
      !ExportMethod(env, exports, "closeConPty", process_terminal::CloseConPty) ||
#else
      !ExportMethod(env, exports, "createJobObject", ThrowNotAvailable) ||
      !ExportMethod(env, exports, "assignProcessToJob", ThrowNotAvailable) ||
      !ExportMethod(env, exports, "terminateJobObject", ThrowNotAvailable) ||
      !ExportMethod(env, exports, "closeJobObject", ThrowNotAvailable) ||
      !ExportMethod(env, exports, "getParentJobCompatibility", ThrowNotAvailable) ||
      !ExportMethod(env, exports, "launchDetachedHost", ThrowNotAvailable) ||
      !ExportMethod(env, exports, "spawnConPty", ThrowNotAvailable) ||
      !ExportMethod(env, exports, "resizeConPty", ThrowNotAvailable) ||
      !ExportMethod(env, exports, "readConPty", ThrowNotAvailable) ||
      !ExportMethod(env, exports, "writeConPty", ThrowNotAvailable) ||
      !ExportMethod(env, exports, "killConPty", ThrowNotAvailable) ||
      !ExportMethod(env, exports, "closeConPty", ThrowNotAvailable) ||
#endif
      !ExportMethod(env, exports, "dpapiProtectCurrentUser", DpapiProtectCurrentUser) ||
      !ExportMethod(env, exports, "dpapiUnprotectCurrentUser", DpapiUnprotectCurrentUser) ||
      !ExportMethod(env, exports, "openSecureStateDirectory", OpenSecureStateDirectory) ||
      !ExportMethod(env, exports, "writeSecureStateFileAtomically", WriteSecureStateFileAtomically) ||
      !ExportMethod(env, exports, "readSecureStateFile", ReadSecureStateFile) ||
      !ExportMethod(env, exports, "listSecureStateEntries", ListSecureStateEntries) ||
      !ExportMethod(env, exports, "removeSecureStateFile", RemoveSecureStateFile) ||
      !ExportMethod(env, exports, "closeSecureStateDirectory", CloseSecureStateDirectory)) {
    return nullptr;
  }
  return exports;
}
