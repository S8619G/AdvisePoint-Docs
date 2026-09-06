' ===================================================================
'  AdvisePoint Docs - Hidden Launcher
'  Runs Start AdvisePoint Docs.bat with NO visible console window.
'  If the server crashes, the .bat's own crash handler will call
'  "start cmd /k" to spawn a visible window with the error before
'  it terminates, so silent failures are still surfaced.
' ===================================================================
Set oShell = CreateObject("WScript.Shell")
Set oFS    = CreateObject("Scripting.FileSystemObject")

' Resolve the .bat sitting one directory up from this .vbs
sScriptDir = oFS.GetParentFolderName(WScript.ScriptFullName)
sAppDir    = oFS.GetParentFolderName(sScriptDir)
sBat       = sAppDir & "\Start AdvisePoint Docs.bat"

' Tell the .bat it's running fully hidden so it spawns a visible window
' if the server crashes (instead of trying to un-minimize a nonexistent one).
oShell.Environment("PROCESS")("APD_HIDDEN") = "1"

' 0 = hidden, False = don't wait for exit
oShell.Run """" & sBat & """", 0, False
