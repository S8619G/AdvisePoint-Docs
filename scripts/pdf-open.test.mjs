import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,readdir,symlink,utimes,rm,chmod,access} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {prepareExternalCopy,windowsPdfLaunch,withExternalPrintCopy,finishExternalPrint,cleanOldExternalCopies} from "../server/pdf-open.ts";
test("External PDF copies preserve original, reuse unchanged bytes, never reuse modified copies",async()=>{
  const root=await mkdtemp(join(tmpdir(),"pdf-open-test-"));
  try{
    await mkdir(join(root,"originals"));await mkdir(join(root,"temp"));
    const source=join(root,"originals","doc_test.pdf"),bytes=Buffer.from("%PDF-1.7\nOnly a controlled test fixture.");
    await writeFile(source,bytes);
    const copy=await prepareExternalCopy(root,source);
    assert.deepEqual(await readFile(copy),bytes);assert.notEqual(copy,source);
    assert.equal(await prepareExternalCopy(root,source),copy);
    await writeFile(copy,"%PDF-1.7\nReader edited this disposable copy.");
    const second=await prepareExternalCopy(root,source);assert.notEqual(second,copy);
    assert.deepEqual(await readFile(source),bytes);assert.deepEqual(await readFile(second),bytes);
    const old=new Date(Date.now()-2*86400000);await utimes(copy,old,old);
    await prepareExternalCopy(root,source);
    assert.ok(!(await readdir(join(root,"temp","external-pdf"))).includes(copy.split("/").at(-1)));
  }finally{await rm(root,{recursive:true,force:true});}
});
test("External PDF copy rejects symlinks and out-of-root originals",async()=>{
  const root=await mkdtemp(join(tmpdir(),"pdf-open-test-"));
  try{
    await mkdir(join(root,"originals"));await mkdir(join(root,"temp"));
    const outside=join(root,"outside.pdf");await writeFile(outside,"%PDF-1.7\nTest");
    await assert.rejects(prepareExternalCopy(root,outside),/outside/);
    const linked=join(root,"originals","doc_test.pdf");await symlink(outside,linked);
    await assert.rejects(prepareExternalCopy(root,linked),/Linked/);
  }finally{await rm(root,{recursive:true,force:true});}
});
test("Windows default-app command never interpolates the path into command syntax",()=>{
  const path="C:\\User & Work\\temp\\original-$('bad').pdf";
  const launch=windowsPdfLaunch(path,"C:\\Windows");
  assert.ok(!launch.args.join(" ").includes(path));
  assert.equal(launch.env.ADVISEPOINT_PDF_COPY,path);
  assert.ok(launch.args.includes("-NoProfile"));
  assert.match(launch.args.at(-1),/^Start-Process -FilePath \$env:ADVISEPOINT_PDF_COPY/);
});
test("Print-owned PC copies remain isolated, defer active use, and reject late reopening",async()=>{
  const root=await mkdtemp(join(tmpdir(),"pdf-open-test-"));
  try{
    await mkdir(join(root,"originals"));const source=join(root,"originals","doc_test.pdf");
    const bytes=Buffer.from("%PDF-1.7\nOwned temporary test copy.");await writeFile(source,bytes);
    const unrelated=await prepareExternalCopy(root,source),id=randomUUID(),other=randomUUID();
    let first,second,release;const gate=new Promise(r=>release=r);
    const running=withExternalPrintCopy(root,source,id,async p=>{first=p;await gate;});
    while(!first)await new Promise(r=>setTimeout(r,5));
    await withExternalPrintCopy(root,source,other,async p=>{second=p;});
    assert.notEqual(first,second);assert.notEqual(first,unrelated);
    assert.equal((await finishExternalPrint(id)).pending,true);await access(first);
    release();await running;await assert.rejects(access(first));
    await access(second);await access(unrelated);assert.deepEqual(await readFile(source),bytes);
    await assert.rejects(withExternalPrintCopy(root,source,id,async()=>{}),/finished/);
    assert.equal((await finishExternalPrint(other)).pending,false);await assert.rejects(access(second));
  }finally{await rm(root,{recursive:true,force:true});}
});
test("Deletion failure stays pending and retries; abandoned known copies clean without library deletion",async()=>{
  const root=await mkdtemp(join(tmpdir(),"pdf-open-test-"));let folder;
  try{
    await mkdir(join(root,"originals"));const source=join(root,"originals","doc_test.pdf");
    await writeFile(source,"%PDF-1.7\nCleanup test.");
    const id=randomUUID();let copy;
    await withExternalPrintCopy(root,source,id,async p=>{copy=p;});
    folder=join(root,"temp","external-pdf");await chmod(folder,0o500);
    assert.equal((await finishExternalPrint(id)).pending,true);await access(copy);
    await chmod(folder,0o700);assert.equal((await finishExternalPrint(id)).pending,false);
    await assert.rejects(access(copy));await access(source);
    const orphan=await prepareExternalCopy(root,source),old=new Date(Date.now()-2*86400000);
    await utimes(orphan,old,old);await writeFile(join(folder,"user-notes.txt"),"Preserve unknown files");
    await cleanOldExternalCopies(root);await assert.rejects(access(orphan));
    await access(source);await access(join(folder,"user-notes.txt"));
  }finally{if(folder)await chmod(folder,0o700);await rm(root,{recursive:true,force:true});}
});
