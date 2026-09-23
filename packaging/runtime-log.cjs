// Normal local-test launcher console capture. Append across starts; size bounded.
const fs=require("node:fs"),path=require("node:path");
module.exports=function capture(dir){
  const originalError=process.stderr.write.bind(process.stderr);
  let warned=false;
  for(const stream of [process.stdout,process.stderr]){
    const original=stream.write.bind(stream);
    stream.write=function(chunk,encoding,callback){
      try{
        fs.mkdirSync(dir,{recursive:true});
        const file=path.join(dir,"server.log");
        const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk,typeof encoding==="string"?encoding:"utf8");
        if(fs.existsSync(file)&&fs.statSync(file).size+data.length>10*1024*1024){
          fs.rmSync(file+".1",{force:true});fs.renameSync(file,file+".1");
        }
        // A pathological single write must not defeat the size cap.
        fs.appendFileSync(file,data.subarray(-10*1024*1024));
      }catch{
        if(!warned){warned=true;originalError("Persistent server logging unavailable. Check disk space and permissions.\n");}
      }
      return original(chunk,encoding,callback);
    };
  }
};
