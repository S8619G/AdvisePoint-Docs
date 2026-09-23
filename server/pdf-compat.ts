import {createRequire} from "node:module";
import {dirname,resolve,join} from "node:path";
import {fileURLToPath} from "node:url";
import {getDataDirForBackup} from "./storage";
const here=typeof __dirname==="string"?__dirname:dirname(fileURLToPath(import.meta.url));
const compat=createRequire(join(here,"pdf-compat-loader.cjs"))(
  join(here,"workers","pdf-compat.cjs"));
export const isPdfCompatibilityBusy=():boolean=>compat.isBusy();
export async function prepareCompatiblePdf(buffer:Buffer,signal:AbortSignal,onStage:(stage:string)=>void):Promise<Buffer>{
  // Windows always uses its bundled native engine, never PATH or a browser.
  const engine=process.platform==="win32"
    ?resolve(here,"..","pdf-engine","qpdf.exe")
    :process.env.APD_ENGINE_TEST_EXE;
  if(!engine)throw Error("Bundled PDF engine unavailable.");
  return compat.prepare(buffer,{engine,signal,onStage,
    root:join(getDataDirForBackup(),".pdf-import-work")});
}
