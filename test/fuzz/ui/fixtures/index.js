"use strict";

const fs = require("fs");
const path = require("path");

module.exports = fs.readdirSync(__dirname)
  .filter(name => name.endsWith(".json"))
  .sort()
  .map(name => ({ name: name.slice(0, -5), flow: JSON.parse(fs.readFileSync(path.join(__dirname, name), "utf8")) }));
