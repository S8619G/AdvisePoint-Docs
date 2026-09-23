import {useEffect,useRef,useState,type ReactNode} from "react";

const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,c=>`&#${c.charCodeAt(0)};`);
export function SelectedTextActions({children,title,citation}:{
  children:ReactNode;title:string;citation:string;
}){
  const root=useRef<HTMLDivElement>(null);
  const [selection,setSelection]=useState<{text:string;left:number;top:number}|null>(null);
  const [message,setMessage]=useState("");
  useEffect(()=>{
    let frame=0;
    const update=()=>{
      const selected=window.getSelection(),el=root.current;
      if(!el||!selected||selected.isCollapsed||!selected.rangeCount||
        !el.contains(selected.anchorNode)||!el.contains(selected.focusNode)){
        setSelection(null);return;
      }
      const text=selected.toString();
      if(!text.trim()){setSelection(null);return;}
      const rect=selected.getRangeAt(0).getBoundingClientRect();
      const owner=el.closest(".overflow-auto")?.getBoundingClientRect();
      if(rect.bottom<Math.max(0,owner?.top??0)||rect.top>Math.min(innerHeight,owner?.bottom??innerHeight)){
        setSelection(null);return;
      }
      setSelection({text,left:Math.max(8,Math.min(innerWidth-280,rect.left)),
        top:Math.max(8,Math.min(innerHeight-50,rect.top>56?rect.top-48:rect.bottom+8))});
      setMessage("");
    };
    const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(update);};
    document.addEventListener("selectionchange",schedule);
    document.addEventListener("scroll",schedule,true);
    window.addEventListener("resize",schedule);
    return ()=>{
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange",schedule);
      document.removeEventListener("scroll",schedule,true);
      window.removeEventListener("resize",schedule);
    };
  },[title,citation]);
  const copy=async()=>{
    if(!selection)return;
    try{await navigator.clipboard.writeText(selection.text);setMessage("Copied");}
    catch{setMessage("Use Ctrl+C or right-click Copy");}
  };
  const print=()=>{
    if(!selection)return;
    const popup=window.open("","_blank","width=850,height=950");
    if(!popup){setMessage("Allow pop-ups for port 5100");return;}
    popup.opener=null;
    popup.document.open();
    popup.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>AdvisePoint Docs - Selected text</title>
      <style>body{font:14px/1.6 system-ui;color:#111;padding:32px;max-width:800px;margin:auto}h1{font-size:18px}pre{white-space:pre-wrap;font:inherit}.controls{background:#fff4cc;padding:12px}@media print{.controls{display:none}body{padding:0}}</style></head>
      <body><div class="controls">AdvisePoint Docs · Selected text only <button onclick="window.print()">Print selected text</button></div>
      <h1>${escapeHtml(title)}</h1><p>${escapeHtml(citation)}</p><pre>${escapeHtml(selection.text)}</pre></body></html>`);
    popup.document.close();
    popup.focus();
  };
  return <>
    <div ref={root}>{children}</div>
    {selection&&<div role="toolbar" aria-label="Selected text actions" data-testid="selected-text-actions"
      className="fixed z-[100] flex items-center gap-2 rounded-md border bg-background px-2 py-2 text-sm shadow-lg"
      style={{left:selection.left,top:selection.top,maxWidth:"calc(100vw - 16px)"}}
      onMouseDown={e=>e.preventDefault()}>
      <button className="rounded px-2 py-1 hover:bg-muted" onClick={copy}>Copy selection</button>
      <button className="rounded px-2 py-1 hover:bg-muted" onClick={print}>Print selection</button>
      {message&&<span role="status" className="text-xs">{message}</span>}
    </div>}
  </>;
}
