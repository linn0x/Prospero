{
  "targets": [
    {
      "target_name": "prospero_windows_native",
      "sources": [
        "native/src/addon.cc",
        "native/src/secure_named_pipe.cc",
        "native/src/process_identity.cc",
        "native/src/job_object.cc",
        "native/src/detached_host.cc",
        "native/src/conpty.cc",
        "native/src/dpapi.cc",
        "native/src/secure_state_directory.cc"
      ],
      "include_dirs": ["native/include"],
      "defines": ["NAPI_VERSION=8", "WIN32_LEAN_AND_MEAN", "UNICODE", "_UNICODE"],
      "conditions": [
        [
          "OS=='win'",
          {
            "libraries": ["advapi32.lib", "crypt32.lib", "userenv.lib"]
          },
          {
            "type": "none"
          }
        ]
      ]
    }
  ]
}
