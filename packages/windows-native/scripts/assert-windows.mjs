if (process.platform !== "win32") {
  console.error("@prospero/windows-native native build/test is Windows-only (win32 x64 or arm64).");
  process.exit(1);
}
if (process.arch !== "x64" && process.arch !== "arm64") {
  console.error(`Unsupported Windows native architecture: ${process.arch}`);
  process.exit(1);
}
