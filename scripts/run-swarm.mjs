#!/usr/bin/env node
import { SwarmOrchestrator } from "../src/swarm-orchestrator.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, val] = arg.replace(/^--/, "").split("=");
    return [key, val === undefined ? true : val];
  })
);

const concurrency = Number(args.concurrency || 3);
const chunkSize = Number(args["chunk-size"] || 5);
const engine = args.engine || "academic";

const orchestrator = new SwarmOrchestrator({
  concurrency,
  chunkSize,
  engine
});

process.on("SIGINT", () => {
  console.log("\nReceived SIGINT. Requesting graceful swarm stop...");
  orchestrator.stop();
});

process.on("SIGTERM", () => {
  console.log("\nReceived SIGTERM. Requesting graceful swarm stop...");
  orchestrator.stop();
});

orchestrator.start().catch((err) => {
  console.error("Fatal Swarm error:", err);
  process.exit(1);
});
