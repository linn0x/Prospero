#include "prospero_windows_native.h"

#include <wchar.h>

namespace {

bool IsAsciiEqualIgnoreCase(const wchar_t* value, uint32_t length, const wchar_t* literal) {
  uint32_t index = 0;
  for (; index < length && literal[index] != L'\0'; ++index) {
    wchar_t actual = value[index];
    wchar_t expected = literal[index];
    if (actual >= L'a' && actual <= L'z') actual -= L'a' - L'A';
    if (expected >= L'a' && expected <= L'z') expected -= L'a' - L'A';
    if (actual != expected) return false;
  }
  return index == length && literal[index] == L'\0';
}

bool IsReservedDosDeviceName(const wchar_t* file_name) {
  uint32_t stem_length = 0;
  while (file_name[stem_length] != L'\0' && file_name[stem_length] != L'.') ++stem_length;
  while (stem_length > 0 && file_name[stem_length - 1] == L' ') --stem_length;
  if (IsAsciiEqualIgnoreCase(file_name, stem_length, L"CON") ||
      IsAsciiEqualIgnoreCase(file_name, stem_length, L"PRN") ||
      IsAsciiEqualIgnoreCase(file_name, stem_length, L"AUX") ||
      IsAsciiEqualIgnoreCase(file_name, stem_length, L"NUL")) {
    return true;
  }
  if (stem_length != 4 ||
      (!IsAsciiEqualIgnoreCase(file_name, 3, L"COM") &&
       !IsAsciiEqualIgnoreCase(file_name, 3, L"LPT"))) {
    return false;
  }
  const wchar_t device_number = file_name[3];
  // Win32 also reserves COM/LPT followed by superscript 1, 2, or 3.
  return (device_number >= L'1' && device_number <= L'9') ||
         device_number == L'\u00b9' || device_number == L'\u00b2' ||
         device_number == L'\u00b3';
}

bool IsStrictStateFileName(const wchar_t* file_name) {
  if (file_name == nullptr || file_name[0] == L'\0' ||
      wcscmp(file_name, L".") == 0 || wcscmp(file_name, L"..") == 0) {
    return false;
  }
  uint32_t length = 0;
  for (; file_name[length] != L'\0'; ++length) {
    const wchar_t character = file_name[length];
    if (character < 0x20 || character == L'\\' || character == L'/' ||
        character == L':' || character == L'<' || character == L'>' ||
        character == L'"' || character == L'|' || character == L'?' ||
        character == L'*') {
      return false;
    }
  }
  return file_name[length - 1] != L'.' && file_name[length - 1] != L' ' &&
         !IsReservedDosDeviceName(file_name);
}

}  // namespace

#if defined(_WIN32)

