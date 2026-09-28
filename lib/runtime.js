// lib/runtime — in-process state shared by the long-running loops (server.js,
// lib/pump, lib/intake) and the admin panel.
import { wakeable } from './util.js';

export const startedAt = Date.now();
// Notified whenever jobs may have become runnable.
export const jobsWake = wakeable();
// Cuts the Bale pump's error back-off short (admin "restart pump").
export const pumpWake = wakeable();
// Worker slot -> id of the job it is running (0 = idle).
export const workerJobs = [];
