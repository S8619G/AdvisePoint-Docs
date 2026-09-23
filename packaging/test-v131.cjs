'use strict';
// Optional isolated testing. This does not find, convert, reset or delete a
// production library, and it never launches the production BAT or updater.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
async function main(){
  const home=process.env.LOCALAPPDATA;
  if(!home||!path.isAbsolute(home))throw Error('LOCALAPPDATA must be an absolute folder.');
  const outer=path.join(home,'AdvisePoint Docs v1.3.1 Test');
  const data=path.join(outer,'AdvisePoint Docs'),marker=path.join(outer,'.apd-test-v131');
  for(let p=data;;p=path.dirname(p)){
    if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw Error('Linked test folders are not allowed.');
    if(path.dirname(p)===p)break;
  }
  if(fs.existsSync(outer)&&!fs.existsSync(marker)&&fs.readdirSync(outer).length)
    throw Error('Unrecognized test folder; nothing was changed.');
  const probe=net.createServer();
  await new Promise((ok,no)=>{probe.once('error',no);probe.listen(5102,'127.0.0.1',()=>probe.close(ok))});
  fs.mkdirSync(data,{recursive:true});fs.writeFileSync(marker,'AdvisePoint Docs v1.3.1 test\n');
  for(const key of Object.keys(process.env))if(/^(RAG_|APD_)/.test(key))delete process.env[key];
  const temp=path.join(outer,'Temp');fs.mkdirSync(temp,{recursive:true});
  Object.assign(process.env,{LOCALAPPDATA:outer,APPDATA:outer,TEMP:temp,TMP:temp,TMPDIR:temp,
    RAG_DB_PATH:path.join(data,'advisepoint.db'),RAG_PAGES_DIR:path.join(data,'pages'),
    APD_LOG_DIR:path.join(data,'logs'),APD_LOCAL_TEST:'1',PORT:'5102',
    NODE_ENV:'production',APD_OPEN_BROWSER:'1'});
  process.chdir(__dirname);
  console.log('AdvisePoint Docs v1.3.1 isolated test: http://127.0.0.1:5102');
  console.log('Separate test library:',data);
  console.log('Leave this window open. Updates cannot run from this test launcher.');
  require('./dist/index.cjs');
}
main().catch(e=>{console.error('Test startup refused:',e.message);process.exitCode=1});