#include <windows.h>
#include <aclapi.h>
#include <sddl.h>

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace {

using NtStatus = LONG;

// These native NT constants are stable on supported Windows releases. They
// are defined here instead of including WDK-only headers, and the entry points
// are resolved dynamically so an unavailable primitive fails closed.
constexpr ULONG kObjCaseInsensitive = 0x00000040UL;
constexpr ULONG kFileDirectoryFile = 0x00000001UL;
constexpr ULONG kFileNonDirectoryFile = 0x00000040UL;
constexpr ULONG kFileSynchronousIoNonalert = 0x00000020UL;
constexpr ULONG kFileOpenReparsePoint = 0x00200000UL;
// NtCreateFile CreateOptions value, deliberately not Win32's
// FILE_FLAG_WRITE_THROUGH (which has a different bit value).
constexpr ULONG kFileWriteThrough = 0x00000002UL;
constexpr ULONG kFileOpen = 0x00000001UL;
constexpr ULONG kFileCreate = 0x00000002UL;
constexpr ULONG kFileOpenIf = 0x00000003UL;
constexpr ULONG kFileDirectoryInformation = 1UL;
constexpr NtStatus kStatusObjectNameCollision = static_cast<NtStatus>(0xC0000035UL);
constexpr NtStatus kStatusNoMoreFiles = static_cast<NtStatus>(0x80000006UL);
constexpr uint64_t kMaximumStateFileBytes = 64ULL * 1024ULL * 1024ULL;

struct NtUnicodeString {
  USHORT length;
  USHORT maximum_length;
  PWSTR buffer;
};

struct NtObjectAttributes {
  ULONG length;
  HANDLE root_directory;
  NtUnicodeString* object_name;
  ULONG attributes;
  PVOID security_descriptor;
  PVOID security_quality_of_service;
};

struct NtIoStatusBlock {
  union {
    NtStatus status;
    PVOID pointer;
  } value;
  ULONG_PTR information;
};

struct NtFileRenameInformation {
  BOOLEAN replace_if_exists;
  HANDLE root_directory;
  ULONG file_name_length;
  WCHAR file_name[1];
};

struct NtFileDirectoryInformation {
  ULONG next_entry_offset;
  ULONG file_index;
  LARGE_INTEGER creation_time;
  LARGE_INTEGER last_access_time;
  LARGE_INTEGER last_write_time;
  LARGE_INTEGER change_time;
  LARGE_INTEGER end_of_file;
  LARGE_INTEGER allocation_size;
  ULONG file_attributes;
  ULONG file_name_length;
  WCHAR file_name[1];
};

using NtCreateFileFn = NtStatus(NTAPI*)(
    PHANDLE, ACCESS_MASK, NtObjectAttributes*, NtIoStatusBlock*, PLARGE_INTEGER,
    ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
using NtQueryDirectoryFileFn = NtStatus(NTAPI*)(
    HANDLE, HANDLE, PVOID, PVOID, NtIoStatusBlock*, PVOID, ULONG, ULONG,
    BOOLEAN, NtUnicodeString*, BOOLEAN);

struct NtApi {
  NtCreateFileFn create_file = nullptr;
  NtQueryDirectoryFileFn query_directory_file = nullptr;
};

struct StateDirectory {
  std::mutex mutex;
  HANDLE directory = INVALID_HANDLE_VALUE;
  std::vector<BYTE> owner_sid;
  std::vector<BYTE> self_relative_security_descriptor;

  ~StateDirectory() {
    if (directory != INVALID_HANDLE_VALUE) CloseHandle(directory);
  }
};

std::mutex g_state_registry_mutex;
std::unordered_map<uint64_t, std::shared_ptr<StateDirectory>> g_state_directories;
std::atomic<uint64_t> g_next_state_handle{1};
std::atomic<uint64_t> g_temp_counter{1};

bool NtSucceeded(NtStatus status) { return status >= 0; }

prospero_status StatusFromLastError(DWORD error) {
  switch (error) {
    case ERROR_ACCESS_DENIED:
      return PROSPERO_STATUS_ACCESS_DENIED;
    case ERROR_FILE_NOT_FOUND:
    case ERROR_PATH_NOT_FOUND:
    case ERROR_INVALID_HANDLE:
      return PROSPERO_STATUS_NOT_FOUND;
    case ERROR_INVALID_PARAMETER:
    case ERROR_BAD_PATHNAME:
      return PROSPERO_STATUS_INVALID_ARGUMENT;
    default:
      return PROSPERO_STATUS_SYSTEM_ERROR;
  }
}

prospero_status StatusFromNt(NtStatus status) {
  switch (static_cast<ULONG>(status)) {
    case 0xC0000022UL:  // STATUS_ACCESS_DENIED
      return PROSPERO_STATUS_ACCESS_DENIED;
    case 0xC0000034UL:  // STATUS_OBJECT_NAME_NOT_FOUND
    case 0xC000003AUL:  // STATUS_OBJECT_PATH_NOT_FOUND
    case 0x80000006UL:  // STATUS_NO_MORE_FILES
      return PROSPERO_STATUS_NOT_FOUND;
    case 0xC000000DUL:  // STATUS_INVALID_PARAMETER
      return PROSPERO_STATUS_INVALID_ARGUMENT;
    default:
      return PROSPERO_STATUS_SYSTEM_ERROR;
  }
}

const NtApi* GetNtApi() {
  static const NtApi api = []() {
    NtApi result{};
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    if (ntdll == nullptr) return result;
    result.create_file = reinterpret_cast<NtCreateFileFn>(GetProcAddress(ntdll, "NtCreateFile"));
    result.query_directory_file = reinterpret_cast<NtQueryDirectoryFileFn>(
        GetProcAddress(ntdll, "NtQueryDirectoryFile"));
    return result;
  }();
  return api.create_file != nullptr && api.query_directory_file != nullptr
             ? &api
             : nullptr;
}

bool HasReparsePoint(HANDLE handle) {
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  return !GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &attributes,
                                       static_cast<DWORD>(sizeof(attributes))) ||
         (attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
}

bool CopySid(PSID source, std::vector<BYTE>* destination) {
  if (source == nullptr || !IsValidSid(source)) return false;
  const DWORD size = GetLengthSid(source);
  if (size == 0) return false;
  destination->resize(size);
  return ::CopySid(size, destination->data(), source) != FALSE;
}

bool QueryCurrentUserSid(std::vector<BYTE>* owner_sid) {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  DWORD required = 0;
  const BOOL first = GetTokenInformation(token, TokenUser, nullptr, 0, &required);
  if (first || GetLastError() != ERROR_INSUFFICIENT_BUFFER || required == 0) {
    CloseHandle(token);
    return false;
  }
  std::vector<BYTE> storage(required);
  const BOOL read = GetTokenInformation(token, TokenUser, storage.data(), required, &required);
  CloseHandle(token);
  if (!read) return false;
  const TOKEN_USER* user = reinterpret_cast<const TOKEN_USER*>(storage.data());
  return CopySid(user->User.Sid, owner_sid);
}

bool IsCurrentUserOnlyDacl(PACL dacl, const std::vector<BYTE>& owner_sid) {
  if (dacl == nullptr || owner_sid.empty()) return false;
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
  return ace->Mask == GENERIC_ALL &&
         IsValidSid(ace_sid) &&
         EqualSid(ace_sid, const_cast<BYTE*>(owner_sid.data())) != FALSE;
}

bool BuildCurrentUserOnlySecurityDescriptor(const std::vector<BYTE>& owner_sid,
                                            std::vector<BYTE>* output) {
  if (owner_sid.empty() || output == nullptr) return false;
  LPWSTR sid_text = nullptr;
  PSECURITY_DESCRIPTOR raw = nullptr;
  DWORD raw_bytes = 0;
  if (!ConvertSidToStringSidW(const_cast<BYTE*>(owner_sid.data()), &sid_text) ||
      sid_text == nullptr) {
    return false;
  }
  bool success = false;
  try {
    const std::wstring sddl = L"D:P(A;;GA;;;" + std::wstring(sid_text) + L")";
    SECURITY_DESCRIPTOR_CONTROL control = 0;
    DWORD revision = 0;
    if (ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.c_str(), SDDL_REVISION_1, &raw, &raw_bytes) && raw != nullptr &&
        raw_bytes != 0 && GetSecurityDescriptorLength(raw) == raw_bytes &&
        GetSecurityDescriptorControl(raw, &control, &revision) != FALSE &&
        (control & (SE_SELF_RELATIVE | SE_DACL_PROTECTED | SE_DACL_PRESENT)) ==
            (SE_SELF_RELATIVE | SE_DACL_PROTECTED | SE_DACL_PRESENT)) {
      output->assign(reinterpret_cast<const BYTE*>(raw),
                     reinterpret_cast<const BYTE*>(raw) + raw_bytes);
      success = true;
    }
  } catch (...) {
    output->clear();
  }
  if (raw != nullptr) LocalFree(raw);
  LocalFree(sid_text);
  return success;
}

prospero_status VerifyCurrentUserOnlyDacl(HANDLE handle,
                                          const std::vector<BYTE>& owner_sid) {
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  PACL dacl = nullptr;
  const DWORD result = GetSecurityInfo(handle, SE_FILE_OBJECT,
                                       DACL_SECURITY_INFORMATION,
                                       nullptr, nullptr, &dacl, nullptr, &descriptor);
  if (result != ERROR_SUCCESS) return StatusFromLastError(result);
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  const bool valid = descriptor != nullptr &&
                     GetSecurityDescriptorControl(descriptor, &control, &revision) != FALSE &&
                     (control & SE_DACL_PROTECTED) != 0 &&
                     IsCurrentUserOnlyDacl(dacl, owner_sid);
  if (descriptor != nullptr) LocalFree(descriptor);
  return valid ? PROSPERO_STATUS_OK : PROSPERO_STATUS_ACCESS_DENIED;
}

bool IsSafeDirectoryComponent(const std::wstring& component) {
  if (component.empty() || component == L"." || component == L".." ||
      component.back() == L'.' || component.back() == L' ') {
    return false;
  }
  for (const wchar_t character : component) {
    if (character < 0x20 || character == L'\\' || character == L'/' ||
        character == L':' || character == L'<' || character == L'>' ||
        character == L'"' || character == L'|' || character == L'?' ||
        character == L'*') {
      return false;
    }
  }
  return true;
}

bool ParseAbsoluteDrivePath(const wchar_t* raw_path,
                            std::wstring* volume_root,
                            std::vector<std::wstring>* components) {
  if (raw_path == nullptr || raw_path[0] == L'\0') return false;
  const std::wstring path(raw_path);
  if (path.size() < 4 || !((path[0] >= L'A' && path[0] <= L'Z') ||
                           (path[0] >= L'a' && path[0] <= L'z')) ||
      path[1] != L':' || path[2] != L'\\' || path.rfind(L"\\\\", 0) == 0 ||
      path.find(L'/') != std::wstring::npos || path.find(L'\0') != std::wstring::npos) {
    return false;
  }
  *volume_root = path.substr(0, 3);
  size_t start = 3;
  while (start < path.size()) {
    const size_t end = path.find(L'\\', start);
    const std::wstring component = path.substr(start, end - start);
    if (!IsSafeDirectoryComponent(component)) return false;
    components->push_back(component);
    if (end == std::wstring::npos) break;
    start = end + 1;
    if (start == path.size()) return false;
  }
  return !components->empty();
}

prospero_status OpenRelative(const NtApi* api,
                             HANDLE root,
                             const std::wstring& name,
                             ACCESS_MASK desired_access,
                             ULONG share_access,
                             ULONG create_disposition,
                             ULONG create_options,
                             HANDLE* out_handle,
                             ULONG_PTR* out_information,
                             PVOID security_descriptor = nullptr) {
  if (out_handle != nullptr) *out_handle = INVALID_HANDLE_VALUE;
  if (api == nullptr || name.empty() || name.size() > 32767 || out_handle == nullptr) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  NtUnicodeString unicode{};
  unicode.length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  unicode.maximum_length = unicode.length;
  unicode.buffer = const_cast<PWSTR>(name.c_str());
  NtObjectAttributes attributes{};
  attributes.length = sizeof(attributes);
  attributes.root_directory = root;
  attributes.object_name = &unicode;
  attributes.attributes = kObjCaseInsensitive;
  attributes.security_descriptor = security_descriptor;
  NtIoStatusBlock status_block{};
  HANDLE opened = INVALID_HANDLE_VALUE;
  const NtStatus status = api->create_file(&opened, desired_access, &attributes, &status_block,
                                           nullptr, FILE_ATTRIBUTE_NORMAL, share_access,
                                           create_disposition, create_options, nullptr, 0);
  if (!NtSucceeded(status)) return StatusFromNt(status);
  *out_handle = opened;
  if (out_information != nullptr) *out_information = status_block.information;
  return PROSPERO_STATUS_OK;
}

prospero_status OpenStateFile(const NtApi* api,
                              const StateDirectory& directory,
                              const wchar_t* file_name,
                              ACCESS_MASK desired_access,
                              ULONG create_disposition,
                              ULONG create_options,
                              HANDLE* out_file) {
  const prospero_status opened = OpenRelative(
      api, directory.directory, file_name, desired_access, FILE_SHARE_READ,
      create_disposition, create_options | kFileOpenReparsePoint |
                              kFileSynchronousIoNonalert,
      out_file, nullptr);
  if (opened != PROSPERO_STATUS_OK) return opened;
  if (HasReparsePoint(*out_file)) {
    CloseHandle(*out_file);
    *out_file = INVALID_HANDLE_VALUE;
    return PROSPERO_STATUS_ACCESS_DENIED;
  }
  const prospero_status dacl = VerifyCurrentUserOnlyDacl(*out_file, directory.owner_sid);
  if (dacl != PROSPERO_STATUS_OK) {
    CloseHandle(*out_file);
    *out_file = INVALID_HANDLE_VALUE;
  }
  return dacl;
}

std::shared_ptr<StateDirectory> FindStateDirectory(
    prospero_secure_state_directory_handle handle) {
  std::lock_guard<std::mutex> lock(g_state_registry_mutex);
  const auto found = g_state_directories.find(handle);
  return found == g_state_directories.end() ? nullptr : found->second;
}

uint64_t AllocateStateHandle() {
  uint64_t handle = g_next_state_handle.fetch_add(1, std::memory_order_relaxed);
  if (handle == 0) handle = g_next_state_handle.fetch_add(1, std::memory_order_relaxed);
  return handle;
}

prospero_status DeleteFileByHandle(HANDLE file) {
  FILE_DISPOSITION_INFO disposition{};
  disposition.DeleteFile = TRUE;
  if (!SetFileInformationByHandle(file, FileDispositionInfo, &disposition,
                                  static_cast<DWORD>(sizeof(disposition)))) {
    return StatusFromLastError(GetLastError());
  }
  return PROSPERO_STATUS_OK;
}

prospero_status CleanupTemporaryFile(HANDLE file) {
  const prospero_status cleanup = DeleteFileByHandle(file);
  CloseHandle(file);
  // Do not silently leave a capability/manifest temp file behind: callers see
  // cleanup failure rather than a misleading original I/O status.
  return cleanup;
}

void ClearOwnedStateBuffer(prospero_owned_buffer* buffer) {
  if (buffer == nullptr) return;
  if (buffer->data != nullptr) {
    SecureZeroMemory(buffer->data, buffer->length);
    LocalFree(buffer->data);
  }
  buffer->data = nullptr;
  buffer->length = 0;
}

void ClearStateEntryList(prospero_secure_state_entry_list* entries) {
  if (entries == nullptr) return;
  if (entries->entries != nullptr) {
    for (uint32_t index = 0; index < entries->count; ++index) {
      LocalFree(entries->entries[index]);
    }
    LocalFree(entries->entries);
  }
  entries->entries = nullptr;
  entries->count = 0;
}

std::wstring CreateTemporaryName() {
  const uint64_t count = g_temp_counter.fetch_add(1, std::memory_order_relaxed);
  return L".prospero-state-" + std::to_wstring(GetCurrentProcessId()) + L"-" +
         std::to_wstring(GetTickCount64()) + L"-" + std::to_wstring(count) + L".tmp";
}

prospero_status ReadAll(HANDLE file, prospero_owned_buffer* out_data) {
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(file, &size) || size.QuadPart < 0 ||
      static_cast<uint64_t>(size.QuadPart) > kMaximumStateFileBytes) {
    return PROSPERO_STATUS_SYSTEM_ERROR;
  }
  const uint32_t length = static_cast<uint32_t>(size.QuadPart);
  if (length == 0) return PROSPERO_STATUS_OK;
  uint8_t* data = static_cast<uint8_t*>(LocalAlloc(LMEM_FIXED, length));
  if (data == nullptr) return PROSPERO_STATUS_SYSTEM_ERROR;
  uint32_t offset = 0;
  while (offset < length) {
    DWORD read = 0;
    if (!ReadFile(file, data + offset, length - offset, &read, nullptr)) {
      SecureZeroMemory(data, length);
      LocalFree(data);
      return StatusFromLastError(GetLastError());
    }
    if (read == 0) {
      SecureZeroMemory(data, length);
      LocalFree(data);
      return PROSPERO_STATUS_SYSTEM_ERROR;
    }
    offset += read;
  }
  out_data->data = data;
  out_data->length = length;
  return PROSPERO_STATUS_OK;
}

