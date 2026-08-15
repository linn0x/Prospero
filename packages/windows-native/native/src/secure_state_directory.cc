#include "prospero_windows_native.h"

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
  if (directory == 0 || file_name == nullptr || data == nullptr || length == 0) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  if (file_name[0] == L'\0' || wcschr(file_name, L'\\') != nullptr ||
      wcschr(file_name, L'/') != nullptr || wcscmp(file_name, L".") == 0 ||
      wcscmp(file_name, L"..") == 0) {
    return PROSPERO_STATUS_INVALID_ARGUMENT;
  }
  // Production accepts only one relative filename, creates a unique temporary
  // file in this same verified directory, rejects reparse points, FlushFileBuffers,
  // then uses a write-through atomic replacement without path re-resolution.
  return PROSPERO_STATUS_NOT_AVAILABLE;
}

extern "C" prospero_status prospero_secure_state_directory_close(
    prospero_secure_state_directory_handle directory) {
  if (directory == 0) return PROSPERO_STATUS_INVALID_ARGUMENT;
  return PROSPERO_STATUS_NOT_AVAILABLE;
}
