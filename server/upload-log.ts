// Bounded, append-only upload journal. Never record document text, metadata,
// passwords, buffers or raw exception messages. Logging failure cannot fail an import.
import {appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync} from "node:fs";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import type {Request, Response, NextFunction} from "express";
import {resolveLogDir} from "./backup-log";

export const UPLOAD_LOG_NAMES = ["uploads.log", "uploads.log.1", "uploads.log.2"];
const LIMIT = 2 * 1024 * 1024;
let warned = false;
export function uploadLog(event: string, fields: Record<string, unknown> = {}): boolean {
  try {
    const dir = resolveLogDir();
    if (!dir) throw Error("Log folder unavailable");
    mkdirSync(dir, {recursive:true});
    const safe: Record<string, unknown> = {time:new Date().toISOString(), event};
    for (const key of ["upload_id","document_id","filename","bytes","mode","stage","status","code","elapsed_ms","pages","rendered","version",
      "job_id","pid","exit_code","signal","rss_bytes","heap_used_bytes","external_bytes","array_buffers_bytes","free_memory_bytes",
      ...(event==="rendered_print_worker_stderr"?["diagnostic"]:[])]) {
      const value = fields[key];
      if (typeof value === "string") safe[key] = (key === "filename" ? value.split(/[\\/]/).pop()! : value).replace(/[\x00-\x1f\x7f]/g," ").slice(0,250);
      else if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
    }
    const line = JSON.stringify(safe) + "\n", path = join(dir,UPLOAD_LOG_NAMES[0]);
    if (existsSync(path) && statSync(path).size + Buffer.byteLength(line) > LIMIT) {
      rmSync(join(dir,UPLOAD_LOG_NAMES[2]), {force:true});
      if (existsSync(join(dir,UPLOAD_LOG_NAMES[1]))) renameSync(join(dir,UPLOAD_LOG_NAMES[1]),join(dir,UPLOAD_LOG_NAMES[2]));
      renameSync(path,join(dir,UPLOAD_LOG_NAMES[1]));
    }
    appendFileSync(path,line);
    return true;
  } catch {
    if (!warned) {warned = true; console.error("[uploads] Persistent upload logging is unavailable. Check free disk space and log-folder permissions.");}
    return false;
  }
}

export function startUploadLog(version: string) {
  // Mark unfinished requests from the prior process, but never replay them:
  // a response can be lost after a document has already committed.
  const pending = new Map<string, Record<string, unknown>>();
  const renders = new Set<string>();
  const prints = new Set<string>();
  const dir = resolveLogDir();
  if (dir) for (const name of [...UPLOAD_LOG_NAMES].reverse()) {
    try {
      const path=join(dir,name);
      if (statSync(path).size > LIMIT) continue;
      for (const line of readFileSync(path,"utf8").split("\n")) {
        try {
          const row=JSON.parse(line);
          if(typeof row.job_id==="string"){
            if(row.event==="rendered_print_started")prints.add(row.job_id);
            if(["rendered_print_finished","previous_print_unfinished"].includes(row.event))prints.delete(row.job_id);
          }
          if (typeof row.document_id === "string") {
            if (row.event === "render_started" || (row.event === "upload_stage" && row.stage === "render_queued")) renders.add(row.document_id);
            if (["render_finished","previous_render_unfinished"].includes(row.event)) renders.delete(row.document_id);
          }
          if (typeof row.upload_id !== "string") continue;
          if (row.event === "request_started") pending.set(row.upload_id,row);
          if (["request_finished","connection_closed","previous_request_unfinished"].includes(row.event)) pending.delete(row.upload_id);
        } catch { /* ignore incomplete final line after a power loss */ }
      }
    } catch { /* fresh install or unavailable log */ }
  }
  uploadLog("session_started",{version});
  for (const [upload_id] of pending) uploadLog("previous_request_unfinished",{upload_id,code:"CHECK_LIBRARY_BEFORE_RETRY"});
  for (const document_id of renders) uploadLog("previous_render_unfinished",{document_id,code:"CHECK_RENDER_STATUS"});
  for (const job_id of prints) uploadLog("previous_print_unfinished",{job_id,code:"PREPARE_AGAIN"});
}

export function uploadStage(res: Response, stage: string, fields: Record<string,unknown> = {}) {
  const context = res.locals.upload;
  if (!context) return;
  Object.assign(context,fields,{stage});
  uploadLog("upload_stage",{...context,elapsed_ms:Date.now()-context.started});
}

export function trackUpload(req: Request, res: Response, next: NextFunction) {
  const context = {upload_id:randomUUID(),started:Date.now(),stage:"receiving"};
  res.locals.upload=context;
  res.setHeader("X-Upload-Id",context.upload_id);
  uploadLog("request_started",context);
  res.once("finish",()=>uploadLog("request_finished",{...res.locals.upload,status:res.statusCode,elapsed_ms:Date.now()-context.started}));
  res.once("close",()=>{if(!res.writableFinished)uploadLog("connection_closed",{...res.locals.upload,elapsed_ms:Date.now()-context.started,code:"CHECK_LIBRARY_BEFORE_RETRY"});});
  next();
}
