# Rebuild the bundled ARM64 PDF engine

From the AdvisePoint Docs source root, run:

```sh
bash packaging/pdf-engine/build-arm64/build-engine.sh /absolute/empty/build-folder
```

The script pins QPDF 12.4.1, zlib, libjpeg-turbo and LLVM-MinGW downloads by
SHA-256. It applies the included build-system patch and produces a native
Windows ARM64 `engine/qpdf.exe`. PDF-processing code is unchanged.

Copy the verified executable to `packaging/pdf-engine/arm64/qpdf.exe` before
running the Windows package script. Preserve all accompanying license files.
This recipe builds the converter only, not the application or a separate lab.
