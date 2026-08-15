#include "prospero_file_rename_layout.h"

#include <cstddef>

namespace {

constexpr size_t kManifestNameBytes = (sizeof(u"manifest.json") - sizeof(char16_t));
constexpr size_t kRequiredManifestBufferBytes =
    prospero_file_rename_layout::FileRenameInfoBufferBytes(kManifestNameBytes);
constexpr auto kSameDirectoryManifestRequest =
    prospero_file_rename_layout::MakeSameDirectoryRenameRequest<uint64_t>(
        static_cast<uint32_t>(kManifestNameBytes));

// This is the exact regression that caused SetFileInformationByHandle to
// reject the first secure-state write on Windows. A trailing NUL plus offsetof
// is two bytes short of the SDK contract on Windows x64 and arm64.
constexpr size_t kHistoricalShortBufferBytes =
    offsetof(prospero_file_rename_layout::Windows64FileRenameInfo, file_name) +
    kManifestNameBytes + sizeof(char16_t);

static_assert(kManifestNameBytes == 26, "manifest name UTF-16 byte count changed");
static_assert(kRequiredManifestBufferBytes == 50,
              "FILE_RENAME_INFO buffer must include the SDK structure size");
static_assert(kHistoricalShortBufferBytes == 48,
              "historical short allocation must remain distinguishable");
static_assert(kRequiredManifestBufferBytes > kHistoricalShortBufferBytes,
              "FILE_RENAME_INFO allocation must not regress to offsetof plus NUL");
static_assert(prospero_file_rename_layout::FileRenameInfoBufferBytes(0) == 24,
              "an empty name still carries the complete fixed layout");
static_assert(kSameDirectoryManifestRequest.replace_if_exists == 1,
              "atomic state writes must replace an existing direct target");
static_assert(kSameDirectoryManifestRequest.root_directory == 0,
              "a simple same-directory target name requires a NULL RootDirectory");
static_assert(kSameDirectoryManifestRequest.file_name_length == kManifestNameBytes,
              "the rename request must use the exact UTF-16 name byte count");

}  // namespace

int main() { return 0; }
