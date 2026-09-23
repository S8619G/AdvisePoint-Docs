'use strict';
const {fork}=require('node:child_process');
const path=require('node:path');

// A native PDF dependency can abort its entire process. Never load it into
// the supervisor or a worker thread sharing the supervisor's process.
function runInspection(file,role,options={}) {
  const {script=path.join(__dirname,'compat-inspect.cjs'),timeout=120000,signal,onProgress=()=>{}}=options;
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(Error('PDF inspection cancelled.'));
    let child;
    try {
      child=fork(script,[file,role],{
        execPath:process.execPath,execArgv:['--max-old-space-size=512'],
        windowsHide:true,serialization:'advanced',stdio:['ignore','pipe','pipe','ipc']
      });
    } catch(e) {reject(e);return}
    let result, failure, stderr='', stdout='', settled=false;
    const stop=error=>{
      if(!failure)failure=error;
      if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');
    };
    const abort=()=>stop(Error('PDF inspection cancelled.'));
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
    const timer=setTimeout(()=>stop(Error('PDF inspection timed out.')),timeout);
    child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-12000)});
    child.stdout.on('data',b=>{stdout=(stdout+b.toString()).slice(-4000)});
    child.on('message',message=>{
      if(message?.type==='progress' && typeof message.stage==='string') {
        try {onProgress(message.stage.slice(0,160))} catch(e) {stop(e)}
      } else if(message?.type==='result' && typeof message.ok==='boolean' && !result) {
        result=message;
      } else {
        stop(Error('PDF inspection returned an invalid response.'));
      }
    });
    child.once('error',e=>{failure=e});
    child.once('close',(code,exitSignal)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      signal?.removeEventListener('abort',abort);
      // A success message alone is insufficient: native teardown must finish.
      if(!failure && (code!==0 || exitSignal)) {
        const hex=Number.isInteger(code)?` (0x${(code>>>0).toString(16).padStart(8,'0')})`:'';
        failure=Error(`PDF inspection process exited unexpectedly: code ${code}${hex}${exitSignal?`, signal ${exitSignal}`:''}.`);
      }
      if(!failure && !result)failure=Error('PDF inspection process ended without a result.');
      if(!failure && !result.ok)failure=Error(result.error || 'PDF inspection failed.');
      if(!failure && (!result.result || !Array.isArray(result.result.pages) ||
         !Array.isArray(result.result.pageTextHashes)))failure=Error('PDF inspection returned incomplete data.');
      if(failure) {
        if(stderr.trim() || stdout.trim())failure.message+='\nInspector diagnostics:\n'+(stderr.trim() || stdout.trim());
        reject(failure);
      } else resolve(result.result);
    });
  });
}
module.exports={runInspection};
