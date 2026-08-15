#include "prospero_windows_native.h"

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
  // Windows reserves these names even when an extension follows (for example,
  // CON.json). Trim spaces before an extension as Win32 name normalization can
  // otherwise turn COM1 .json into the COM1 device.
  uint32_t stem_length = 0;
  while (file_name[stem_length] != L'\0' && file_name[stem_length] != L'.') {
    ++stem_length;
  }
  while (stem_length > 0 && file_name[stem_length - 1] == L' ') {
    --stem_length;
  }

  if (IsAsciiEqualIgnoreCase(file_name, stem_length, L"CON") ||
      IsAsciiEqualIgnoreCase(file_name, stem_length, L"PRN") ||
      IsAsciiEqualIgnoreCase(file_name, stem_length, L"AUX") ||
      IsAsciiEqualIgnoreCase(file_name, stem_length, L"NUL")) {
    return true;
  }
  if (stem_length == 4 &&
      (IsAsciiEqualIgnoreCase(file_name, 3, L"COM") ||
       IsAsciiEqualIgnoreCase(file_name, 3, L"LPT")) &&
      file_name[3] >= L'1' && file_name[3] <= L'9') {
    return true;
  }
  return false;
}

bool IsStrictStateFileName(const wchar_t* file_name) {
  if (file_name == nullptr || file_name[0] == L'\0' ||
      wcscmp(file_name, L".") == 0 || wcscmp(file_name, L"..") == 0) {
    return false;
  }

  uint32_t length = 0;
  for (; file_name[length] != L'\0'; ++length) {
    const wchar_t character = file_name[length];
    // ':' rejects NTFS alternate data streams. The rest are separators,
    // Win32 metacharacters, or control characters which do not name a stable
    // single file. A single segment is deliberately stricter than a path.
    if (character < 0x20 || character == L'\\' || character == L'/' ||
        character == L':' || character == L'<' || character == L'>' ||
        character == L'"' || character == L'|' || character == L'?' ||
        character == L'*') {
      return false;
    }
  }
  if (file_name[length - 1] == L'.' || file_name[length - 1] == L' ') return false;
  return !IsReservedDosDeviceName(file_name);
}

}  // namespace

extern "C" prospero_status prospero_secure_state_directory_open(
    const prospero_secure_state_directory_options* options,
    prospero_secure_state_directory_handle* out_directory) {
  if (options == nullptr || options->absolute_path == nullptr || out_directory == nullptr) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  // Production walks the absolute path component-by-component using handles
  // opened with FILE_FLAG_OPEN_REPARSE_POINT, rejects all reparse points, and
  // creates/verifies an explicit current-user-only DACL before returning a
  // handle. Default or inherited ACLs are not sufficient.
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
  // Production accepts only one relative filename, creates a unique temporary
  // file in this same verified directory, rejects reparse points, FlushFileBuffers,
  // then uses a write-through atomic replacement without path re-resolution.
  // It opens every target with FILE_FLAG_OPEN_REPARSE_POINT and fails closed
  // if FILE_ATTRIBUTE_REPARSE_POINT is present.
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
  // Production opens only through the retained directory handle with
  // FILE_FLAG_OPEN_REPARSE_POINT, rejects FILE_ATTRIBUTE_REPARSE_POINT, then
  // reads the already-validated direct entry into an ABI-owned buffer.
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_secure_state_directory_list(
    prospero_secure_state_directory_handle directory,
    prospero_secure_state_entry_list* out_entries) {
  if (directory == 0 || out_entries == nullptr) return PROSPERO_STATUS_INVALID_ARGUMENT;
  out_entries->entries = nullptr;
  out_entries->count = 0;
  // Production enumerates direct entries relative to the retained directory
  // handle. It validates every returned name with IsStrictStateFileName and
  // fails closed on any reparse point rather than returning a traversable name.
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_secure_state_directory_remove(
    prospero_secure_state_directory_handle directory,
    const wchar_t* file_name) {
  if (directory == 0 || !IsStrictStateFileName(file_name)) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  // Production opens the direct target with FILE_FLAG_OPEN_REPARSE_POINT,
  // rejects it if it is a reparse point, and deletes by the retained handle.
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" void prospero_secure_state_entry_list_release(
    prospero_secure_state_entry_list* entries) {
  if (entries == nullptr) return;
  // The skeleton never allocates. A production implementation releases only
  // ABI-owned allocations here and clears both fields afterwards.
  entries->entries = nullptr;
  entries->count = 0;
}

extern "C" prospero_status prospero_secure_state_directory_close(
    prospero_secure_state_directory_handle directory) {
  if (directory == 0) return PROSPERO_STATUS_INVALID_ARGUMENT;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}
