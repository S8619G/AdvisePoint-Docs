AdvisePoint Docs
================

A local search tool for technical manuals and admin guides.
Everything runs on your own laptop. No internet connection required
after install.

The library starts empty. Upload your own PDFs, DOCX, TXT, or Markdown
files from the Upload tab and they're indexed locally on your machine.


QUICK START
-----------

1. Extract this folder somewhere convenient, for example:
      C:\Tools\AdvisePoint Docs

2. FIRST TIME ONLY: Double-click "Setup Icon (run once).bat"
   This does two things:
     a) Clears Windows' "downloaded from the internet" flag from
        every file in the folder. This removes the SmartScreen
        popups you'd otherwise see every time the app launches.
     b) Creates a "AdvisePoint Docs" shortcut with the AdvisePoint Docs
        icon that launches the app with no command window.
   You may see ONE "Windows protected your PC" popup for this
   .bat itself - click "More info" then "Run anyway". After it
   finishes you shouldn't see the popup again.

   NEW IN v0.9.29: even if you skip step 2 and launch the app
   directly, "Start AdvisePoint Docs.bat" will now self-unblock
   the folder on first run so the SmartScreen popup only shows
   up once instead of on every launch.

3. Double-click the new "AdvisePoint Docs" shortcut. Your browser
   opens at http://127.0.0.1:5000 with the app already loaded.
   No command window appears - the server runs invisibly in the
   background.

4. When you are done, close the browser tab. To fully stop the
   server, right-click the AdvisePoint Docs entry in Task Manager
   and choose End Task, or just log off / restart your PC.

Optional: after step 2, you can drag the "AdvisePoint Docs"
shortcut to your Desktop or right-click and Pin to Taskbar for
one-click access.

If the shortcut doesn't work for any reason, you can always fall
back to double-clicking "Start AdvisePoint Docs.bat" - same result.

Your database lives in %LOCALAPPDATA%\AdvisePoint Docs\ so any
documents you upload stick around between sessions.


UPDATING
--------

Double-click "Update AdvisePoint Docs.bat" in this folder. The updater
checks GitHub for the latest release, verifies the download, and replaces
the application files. If the browser tab is closed but the background
server is still running, the updater identifies it and offers to shut it
down cleanly before continuing. It never stops an unrelated process that
happens to use port 5000.

Your database, uploaded documents, settings, and history remain under
%LOCALAPPDATA%\AdvisePoint Docs\ and are never replaced by the updater.
The previous application build is retained temporarily as dist.bak so
the updater can restore it automatically if an update fails. Each later
successful update replaces the prior dist.bak; backup folders do not
accumulate.


INSTALL LOCATION - RECOMMENDED FOLDER SETUP
-------------------------------------------

Extract the AdvisePoint Docs folder to a plain local path like:

      C:\AdvisePoint Docs\
      D:\AdvisePoint Docs\
      C:\Tools\AdvisePoint Docs\

Do NOT extract or move it into:

      OneDrive              (personal or business)
      Dropbox
      Google Drive
      iCloud Drive
      Box / Box Sync
      Any network path starting with \\server\share

Why this matters:

  * Cloud-sync tools can mark files as online-only placeholders. When
    the app or your browser tries to open one, the sync client has to
    fetch it first, which can time out or fail silently.
  * Corporate OneDrive tenants often apply Data Loss Prevention (DLP)
    rules that block uploads to loopback services like this app.
    Symptom: the Upload tab shows "Failed to fetch" and no request
    ever reaches the server.
  * Sync clients hold short-lived file locks while a file is being
    written. Backups written into a sync folder can corrupt mid-write.
  * Files inherit the Mark-of-the-Web from the sync source, so
    SmartScreen popups keep coming back even after Setup Icon.

Starting in v1.0.5 the app auto-detects the most common problem paths
and shows an amber banner at the top of the window when it's running
from one of them. The banner links back here and can be dismissed per
location. It reappears if you later move the app to a different
problem folder.

