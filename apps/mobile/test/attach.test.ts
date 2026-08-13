import { beforeEach, describe, expect, it, vi } from "vitest";

const picker = vi.hoisted(() => ({
  requestMediaLibraryPermissionsAsync: vi.fn(),
  requestCameraPermissionsAsync: vi.fn(),
  launchImageLibraryAsync: vi.fn(),
  launchCameraAsync: vi.fn(),
  getPendingResultAsync: vi.fn(),
}));

const manipulation = vi.hoisted(() => ({
  manipulate: vi.fn(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() },
}));
vi.mock("expo-image-picker", () => picker);
vi.mock("expo-image-manipulator", () => ({
  ImageManipulator: manipulation,
  SaveFormat: { JPEG: "jpeg" },
}));
vi.mock("expo-file-system", () => ({
  Paths: { cache: {} },
  Directory: class {
    exists = false;
    create = vi.fn();
    constructor(..._parts: unknown[]) {}
  },
  File: class {
    uri: string;
    constructor(...parts: unknown[]) { this.uri = String(parts.at(-1) ?? "file:///out.jpg"); }
    copy = vi.fn(async () => undefined);
  },
}));

import { pickFromCamera, pickFromLibrary, recoverPendingPickerResult } from "../src/lib/attach";
import AsyncStorage from "@react-native-async-storage/async-storage";

const granted = { granted: true, canAskAgain: true };
const asset = { uri: "file:///source.jpg", width: 100, height: 100, fileName: "source.jpg" };
let storedContext: string | null = null;

function mockNormalize(dataB64 = "AQID") {
  const saveAsync = vi.fn(async () => ({ uri: "file:///manipulated.jpg", base64: dataB64 }));
  manipulation.manipulate.mockReturnValue({ renderAsync: vi.fn(async () => ({ saveAsync })), resize: vi.fn() });
}

describe("attachment picker result union", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storedContext = null;
    vi.mocked(AsyncStorage.getItem).mockImplementation(async () => storedContext);
    vi.mocked(AsyncStorage.setItem).mockImplementation(async (_key, value) => { storedContext = value; });
    vi.mocked(AsyncStorage.removeItem).mockImplementation(async () => { storedContext = null; });
    picker.requestMediaLibraryPermissionsAsync.mockResolvedValue(granted);
    picker.requestCameraPermissionsAsync.mockResolvedValue(granted);
    mockNormalize();
  });

  it("returns selected after normalizing a library image", async () => {
    picker.launchImageLibraryAsync.mockResolvedValue({ canceled: false, assets: [asset] });
    await expect(pickFromLibrary(6)).resolves.toMatchObject({
      status: "selected",
      source: "library",
      images: [{ mimeType: "image/jpeg", dataB64: "AQID" }],
    });
  });

  it("keeps a real picker cancellation silent and explicit", async () => {
    picker.launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null });
    await expect(pickFromLibrary(6)).resolves.toEqual({ status: "cancelled", source: "library" });
    expect(picker.launchCameraAsync).not.toHaveBeenCalled();
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  it("cleans an Android pending context after normal return, cancellation, and error", async () => {
    const context = { hostId: "host", sid: "sid", source: "library" as const, createdAt: 1 };
    picker.launchImageLibraryAsync.mockResolvedValue({ canceled: false, assets: [asset] });
    await pickFromLibrary(1, context);
    expect(storedContext).toBeNull();

    picker.launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null });
    await pickFromLibrary(1, context);
    expect(storedContext).toBeNull();

    picker.launchImageLibraryAsync.mockRejectedValue(new Error("picker failed"));
    await pickFromLibrary(1, context);
    expect(storedContext).toBeNull();
  });

  it("distinguishes permission denial that may be requested again from Settings-only denial", async () => {
    picker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: true });
    await expect(pickFromLibrary(1)).resolves.toEqual({
      status: "permission_denied", source: "library", canAskAgain: true,
    });

    picker.requestCameraPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: false });
    await expect(pickFromCamera()).resolves.toEqual({
      status: "permission_denied", source: "camera", canAskAgain: false,
    });
  });

  it("returns an accessible error state for picker failures", async () => {
    picker.launchCameraAsync.mockRejectedValue(new Error("camera unavailable"));
    await expect(pickFromCamera()).resolves.toEqual({
      status: "error", source: "camera", message: "camera unavailable",
    });
  });

  it("normalizes Android's recovered pending result through the same pipeline", async () => {
    picker.getPendingResultAsync.mockResolvedValue({ canceled: false, assets: [asset] });
    await expect(recoverPendingPickerResult("library", 1)).resolves.toMatchObject({
      status: "selected",
      source: "library",
      images: [{ dataB64: "AQID", mimeType: "image/jpeg" }],
    });
  });
});
