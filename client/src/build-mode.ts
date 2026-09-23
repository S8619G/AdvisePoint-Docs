// Candidate packages are compiled with this flag. Production updater code is
// retained and tested, but no check or update control runs in a local candidate.
export const LOCAL_TEST = import.meta.env.VITE_APD_LOCAL_TEST === "1";
