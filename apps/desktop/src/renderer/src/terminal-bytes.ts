export function terminalBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export function terminalBinaryBase64(value: string): string {
  return btoa(value);
}
