const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// expo-sqlite's web implementation loads a wa-sqlite .wasm binary - without
// this, Metro tries to resolve it as a JS module (it isn't one) and fails to
// bundle anything that transitively imports expo-sqlite, including for a
// server-only "eas deploy" web export where the actual SQLite code never
// runs (this app's local storage is native-only) but still gets bundled
// because Metro doesn't distinguish "used at runtime" from "reachable via
// the root layout's import graph".
config.resolver.assetExts.push('wasm');

module.exports = config;
