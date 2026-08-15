#ifndef PROSPERO_FILE_RENAME_LAYOUT_H_
#define PROSPERO_FILE_RENAME_LAYOUT_H_

#include <cstddef>
#include <cstdint>
#include <limits>

// FILE_RENAME_INFO has a one-element trailing array, so sizeof includes the
// ABI's final alignment padding. The native code intentionally follows the
// documented `sizeof(FILE_RENAME_INFO) + FileNameLength` allocation rule,
// rather than deriving a shorter buffer from offsetof(FileName).
//
// Keep a portable Windows-64 model here so the allocation rule is regression
// tested on non-Windows hosts too. Windows x64 and arm64 both use this layout.
namespace prospero_file_rename_layout {

struct Windows64FileRenameInfo {
  uint8_t replace_if_exists;
  uint64_t root_directory;
  uint32_t file_name_length;
  char16_t file_name[1];
};

static_assert(offsetof(Windows64FileRenameInfo, replace_if_exists) == 0,
              "FILE_RENAME_INFO ReplaceIfExists must begin the buffer");
static_assert(offsetof(Windows64FileRenameInfo, root_directory) == 8,
              "Windows x64/arm64 FILE_RENAME_INFO RootDirectory offset changed");
static_assert(offsetof(Windows64FileRenameInfo, file_name_length) == 16,
              "Windows x64/arm64 FILE_RENAME_INFO FileNameLength offset changed");
static_assert(offsetof(Windows64FileRenameInfo, file_name) == 20,
              "Windows x64/arm64 FILE_RENAME_INFO FileName offset changed");
static_assert(sizeof(Windows64FileRenameInfo) == 24,
              "Windows x64/arm64 FILE_RENAME_INFO size changed");

constexpr size_t FileRenameInfoBufferBytes(size_t file_name_bytes) {
  return file_name_bytes <=
                 std::numeric_limits<size_t>::max() - sizeof(Windows64FileRenameInfo)
             ? sizeof(Windows64FileRenameInfo) + file_name_bytes
             : 0;
}

}  // namespace prospero_file_rename_layout

#endif  // PROSPERO_FILE_RENAME_LAYOUT_H_
