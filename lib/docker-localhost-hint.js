"use strict";

// Test Provider failures against a local endpoint are often just "Node-RED
// itself runs in Docker" -- "localhost"/"127.0.0.1" inside that container
// means the container, not the host machine where Ollama/LM Studio/etc.
// actually listens. Appended to the Test Provider error message whenever
// the configured baseUrl's host is literally "localhost" or "127.0.0.1" --
// a narrower, simpler check than "is this a private network address"
// (ADR-013's isPrivateNetworkHost): a real LAN IP like 192.168.1.15 needs
// no such hint, since it already means something concrete regardless of
// where Node-RED itself happens to be running.
//
// A standalone module (not part of flowpilot.js itself) so it has a real,
// re-executable unit test independent of either branch's module.exports
// shape -- main and hotfix/0.6.3 structure flowpilot.js's own exports
// differently, but both can require() a small lib/*.js module identically.
const DOCKER_LOCALHOST_HINT = "If Node-RED runs in Docker, \"localhost\" refers to the Node-RED container itself — use the host machine's IP address instead.";

function isLocalhostHost(rawBaseUrl) {
  let hostname;
  try {
    hostname = new URL(String(rawBaseUrl || "")).hostname.toLowerCase();
  } catch (err) {
    return false;
  }
  return hostname === "localhost" || hostname === "127.0.0.1";
}

// Returns the hint text, with a leading space so it can be concatenated
// directly onto an existing error message, when baseUrl's host is
// localhost/127.0.0.1 -- "" otherwise (safe to always append unconditionally).
function dockerLocalhostHintSuffix(rawBaseUrl) {
  return isLocalhostHost(rawBaseUrl) ? " " + DOCKER_LOCALHOST_HINT : "";
}

module.exports = { dockerLocalhostHintSuffix, isLocalhostHost, DOCKER_LOCALHOST_HINT };
