// Local-test wrapper only. Never launch the production BAT, stop port 5000,
// discover an existing library, or invoke the updater from a candidate.
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
async function main() {
  const app = path.resolve(__dirname);
  if (!fs.existsSync(path.join(app, "LOCAL_TEST_ONLY"))) throw Error("Local-test marker missing.");
  const home = process.env.LOCALAPPDATA;
  if (!home || !path.isAbsolute(home)) throw Error("An absolute LOCALAPPDATA folder is required.");
  const outer = path.join(home, "AdvisePoint Docs v1.3.0 Test");
  const data = path.join(outer, "AdvisePoint Docs");
  // Reject junction/symlink redirection, including ancestors.
  for (let p = data;; p = path.dirname(p)) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw Error("Linked test-storage folders are not allowed.");
    if (path.dirname(p) === p) break;
  }
  const marker = path.join(outer, ".apd-local-test-v130");
  if (fs.existsSync(outer) && !fs.existsSync(marker) && fs.readdirSync(outer).length)
    throw Error("Unrecognized test folder; refusing to open or overwrite its contents.");
  const probe = net.createServer();
  await new Promise((ok, no) => {
    probe.once("error", no);
    probe.listen(5101, "127.0.0.1", () => probe.close(ok));
  });
  fs.mkdirSync(data, {recursive: true});
  fs.writeFileSync(marker, "AdvisePoint Docs v1.3.0 local-test library\n");
  for (const key of Object.keys(process.env)) {
    if (/^(RAG_|APD_)/.test(key)) delete process.env[key];
  }
  const temp = path.join(outer, "Temp");
  fs.mkdirSync(temp, {recursive: true});
  Object.assign(process.env, {
    LOCALAPPDATA: outer, APPDATA: outer, TEMP: temp, TMP: temp, TMPDIR: temp,
    RAG_DB_PATH: path.join(data, "advisepoint.db"),
    RAG_PAGES_DIR: path.join(data, "pages"),
    APD_LOG_DIR: path.join(data, "logs"), APD_LOCAL_TEST: "1",
    PORT: "5101", NODE_ENV: "production", APD_OPEN_BROWSER: "1",
  });
  process.chdir(app);
  require("./runtime-log.cjs")(process.env.APD_LOG_DIR);
  console.log("AdvisePoint Docs v1.3.0 candidate 13 LOCAL TEST: http://127.0.0.1:5101");
  console.log("Separate test library:", data);
  console.log("Updates disabled. Leave this window open; close it to stop the test.");
  require(path.join(app, "dist", "application.cjs"));
}
main().catch(e => {console.error("Test startup refused:", e.message); process.exitCode = 1;});