prospero_status BuildEntryList(const std::vector<std::wstring>& names,
                               prospero_secure_state_entry_list* out_entries) {
  if (names.empty()) return PROSPERO_STATUS_OK;
  if (names.size() > UINT32_MAX || names.size() > SIZE_MAX / sizeof(wchar_t*)) {
    return PROSPERO_STATUS_SYSTEM_ERROR;
  }
  wchar_t** entries = static_cast<wchar_t**>(
      LocalAlloc(LMEM_FIXED | LMEM_ZEROINIT, sizeof(wchar_t*) * names.size()));
  if (entries == nullptr) return PROSPERO_STATUS_SYSTEM_ERROR;
  for (size_t index = 0; index < names.size(); ++index) {
    const size_t bytes = (names[index].size() + 1) * sizeof(wchar_t);
    entries[index] = static_cast<wchar_t*>(LocalAlloc(LMEM_FIXED, bytes));
    if (entries[index] == nullptr) {
      for (size_t cleanup = 0; cleanup < index; ++cleanup) LocalFree(entries[cleanup]);
      LocalFree(entries);
      return PROSPERO_STATUS_SYSTEM_ERROR;
    }
    memcpy(entries[index], names[index].c_str(), bytes);
  }
  out_entries->entries = entries;
  out_entries->count = static_cast<uint32_t>(names.size());
  return PROSPERO_STATUS_OK;
}

}  // namespace

