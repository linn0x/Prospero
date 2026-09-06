/** The native backdrop and renderer surfaces must agree on accessibility. */
export interface WindowAppearance {
  nativeGlass: boolean;
  reducedTransparency: boolean;
  highContrast: boolean;
}

export function windowAppearance(
  platform: string,
  preferences: {
    prefersReducedTransparency: boolean;
    shouldUseHighContrastColors: boolean;
    inForcedColorsMode: boolean;
  },
): WindowAppearance {
  const reducedTransparency = preferences.prefersReducedTransparency;
  const highContrast = preferences.shouldUseHighContrastColors || preferences.inForcedColorsMode;
  return { nativeGlass: platform === "darwin" && !reducedTransparency && !highContrast, reducedTransparency, highContrast };
}
