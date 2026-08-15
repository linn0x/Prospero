#ifndef PROSPERO_FILE_RENAME_LAYOUT_H_
#define PROSPERO_FILE_RENAME_LAYOUT_H_

#include <cstddef>
#include <cstdint>
#include <limits>

// FILE_RENAME_INFORMATION has a one-element trailing array, so sizeof
// includes the ABI's final alignment padding. The native NtSetInformationFile
// path intentionally follows the documented
// `sizeof(FILE_RENAME_INFORMATION) + FileNameLength` allocation rule, rather
// than deriving a shorter buffer from offsetof(FileName).
//
// Keep a portable Windows-64 model here so the allocation rule is regression
// tested on non-Windows hosts too. Windows x64 and arm64 both use this layout.
namespace prospero_file_rename_layout {

struct Windows64FileRenameInformation {
  uint8_t replace_if_exists;
  uint64_t root_directory;
  uint32_t file_name_length;
  char16_t file_name[1];
};

static_assert(offsetof(Windows64FileRenameInformation, replace_if_exists) == 0,
              "FILE_RENAME_INFORMATION ReplaceIfExists must begin the buffer");
static_assert(offsetof(Windows64FileRenameInformation, root_directory) == 8,
              "Windows x64/arm64 FILE_RENAME_INFORMATION RootDirectory offset changed");
static_assert(offsetof(Windows64FileRenameInformation, file_name_length) == 16,
              "Windows x64/arm64 FILE_RENAME_INFORMATION FileNameLength offset changed");
static_assert(offsetof(Windows64FileRenameInformation, file_name) == 20,
              "Windows x64/arm64 FILE_RENAME_INFORMATION FileName offset changed");
static_assert(sizeof(Windows64FileRenameInformation) == 24,
              "Windows x64/arm64 FILE_RENAME_INFORMATION size changed");

// FILE_INFORMATION_CLASS::FileRenameInformation used by
// NtSetInformationFile. Keep this WDK ABI value independent of SDK headers so
// this request can be checked by the portable C++ regression test too.
constexpr uint32_t kFileRenameInformation = 10;

// A simple target name renames an already-open file within its current
// directory. Microsoft requires RootDirectory to be NULL for that request;
// the parent directory is therefore anchored by the source file handle, not
// by the process current directory or a path lookup.
//
// Keep this request construction portable so the policy is covered by the
// strict non-Windows C++ regression test as well as the Windows round trip.
template <typename RootDirectory>
struct SameDirectoryRenameRequest {
  uint8_t replace_if_exists;
  RootDirectory root_directory;
  uint32_t file_name_length;
};

template <typename RootDirectory>
constexpr SameDirectoryRenameRequest<RootDirectory> MakeSameDirectoryRenameRequest(
    uint32_t file_name_length) {
  return {1, RootDirectory{}, file_name_length};
}

template <typename RootDirectory>
struct NtSetInformationFileRenameRequest {
  uint32_t information_class;
  SameDirectoryRenameRequest<RootDirectory> rename;
};

template <typename RootDirectory>
constexpr NtSetInformationFileRenameRequest<RootDirectory>
MakeNtSetInformationFileRenameRequest(uint32_t file_name_length) {
  return {kFileRenameInformation,
          MakeSameDirectoryRenameRequest<RootDirectory>(file_name_length)};
}

constexpr size_t FileRenameInformationBufferBytes(size_t file_name_bytes) {
  return file_name_bytes <=
                 std::numeric_limits<size_t>::max() - sizeof(Windows64FileRenameInformation)
             ? sizeof(Windows64FileRenameInformation) + file_name_bytes
             : 0;
}

}  // namespace prospero_file_rename_layout

#endif  // PROSPERO_FILE_RENAME_LAYOUT_H_
