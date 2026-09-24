"use strict";

const assert = require("assert");
const { dockerLocalhostHintSuffix, isLocalhostHost } = require("../lib/docker-localhost-hint");

// Only a literal "localhost" or "127.0.0.1" host triggers the hint — a real
// LAN/WAN address (even a private one like 192.168.x.x) already means
// something concrete regardless of where Node-RED itself runs, so it gets
// no hint.
[
  ["http://localhost:11434/v1", true, "bare \"localhost\""],
  ["http://LOCALHOST:11434/v1", true, "case-insensitive"],
  ["http://127.0.0.1:8080/v1", true, "loopback IP"],
  ["https://localhost/v1", true, "localhost with no port"],
  ["http://192.168.1.15:8080", false, "a real LAN IP is not localhost"],
  ["https://api.openai.com/v1", false, "a real cloud host"],
  ["http://myhost.localdomain:1234/v1", false, "a hostname that merely CONTAINS \"local\" is not \"localhost\""],
  ["", false, "empty baseUrl"],
  [undefined, false, "undefined baseUrl"]
].forEach(function (fixture) {
  const input = fixture[0], expected = fixture[1], label = fixture[2];
  assert.strictEqual(isLocalhostHost(input), expected, "isLocalhostHost(\"" + input + "\") — " + label);
});

assert.strictEqual(dockerLocalhostHintSuffix("http://localhost:11434/v1").length > 0, true,
  "dockerLocalhostHintSuffix must return non-empty text for a localhost baseUrl");
assert.ok(
  dockerLocalhostHintSuffix("http://localhost:11434/v1").indexOf("Docker") !== -1,
  "hint text must mention Docker"
);
assert.strictEqual(dockerLocalhostHintSuffix("http://192.168.1.15:8080"), "",
  "dockerLocalhostHintSuffix must be empty (safe to always append) for a non-localhost baseUrl");

// The suffix must be directly concatenable onto an existing error message
// (leading space, no extra formatting needed at the call site).
const message = "Provider request failed" + dockerLocalhostHintSuffix("http://localhost:1234/v1");
assert.strictEqual(message, "Provider request failed " + require("../lib/docker-localhost-hint").DOCKER_LOCALHOST_HINT);

console.log("docker-localhost-hint tests passed");
