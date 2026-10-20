// src/components/Logo.tsx — the PresencePro logo (assets/logo.png already contains the wordmark).
// Keeps the image's own aspect ratio, so any logo shape works; only the width is chosen here.
import React from "react";
import { Image } from "react-native";

// src/components -> project root -> assets/logo.png
const SOURCE = require("../../assets/logo.png");

export default function Logo({ width = 250 }: { width?: number }) {
  let ratio = 1;
  try {
    const a = Image.resolveAssetSource(SOURCE);
    if (a?.width && a?.height) ratio = a.width / a.height;
  } catch {}
  return (
    <Image
      source={SOURCE}
      style={{ width, height: width / ratio }}
      resizeMode="contain"
      accessibilityRole="image"
      accessibilityLabel="PresencePro"
    />
  );
}