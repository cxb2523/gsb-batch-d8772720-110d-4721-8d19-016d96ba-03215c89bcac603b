// Test-run defaults (loaded with --import before the runner spawns test
// files, which inherit this environment): the suite drives its own
// CDP-launched browsers, never the developer's signed-in Chrome — the auto
// backend would pick it whenever the axuse extension is connected.
process.env.AXUSE_BACKEND ??= "cdp";
