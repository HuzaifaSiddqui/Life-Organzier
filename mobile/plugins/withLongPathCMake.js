/**
 * Pins the app's native (CMake) build to CMake 4.1.2 from the Android SDK.
 *
 * Why: the default CMake 3.22.1 ships ninja 1.10, which cannot handle Windows paths longer than
 * 260 characters. React Native's codegen object files embed the project path twice, so deep
 * project folders fail with "Filename longer than 260 characters". CMake 4.1.2 ships ninja 1.12,
 * which supports long paths when Windows "LongPathsEnabled" is on.
 *
 * Requires: Android SDK → SDK Tools → CMake 4.1.2 installed, and LongPathsEnabled = 1.
 */
const { withAppBuildGradle } = require("expo/config-plugins");

const CMAKE_VERSION = "4.1.2";
const MARKER = "// withLongPathCMake";

module.exports = function withLongPathCMake(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (!cfg.modResults.contents.includes(MARKER)) {
      cfg.modResults.contents = cfg.modResults.contents.replace(
        /^android\s*\{/m,
        `android {\n    ${MARKER}: long-path-capable ninja (Windows 260-char limit)\n    externalNativeBuild { cmake { version "${CMAKE_VERSION}" } }`,
      );
    }
    return cfg;
  });
};