extern "C" prospero_status prospero_secure_state_directory_open(
    const prospero_secure_state_directory_options* options,
    prospero_secure_state_directory_handle* out_directory) {
  if (out_directory != nullptr) *out_directory = 0;
  if (options == nullptr || options->absolute_path == nullptr || out_directory == nullptr) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  HANDLE current = INVALID_HANDLE_VALUE;
  try {
    const NtApi* api = GetNtApi();
    if (api == nullptr) return PROSPERO_STATUS_NOT_AVAILABLE;
    std::wstring volume_root;
    std::vector<std::wstring> components;
    if (!ParseAbsoluteDrivePath(options->absolute_path, &volume_root, &components)) {
      return PROSPERO_STATUS_INVALID_ARGUMENT;
    }
    std::vector<BYTE> owner_sid;
    if (!QueryCurrentUserSid(&owner_sid)) return StatusFromLastError(GetLastError());
    std::vector<BYTE> security_descriptor;
    if (!BuildCurrentUserOnlySecurityDescriptor(owner_sid, &security_descriptor)) {
      return PROSPERO_STATUS_SYSTEM_ERROR;
    }

    // Root and existing C:\Users/... components are never created or granted
    // write/DACL access. Every step is opened relative to the retained handle.
    current = CreateFileW(volume_root.c_str(),
                          FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                          FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                          nullptr, OPEN_EXISTING,
                          FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                          nullptr);
    if (current == INVALID_HANDLE_VALUE) return StatusFromLastError(GetLastError());
    if (HasReparsePoint(current)) {
      CloseHandle(current);
      return PROSPERO_STATUS_ACCESS_DENIED;
    }

    for (size_t index = 0; index < components.size(); ++index) {
      const bool final_component = index + 1 == components.size();
      HANDLE next = INVALID_HANDLE_VALUE;
      ULONG_PTR information = 0;
      const ACCESS_MASK access = final_component
          ? FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_ADD_FILE | FILE_DELETE_CHILD |
                FILE_READ_ATTRIBUTES | READ_CONTROL | WRITE_DAC | DELETE | SYNCHRONIZE
          : FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
      const prospero_status open_status = OpenRelative(
          api, current, components[index], access,
          FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
          final_component ? kFileOpenIf : kFileOpen,
          kFileDirectoryFile | kFileOpenReparsePoint | kFileSynchronousIoNonalert,
          &next, &information,
          final_component ? security_descriptor.data() : nullptr);
      CloseHandle(current);
      current = INVALID_HANDLE_VALUE;
      if (open_status != PROSPERO_STATUS_OK) return open_status;
      if (HasReparsePoint(next)) {
        CloseHandle(next);
        return PROSPERO_STATUS_ACCESS_DENIED;
      }
      current = next;
    }
    const prospero_status dacl = VerifyCurrentUserOnlyDacl(current, owner_sid);
    if (dacl != PROSPERO_STATUS_OK) {
      CloseHandle(current);
      return dacl;
    }

    auto directory = std::make_shared<StateDirectory>();
    directory->directory = current;
    current = INVALID_HANDLE_VALUE;
    directory->owner_sid = std::move(owner_sid);
    directory->self_relative_security_descriptor = std::move(security_descriptor);
    const uint64_t handle = AllocateStateHandle();
    {
      std::lock_guard<std::mutex> lock(g_state_registry_mutex);
      g_state_directories.emplace(handle, std::move(directory));
    }
    *out_directory = handle;
    return PROSPERO_STATUS_OK;
  } catch (...) {
    if (current != INVALID_HANDLE_VALUE) CloseHandle(current);
    *out_directory = 0;
    return PROSPERO_STATUS_SYSTEM_ERROR;
  }
}

