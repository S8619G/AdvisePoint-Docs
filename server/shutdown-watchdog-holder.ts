// v1.1.7: singleton holder for the shutdown watchdog. Kept in its own module
// so consumers (routes.ts) can import the instance without pulling in the
// full server/index.ts module and creating a circular dependency.

import { createShutdownWatchdog, type ShutdownWatchdog } from "./shutdown-watchdog";

export const shutdownWatchdog: ShutdownWatchdog = createShutdownWatchdog();
