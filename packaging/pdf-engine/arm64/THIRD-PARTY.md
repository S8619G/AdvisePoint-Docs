# ARM64 engine source and notices

The native Windows ARM64 converter is built from
[QPDF 12.4.1 source](https://github.com/qpdf/qpdf/releases/tag/v12.4.1), under
Apache-2.0. QPDF `LICENSE.txt` and `NOTICE.md` accompany the binary. There are no
changes to PDF processing code. Two build-system changes use a lowercase Windows
import-library name on Linux and select the target compiler rather than host GCC.
The source ZIP includes the exact patch.

Build dependencies are [zlib 1.3.2](https://zlib.net/),
[libjpeg-turbo 3.2.0](https://github.com/libjpeg-turbo/libjpeg-turbo/releases/tag/3.2.0)
and [LLVM-MinGW 20260616 / LLVM 22.1.8](https://github.com/mstorsjo/llvm-mingw/releases/tag/20260616).
The build script pins their archives by SHA-256. QPDF uses its native crypto
implementation. JPEG SIMD is disabled for this conservative prototype build.

QPDF, compression, JPEG and compiler runtime code are statically linked.
Only built-in Windows system libraries remain external. No browser, GCC DLL,
Visual C++ redistributable installer or separate converter installation is bundled.
The standalone engine lab passed user testing on Windows ARM64. The integrated
application still requires Windows field acceptance.

The `licenses/` directory includes QPDF notices, zlib's license, JPEG's
`LICENSE.md` and `README.ijg`, LLVM's Apache-2.0-with-exceptions license and MinGW
runtime notices. This software is based in part on the work of the Independent
JPEG Group. Those notices must remain with redistribution.

Node 20.18.1 and the existing PDF inspection modules are copied from the verified
AdvisePoint Docs v1.3.0 ARM64 runtime; their notices remain in `node/LICENSE`
and the respective `node_modules` folders.
[Node source](https://github.com/nodejs/node/tree/v20.18.1).

## Rebuild

On Linux x86_64, install CMake, Ninja, Python 3, curl, tar and patch.
Run `bash packaging/pdf-engine/build-arm64/build-engine.sh /absolute/empty/build-folder` from the source ZIP.
This downloads the pinned upstream sources, applies the included two-line build
patch and builds `engine/qpdf.exe`. No user documents are involved.

Copy the verified executable into `packaging/pdf-engine/arm64/qpdf.exe`, then
use `scripts/package-windows.mjs` with the authoritative ARM64 runtime inputs.
The application package contains no lab cleanup or library reset tool.