If the app is already installed inside a cloud-sync folder:

  1. Close the app (Task Manager -> AdvisePoint Docs -> End task, or
     right-click the taskbar icon -> Close).
  2. Move (not copy) the "AdvisePoint Docs" folder to a plain local
     path like C:\AdvisePoint Docs\ .
  3. Re-run "Setup Icon (run once).bat" from the new location so the
     desktop shortcut points at the right place.
  4. Launch the app. Your uploaded documents are unaffected because
     they live in %LOCALAPPDATA%\AdvisePoint Docs\ , which is outside
     the app folder and outside typical cloud-sync paths.


ADDING YOUR OWN DOCUMENTS
--------------------------

1. Click the Upload tab.
2. Drag a PDF, DOCX, TXT, or Markdown file onto the drop zone
   (or click the drop zone to browse for one).
3. Fill in the Product model field (required). This is what makes
   filtered searches work later.
4. Fill in whatever other metadata is useful - product family, firmware
   version, document type, confidentiality level, audience, tags.
5. Click Upload.

The file is parsed, split into searchable excerpts, and indexed locally.
Nothing is uploaded anywhere. Max file size is 150 MB.

Tip: the Tags field autocompletes from tags you've used before, so
similar documents end up with consistent labels.


SEARCHING
---------

1. Click the Query tab.
2. Type a natural-language question like:
      "How do I configure LDAP authentication?"
      "What are the paper size limits on the MZ9500ci?"
      "Steps to reset the fuser count"
3. Use the filter panel on the left to narrow by product model,
   firmware, document type, or confidentiality level.
4. Toggle Hybrid on for combined vector + keyword search (recommended).

Each result shows a relevance score, the excerpt of text that matched,
and the source document. Your search terms are highlighted in amber
in the result text so you can spot them at a glance. Click "Show
metadata" to see the full record.


WHERE YOUR DATA LIVES
---------------------

Every document you upload is stored under:

   %LOCALAPPDATA%\AdvisePoint Docs\
     advisepoint.db          <- the SQLite database
     pages\          <- rendered page images for the manual viewer
     server.log      <- rolling log for diagnosing crashes

That folder survives reinstalls and updates. If you ever want a truly
fresh start, close the app and delete that folder - the next launch
will recreate an empty database.


TROUBLESHOOTING
---------------

* "Windows protected your PC" popup:
  Expected the first time you run "Setup Icon (run once).bat" or,
  if you skip that, the first time you run "Start AdvisePoint
  Docs.bat". Click "More info" then "Run anyway". Both launchers
  clear the "downloaded" flag from every other file in the folder,
  so subsequent launches should NOT show the popup.

  If you ever see it again after setup, you can also strip the
  flag from a PowerShell window in the app folder:

      Get-ChildItem -Path "C:\path\to\AdvisePoint Docs" -Recurse | Unblock-File

  Or, before extracting, right-click the .zip in File Explorer,
  choose Properties, and tick "Unblock" - that clears the flag at
  the source.

* Antivirus flags node.exe:
  This is the standard Node.js runtime from nodejs.org. If your
  antivirus is aggressive, add the AdvisePoint Docs folder to its
  exclusions list.

* Port 5000 is already in use:
  Close whatever else is using it (another AdvisePoint Docs window,
  or another local dev server). The start script tries to free the
  port automatically.

* Browser opens but nothing loads:
  Wait 5-10 more seconds and refresh. The server takes a moment
  to come up on first launch.

* PDF upload takes forever:
  Large PDFs (500+ pages) can take 30-60 seconds. This is normal.
  Look at the console window for progress.


TECHNICAL DETAILS
-----------------

* Runtime: Portable Node.js 20 LTS (bundled - no install required)
* Database: SQLite via better-sqlite3
* Extraction: pdf-parse for PDFs, mammoth for DOCX, pdf.js for
  page rendering (with cMap and standard font support so
  PowerPoint-exported PDFs render correctly)
* Search: TF-IDF hybrid retrieval (vector + keyword)
* All processing happens locally. No network calls are made.


REMOVING THE APP
----------------

Delete the "AdvisePoint Docs" folder. To also remove your uploaded
documents, delete the %LOCALAPPDATA%\AdvisePoint Docs\ folder.


VERSION
-------

AdvisePoint Docs 1.0.0
Bundled Node.js: 20.18.1
