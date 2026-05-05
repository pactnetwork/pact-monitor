#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === "--version" || args[0] === "-v") {
  console.log("0.1.0");
  process.exit(0);
}
console.log("pact CLI — see `pact --help`");
process.exit(0);
