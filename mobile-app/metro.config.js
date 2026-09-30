const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.watchFolders = config.watchFolders ?? [];

// Tell Metro not to watch node_modules android/.gradle dirs
config.resolver.blockList = [
  /node_modules\/.*\/android\/.gradle\/.*/,
  ...(config.resolver.blockList ?? []),
];

module.exports = config;