extern "C" prospero_status prospero_secure_state_directory_write_atomic(
    prospero_secure_state_directory_handle directory_handle,
    const wchar_t* file_name,
    const uint8_t* data,
    uint32_t length) {
  if (directory_handle == 0 || !IsStrictStateFileName(file_name) || data == nullptr || length == 0) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  HANDLE temporary = INVALID_HANDLE_VALUE;
  try {
    const std::shared_ptr<StateDirectory> directory = FindStateDirectory(directory_handle);
    const NtApi* api = GetNtApi();
    if (directory == nullptr) return PROSPERO_STATUS_NOT_FOUND;
    if (api == nullptr) return PROSPERO_STATUS_NOT_AVAILABLE;
    std::lock_guard<std::mutex> directory_lock(directory->mutex);
    if (directory->directory == INVALID_HANDLE_VALUE) return PROSPERO_STATUS_NOT_FOUND;

    // If a target already exists, inspect and ACL-verify that direct entry
    // before replacing it. Rename below stays rooted at the retained handle.
    HANDLE existing = INVALID_HANDLE_VALUE;
    const prospero_status existing_status = OpenStateFile(
        api, *directory, file_name, FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
        kFileOpen, kFileNonDirectoryFile, &existing);
    if (existing_status == PROSPERO_STATUS_OK) {
      CloseHandle(existing);
    } else if (existing_status != PROSPERO_STATUS_NOT_FOUND) {
      return existing_status;
    }

    for (uint32_t attempt = 0; attempt < 32; ++attempt) {
      const std::wstring temporary_name = CreateTemporaryName();
      NtUnicodeString unicode{};
      unicode.length = static_cast<USHORT>(temporary_name.size() * sizeof(wchar_t));
      unicode.maximum_length = unicode.length;
      unicode.buffer = const_cast<PWSTR>(temporary_name.c_str());
      NtObjectAttributes attributes{};
      attributes.length = sizeof(attributes);
      attributes.root_directory = directory->directory;
      attributes.object_name = &unicode;
      attributes.attributes = kObjCaseInsensitive;
      // NtCreateFile applies this protected self-relative DACL before the
      // object is visible, eliminating an inherited-ACL exposure window.
      attributes.security_descriptor = directory->self_relative_security_descriptor.data();
      NtIoStatusBlock status_block{};
      const NtStatus create_status = api->create_file(
          &temporary, FILE_WRITE_DATA | FILE_WRITE_ATTRIBUTES | FILE_READ_ATTRIBUTES |
                          READ_CONTROL | WRITE_DAC | DELETE | SYNCHRONIZE,
          &attributes, &status_block, nullptr, FILE_ATTRIBUTE_NORMAL, 0, kFileCreate,
          kFileNonDirectoryFile | kFileOpenReparsePoint | kFileSynchronousIoNonalert |
              kFileWriteThrough,
          nullptr, 0);
      if (NtSucceeded(create_status)) break;
      if (create_status != kStatusObjectNameCollision) return StatusFromNt(create_status);
    }
    if (temporary == INVALID_HANDLE_VALUE) return PROSPERO_STATUS_SYSTEM_ERROR;
    if (HasReparsePoint(temporary)) {
      const prospero_status cleanup = CleanupTemporaryFile(temporary);
      temporary = INVALID_HANDLE_VALUE;
      return cleanup == PROSPERO_STATUS_OK ? PROSPERO_STATUS_ACCESS_DENIED
                                            : PROSPERO_STATUS_SYSTEM_ERROR;
    }
    const prospero_status temporary_dacl =
        VerifyCurrentUserOnlyDacl(temporary, directory->owner_sid);
    if (temporary_dacl != PROSPERO_STATUS_OK) {
      const prospero_status cleanup = CleanupTemporaryFile(temporary);
      temporary = INVALID_HANDLE_VALUE;
      return cleanup == PROSPERO_STATUS_OK ? temporary_dacl : PROSPERO_STATUS_SYSTEM_ERROR;
    }

    uint32_t offset = 0;
    while (offset < length) {
      DWORD written = 0;
      if (!WriteFile(temporary, data + offset, length - offset, &written, nullptr)) {
        const prospero_status write_status = StatusFromLastError(GetLastError());
        const prospero_status cleanup = CleanupTemporaryFile(temporary);
        temporary = INVALID_HANDLE_VALUE;
        return cleanup == PROSPERO_STATUS_OK ? write_status : PROSPERO_STATUS_SYSTEM_ERROR;
      }
      if (written == 0) {
        CleanupTemporaryFile(temporary);
        temporary = INVALID_HANDLE_VALUE;
        return PROSPERO_STATUS_SYSTEM_ERROR;
      }
      offset += written;
    }
    if (!FlushFileBuffers(temporary)) {
      const prospero_status flush_status = StatusFromLastError(GetLastError());
      const prospero_status cleanup = CleanupTemporaryFile(temporary);
      temporary = INVALID_HANDLE_VALUE;
      return cleanup == PROSPERO_STATUS_OK ? flush_status : PROSPERO_STATUS_SYSTEM_ERROR;
    }

    const size_t rename_bytes = offsetof(NtFileRenameInformation, file_name) +
                                ((wcslen(file_name) + 1) * sizeof(wchar_t));
    std::vector<BYTE> rename_storage(rename_bytes);
    NtFileRenameInformation* rename =
        reinterpret_cast<NtFileRenameInformation*>(rename_storage.data());
    rename->replace_if_exists = TRUE;
    rename->root_directory = directory->directory;
    rename->file_name_length = static_cast<ULONG>(wcslen(file_name) * sizeof(wchar_t));
    memcpy(rename->file_name, file_name, rename->file_name_length);
    if (!SetFileInformationByHandle(temporary, FileRenameInfo, rename,
                                    static_cast<DWORD>(rename_storage.size()))) {
      const prospero_status rename_status = StatusFromLastError(GetLastError());
      const prospero_status cleanup = CleanupTemporaryFile(temporary);
      temporary = INVALID_HANDLE_VALUE;
      return cleanup == PROSPERO_STATUS_OK ? rename_status : PROSPERO_STATUS_SYSTEM_ERROR;
    }
    CloseHandle(temporary);
    temporary = INVALID_HANDLE_VALUE;
    return PROSPERO_STATUS_OK;
  } catch (...) {
    if (temporary != INVALID_HANDLE_VALUE) CleanupTemporaryFile(temporary);
    return PROSPERO_STATUS_SYSTEM_ERROR;
  }
}

