#include <node_api.h>

#include "prospero_windows_native.h"

namespace {

napi_value ThrowNotAvailable(napi_env env, napi_callback_info info) {
  (void)info;
  napi_throw_error(env, "PROSPERO_NATIVE_NOT_AVAILABLE",
                   "Windows native implementation is not available in this skeleton build");
  return nullptr;
}

bool SetUint32(napi_env env, napi_value object, const char* name, uint32_t value) {
  napi_value js_value;
  return napi_create_uint32(env, value, &js_value) == napi_ok &&
         napi_set_named_property(env, object, name, js_value) == napi_ok;
}

bool SetBool(napi_env env, napi_value object, const char* name, bool value) {
  napi_value js_value;
  return napi_get_boolean(env, value, &js_value) == napi_ok &&
         napi_set_named_property(env, object, name, js_value) == napi_ok;
}

bool SetString(napi_env env, napi_value object, const char* name, const char* value) {
  napi_value js_value;
  return napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &js_value) == napi_ok &&
         napi_set_named_property(env, object, name, js_value) == napi_ok;
}

napi_value GetAbiInfo(napi_env env, napi_callback_info info) {
  (void)info;
  prospero_capability_report native_report;
  if (prospero_query_capability_report(&native_report) != PROSPERO_STATUS_OK) {
    napi_throw_error(env, "PROSPERO_NATIVE_INTERNAL", "Could not query native ABI report");
    return nullptr;
  }
  napi_value report;
  napi_value capabilities;
  if (napi_create_object(env, &report) != napi_ok || napi_create_object(env, &capabilities) != napi_ok) {
    return nullptr;
  }
  // Skeleton policy: no unimplemented unit can ever advertise a usable feature.
  if (!SetUint32(env, report, "abiVersion", native_report.abi_version) ||
      !SetUint32(env, report, "napiVersion", native_report.napi_version) ||
      !SetString(env, report, "platform", "win32") ||
#if defined(_M_ARM64) || defined(__aarch64__)
      !SetString(env, report, "arch", "arm64") ||
#else
      !SetString(env, report, "arch", "x64") ||
#endif
      !SetString(env, report, "buildId", "skeleton-untrusted") ||
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

bool ExportMethod(napi_env env, napi_value exports, const char* name, napi_callback callback) {
  napi_value function;
  return napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, nullptr, &function) == napi_ok &&
         napi_set_named_property(env, exports, name, function) == napi_ok;
}

}  // namespace

extern "C" prospero_status prospero_query_capability_report(
    prospero_capability_report* out_report) {
  if (out_report == nullptr) return PROSPERO_STATUS_INVALID_ARGUMENT;
  out_report->abi_version = PROSPERO_WINDOWS_NATIVE_ABI_VERSION;
  out_report->napi_version = PROSPERO_WINDOWS_NATIVE_NAPI_VERSION;
  // This skeleton has no production implementation. It must never claim a
  // feature merely because an export name has been reserved.
  out_report->capability_mask = 0;
  return PROSPERO_STATUS_OK;
}

NAPI_MODULE_INIT() {
  if (!ExportMethod(env, exports, "getAbiInfo", GetAbiInfo) ||
      !ExportMethod(env, exports, "getCurrentProcessIdentity", ThrowNotAvailable) ||
      !ExportMethod(env, exports, "getProcessIdentity", ThrowNotAvailable) ||
      !ExportMethod(env, exports, "matchesProcessIdentity", ThrowNotAvailable) ||
      !ExportMethod(env, exports, "createSecureNamedPipeServer", ThrowNotAvailable) ||
      !ExportMethod(env, exports, "acceptSecureNamedPipeConnection", ThrowNotAvailable) ||
      !ExportMethod(env, exports, "closeSecureNamedPipeServer", ThrowNotAvailable) ||
      !ExportMethod(env, exports, "readSecureNamedPipeConnection", ThrowNotAvailable) ||
      !ExportMethod(env, exports, "writeSecureNamedPipeConnection", ThrowNotAvailable) ||
      !ExportMethod(env, exports, "getSecureNamedPipePeerIdentity", ThrowNotAvailable) ||
      !ExportMethod(env, exports, "disconnectSecureNamedPipeConnection", ThrowNotAvailable) ||
      !ExportMethod(env, exports, "closeSecureNamedPipeConnection", ThrowNotAvailable) ||
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
      !ExportMethod(env, exports, "dpapiProtectCurrentUser", ThrowNotAvailable) ||
      !ExportMethod(env, exports, "dpapiUnprotectCurrentUser", ThrowNotAvailable) ||
      !ExportMethod(env, exports, "openSecureStateDirectory", ThrowNotAvailable) ||
      !ExportMethod(env, exports, "writeSecureStateFileAtomically", ThrowNotAvailable) ||
      !ExportMethod(env, exports, "closeSecureStateDirectory", ThrowNotAvailable)) {
    return nullptr;
  }
  return exports;
}
