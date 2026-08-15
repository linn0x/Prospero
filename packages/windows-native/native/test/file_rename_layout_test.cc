#include "prospero_file_rename_layout.h"

#include <cstddef>

namespace {

constexpr size_t kManifestNameBytes = (sizeof(u"manifest.json") - sizeof(char16_t));
constexpr size_t kRequiredManifestBufferBytes =
    prospero_file_rename_layout::FileRenameInformationBufferBytes(kManifestNameBytes);
constexpr auto kNtSetInformationFileManifestRequest =
    prospero_file_rename_layout::MakeNtSetInformationFileRenameRequest<uint64_t>(
        static_cast<uint32_t>(kManifestNameBytes));

// This is the exact regression that caused the native rename request to be
// rejected on the first secure-state write on Windows. A trailing NUL plus
// offsetof is two bytes short of the WDK contract on Windows x64 and arm64.
constexpr size_t kHistoricalShortBufferBytes =
    offsetof(prospero_file_rename_layout::Windows64FileRenameInformation, file_name) +
    kManifestNameBytes + sizeof(char16_t);

static_assert(kManifestNameBytes == 26, "manifest name UTF-16 byte count changed");
static_assert(kRequiredManifestBufferBytes == 50,
              "FILE_RENAME_INFORMATION buffer must include the WDK structure size");
static_assert(kHistoricalShortBufferBytes == 48,
              "historical short allocation must remain distinguishable");
static_assert(kRequiredManifestBufferBytes > kHistoricalShortBufferBytes,
              "FILE_RENAME_INFORMATION allocation must not regress to offsetof plus NUL");
static_assert(prospero_file_rename_layout::FileRenameInformationBufferBytes(0) == 24,
              "an empty name still carries the complete fixed layout");
static_assert(prospero_file_rename_layout::kFileRenameInformation == 10,
              "WDK FileRenameInformation must remain class 10");
static_assert(kNtSetInformationFileManifestRequest.information_class ==
                  prospero_file_rename_layout::kFileRenameInformation,
              "NtSetInformationFile must use FileRenameInformation (10)");
static_assert(kNtSetInformationFileManifestRequest.rename.replace_if_exists == 1,
              "atomic state writes must replace an existing direct target");
static_assert(kNtSetInformationFileManifestRequest.rename.root_directory == 0,
              "a simple same-directory target name requires a NULL RootDirectory");
static_assert(kNtSetInformationFileManifestRequest.rename.file_name_length == kManifestNameBytes,
              "the rename request must use the exact UTF-16 name byte count");

}  // namespace

int main() { return 0; }