extern "C" prospero_status prospero_secure_state_directory_read(
    prospero_secure_state_directory_handle directory_handle,
    const wchar_t* file_name,
    prospero_owned_buffer* out_data) {
  if (out_data != nullptr) {
    out_data->data = nullptr;
    out_data->length = 0;
  }
  if (directory_handle == 0 || !IsStrictStateFileName(file_name) || out_data == nullptr) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  HANDLE file = INVALID_HANDLE_VALUE;
  try {
    const std::shared_ptr<StateDirectory> directory = FindStateDirectory(directory_handle);
    const NtApi* api = GetNtApi();
    if (directory == nullptr) return PROSPERO_STATUS_NOT_FOUND;
    if (api == nullptr) return PROSPERO_STATUS_NOT_AVAILABLE;
    std::lock_guard<std::mutex> directory_lock(directory->mutex);
    if (directory->directory == INVALID_HANDLE_VALUE) return PROSPERO_STATUS_NOT_FOUND;
    const prospero_status open_status = OpenStateFile(
        api, *directory, file_name, FILE_READ_DATA | FILE_READ_ATTRIBUTES |
            READ_CONTROL | SYNCHRONIZE,
        kFileOpen, kFileNonDirectoryFile, &file);
    if (open_status != PROSPERO_STATUS_OK) return open_status;
    const prospero_status read_status = ReadAll(file, out_data);
    CloseHandle(file);
    file = INVALID_HANDLE_VALUE;
    return read_status;
  } catch (...) {
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
    ClearOwnedStateBuffer(out_data);
    return PROSPERO_STATUS_SYSTEM_ERROR;
  }
}

