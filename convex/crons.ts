import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Keona's heartbeat: every minute, fan out watch passes (only if guards are
// active — the minute action exits after one cheap query otherwise).
crons.interval("keona watch loop", { minutes: 1 }, internal.watch.minute, {});

export default crons;
