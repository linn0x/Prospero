const path = require("node:path");

const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Expo's default exclusions for these directories are relative-path patterns.
// The Windows fallback watcher can report absolute paths instead, which lets
// transient Gradle directories enter the crawl and crash Metro when Gradle
// removes them. Add absolute exclusions for this project's generated trees.
const generatedDirectories = [
  path.join(__dirname, "android"),
  path.join(__dirname, "build"),
  path.join(__dirname, ".cache", "voice"),
];

config.resolver.blockList = [
  ...(Array.isArray(config.resolver.blockList)
    ? config.resolver.blockList
    : [config.resolver.blockList].filter(Boolean)),
  ...generatedDirectories.map(
    (directory) => new RegExp(`^${escapeRegExp(directory)}(?:[\\\\/]|$)`),
  ),
];

module.exports = config;
