# Third-party software

The bundled converter contains open-source components, not a browser or
commercial PDF SDK. Copyright notices and license texts accompany the software.

## PDF engine

QPDF 12.4.1 is distributed under Apache-2.0, with component notices in
`licenses/LICENSE.txt` and `licenses/NOTICE.md`.
[Upstream release and corresponding source](https://github.com/qpdf/qpdf/releases/tag/v12.4.1).

The x64 engine is copied unchanged from the official `qpdf-12.4.1-mingw64.zip`.
SHA-256: `6a47eeddc8ff712a6e003314daae25569402c6e904ba82b7b9181d7b0301b689`.
The upstream source archive is `qpdf-12.4.1.tar.gz` on the same release.

The MinGW binary includes GCC runtime libraries under GPL with the GCC Runtime
Library Exception. The included copyright file, GPL-3 and exception text must
remain with redistributed binaries. Upstream runtime source is available from
[GCC](https://gcc.gnu.org/git.html) and the
[MSYS2 MinGW package recipes](https://github.com/msys2/MINGW-packages).

Winpthreads includes MIT and BSD-style notices in `licenses/winpthreads-COPYING.txt`;
[corresponding upstream source](https://github.com/mingw-w64/mingw-w64/tree/master/mingw-w64-libraries/winpthreads).
Zlib and JPEG dependency notices are included in `licenses/`.

## JavaScript runtime and PDF inspection

Node 20.18.1 is copied byte-for-byte from the verified AdvisePoint Docs v1.3.0
x64 runtime; its full notices are in `node/LICENSE`.
[Node source](https://github.com/nodejs/node/tree/v20.18.1).

PDF inspection uses pdf-parse 2.4.5, PDF.js and @napi-rs/canvas with their
licenses preserved under each package directory. The source lockfile records
the dependency versions. These are the existing verified application modules,
not a second browser installation.

The application source ZIP includes the matching converter binaries, notices
and application packaging scripts. It excludes user PDFs, databases, test
output and temporary files.