extern "C" prospero_status prospero_secure_state_directory_list(
    prospero_secure_state_directory_handle directory_handle,
    prospero_secure_state_entry_list* out_entries) {
  if (out_entries != nullptr) {
    out_entries->entries = nullptr;
    out_entries->count = 0;
  }
  if (directory_handle == 0 || out_entries == nullptr) return PROSPERO_STATUS_INVALID_ARGUMENT;
  try {
    const std::shared_ptr<StateDirectory> directory = FindStateDirectory(directory_handle);
    const NtApi* api = GetNtApi();
    if (directory == nullptr) return PROSPERO_STATUS_NOT_FOUND;
    if (api == nullptr) return PROSPERO_STATUS_NOT_AVAILABLE;
    std::lock_guard<std::mutex> directory_lock(directory->mutex);
    if (directory->directory == INVALID_HANDLE_VALUE) return PROSPERO_STATUS_NOT_FOUND;

    std::vector<std::wstring> names;
    std::vector<BYTE> buffer(64 * 1024);
    BOOLEAN restart_scan = TRUE;
    for (;;) {
      NtIoStatusBlock status_block{};
      const NtStatus query_status = api->query_directory_file(
          directory->directory, nullptr, nullptr, nullptr, &status_block, buffer.data(),
          static_cast<ULONG>(buffer.size()), kFileDirectoryInformation, FALSE, nullptr,
          restart_scan);
      restart_scan = FALSE;
      if (query_status == kStatusNoMoreFiles) break;
      if (!NtSucceeded(query_status)) return StatusFromNt(query_status);
      if (status_block.information == 0 || status_block.information > buffer.size()) {
        return PROSPERO_STATUS_SYSTEM_ERROR;
      }
      size_t offset = 0;
      while (offset < status_block.information) {
        if (status_block.information - offset < offsetof(NtFileDirectoryInformation, file_name)) {
          return PROSPERO_STATUS_SYSTEM_ERROR;
        }
        const NtFileDirectoryInformation* entry =
            reinterpret_cast<const NtFileDirectoryInformation*>(buffer.data() + offset);
        if (entry->file_name_length % sizeof(wchar_t) != 0 ||
            entry->file_name_length > status_block.information - offset -
                                        offsetof(NtFileDirectoryInformation, file_name)) {
          return PROSPERO_STATUS_SYSTEM_ERROR;
        }
        const std::wstring name(entry->file_name,
                                entry->file_name_length / sizeof(wchar_t));
        if (name != L"." && name != L"..") {
          if (!IsStrictStateFileName(name.c_str()) ||
              (entry->file_attributes & (FILE_ATTRIBUTE_DIRECTORY |
                                         FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
            return PROSPERO_STATUS_ACCESS_DENIED;
          }
          HANDLE file = INVALID_HANDLE_VALUE;
          const prospero_status checked = OpenStateFile(
              api, *directory, name.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL |
                  SYNCHRONIZE,
              kFileOpen, kFileNonDirectoryFile, &file);
          if (checked != PROSPERO_STATUS_OK) return checked;
          CloseHandle(file);
          names.push_back(name);
        }
        if (entry->next_entry_offset == 0) break;
        if (entry->next_entry_offset > status_block.information - offset) {
          return PROSPERO_STATUS_SYSTEM_ERROR;
        }
        offset += entry->next_entry_offset;
      }
    }
    return BuildEntryList(names, out_entries);
  } catch (...) {
    ClearStateEntryList(out_entries);
    return PROSPERO_STATUS_SYSTEM_ERROR;
  }
}

extern "C" prospero_status prospero_secure_state_directory_remove(
    prospero_secure_state_directory_handle directory_handle,
    const wchar_t* file_name) {
  if (directory_handle == 0 || !IsStrictStateFileName(file_name)) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  HANDLE file = INVALID_HANDLE_VALUE;
  try {
    const std::shared_ptr<StateDirectory> directory = FindStateDirectory(directory_handle);
    const NtApi* api = GetNtApi();
    if (directory == nullptr) return PROSPERO_STATUS_NOT_FOUND;
    if (api == nullptr) return PROSPERO_STATUS_NOT_AVAILABLE;
    std::lock_guard<std::mutex> directory_lock(directory->mutex);
    if (directory->directory == INVALID_HANDLE_VALUE) return PROSPERO_STATUS_NOT_FOUND;
    const prospero_status open_status = OpenStateFile(
        api, *directory, file_name, DELETE | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
        kFileOpen, kFileNonDirectoryFile, &file);
    if (open_status != PROSPERO_STATUS_OK) return open_status;
    FILE_DISPOSITION_INFO disposition{};
    disposition.DeleteFile = TRUE;
    if (!SetFileInformationByHandle(file, FileDispositionInfo, &disposition,
                                    static_cast<DWORD>(sizeof(disposition)))) {
      const prospero_status status = StatusFromLastError(GetLastError());
      CloseHandle(file);
      file = INVALID_HANDLE_VALUE;
      return status;
    }
    CloseHandle(file);
    file = INVALID_HANDLE_VALUE;
    return PROSPERO_STATUS_OK;
  } catch (...) {
    if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
    return PROSPERO_STATUS_SYSTEM_ERROR;
  }
}

extern "C" void prospero_secure_state_entry_list_release(
    prospero_secure_state_entry_list* entries) {
  ClearStateEntryList(entries);
}

extern "C" prospero_status prospero_secure_state_directory_close(
    prospero_secure_state_directory_handle directory_handle) {
  if (directory_handle == 0) return PROSPERO_STATUS_INVALID_ARGUMENT;
  std::shared_ptr<StateDirectory> directory;
  {
    std::lock_guard<std::mutex> lock(g_state_registry_mutex);
    const auto found = g_state_directories.find(directory_handle);
    if (found == g_state_directories.end()) return PROSPERO_STATUS_NOT_FOUND;
    directory = found->second;
    g_state_directories.erase(found);
  }
  std::lock_guard<std::mutex> directory_lock(directory->mutex);
  if (directory->directory != INVALID_HANDLE_VALUE) {
    CloseHandle(directory->directory);
    directory->directory = INVALID_HANDLE_VALUE;
  }
  return PROSPERO_STATUS_OK;
}

#else

extern "C" prospero_status prospero_secure_state_directory_open(
    const prospero_secure_state_directory_options* options,
    prospero_secure_state_directory_handle* out_directory) {
  if (options == nullptr || options->absolute_path == nullptr || out_directory == nullptr) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  *out_directory = 0;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_secure_state_directory_write_atomic(
    prospero_secure_state_directory_handle directory,
    const wchar_t* file_name,
    const uint8_t* data,
    uint32_t length) {
  if (directory == 0 || !IsStrictStateFileName(file_name) || data == nullptr || length == 0) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_secure_state_directory_read(
    prospero_secure_state_directory_handle directory,
    const wchar_t* file_name,
    prospero_owned_buffer* out_data) {
  if (directory == 0 || !IsStrictStateFileName(file_name) || out_data == nullptr) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  out_data->data = nullptr;
  out_data->length = 0;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_secure_state_directory_list(
    prospero_secure_state_directory_handle directory,
    prospero_secure_state_entry_list* out_entries) {
  if (directory == 0 || out_entries == nullptr) return PROSPERO_STATUS_INVALID_ARGUMENT;
  out_entries->entries = nullptr;
  out_entries->count = 0;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_secure_state_directory_remove(
    prospero_secure_state_directory_handle directory,
    const wchar_t* file_name) {
  if (directory == 0 || !IsStrictStateFileName(file_name)) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" void prospero_secure_state_entry_list_release(
    prospero_secure_state_entry_list* entries) {
  if (entries == nullptr) return;
  entries->entries = nullptr;
  entries->count = 0;
}

extern "C" prospero_status prospero_secure_state_directory_close(
    prospero_secure_state_directory_handle directory) {
  return directory == 0 ? PROSPERO_STATUS_INVALID_ARGUMENT : PROSPERO_STATUS_NOT_AVAILABLE;
}

#endif
