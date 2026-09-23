#!/usr/bin/env bash
# Build native Windows ARM64 QPDF on Linux x86_64.
# Needs curl, tar, sha256sum, patch, Python 3, CMake >=3.16, Ninja, and two cores.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK="${1:?Usage: bash arm64/build-engine.sh /absolute/empty/build-folder}"
[[ "$WORK" = /* ]] || { echo "Use an absolute build folder."; exit 1; }
mkdir -p "$WORK"
cd "$WORK"
export SOURCE_DATE_EPOCH=1790121600
download() {
    local name="$1" url="$2" hash="$3"
    if [[ ! -f "$name" ]]; then curl -fL --retry 1 "$url" -o "$name"; fi
    printf '%s  %s\n' "$hash" "$name" | sha256sum -c -
}
download llvm-mingw.tar.xz \
 https://github.com/mstorsjo/llvm-mingw/releases/download/20260616/llvm-mingw-20260616-ucrt-ubuntu-22.04-x86_64.tar.xz \
 534b92e067b22a6b4441f48ae9240a3341b17825d04d577eab0cf85c44b4deda
download qpdf-12.4.1.tar.gz \
 https://github.com/qpdf/qpdf/releases/download/v12.4.1/qpdf-12.4.1.tar.gz \
 f045aa277be2356ff53a89a8622945958291177d2483afc20ede7c8a8cd3873c
download zlib-1.3.2.tar.gz https://zlib.net/zlib-1.3.2.tar.gz \
 bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16
download libjpeg-turbo-3.2.0.tar.gz \
 https://github.com/libjpeg-turbo/libjpeg-turbo/releases/download/3.2.0/libjpeg-turbo-3.2.0.tar.gz \
 6f30092cef9fb839779646608f4ee14ae3cbac989c47fa05e841b0841f09878e
for archive in llvm-mingw.tar.xz qpdf-12.4.1.tar.gz zlib-1.3.2.tar.gz libjpeg-turbo-3.2.0.tar.gz; do
    tar -xf "$archive"
done
patch -d qpdf-12.4.1 -p1 < "$SCRIPT_DIR/qpdf-cross-build.patch"
cp "$SCRIPT_DIR/toolchain.cmake" "$WORK/toolchain.cmake"
COMMON=(-G Ninja "-DCMAKE_TOOLCHAIN_FILE=$WORK/toolchain.cmake"
        -DCMAKE_BUILD_TYPE=Release "-DCMAKE_INSTALL_PREFIX=$WORK/prefix")
cmake -S zlib-1.3.2 -B zlib-build "${COMMON[@]}" -DZLIB_BUILD_TESTING=OFF -DZLIB_BUILD_SHARED=OFF
cmake --build zlib-build --parallel 2
cmake --install zlib-build
cmake -S libjpeg-turbo-3.2.0 -B jpeg-build "${COMMON[@]}" \
 -DENABLE_SHARED=OFF -DENABLE_STATIC=ON -DWITH_SIMD=OFF -DWITH_TURBOJPEG=OFF -DWITH_TOOLS=OFF -DWITH_TESTS=OFF
cmake --build jpeg-build --parallel 2
cmake --install jpeg-build
cmake -S qpdf-12.4.1 -B qpdf-build "${COMMON[@]}" \
 -DBUILD_SHARED_LIBS=OFF -DBUILD_STATIC_LIBS=ON -DUSE_IMPLICIT_CRYPTO=OFF \
 -DREQUIRE_CRYPTO_NATIVE=ON -DBUILD_DOC=OFF \
 "-DZLIB_H_PATH=$WORK/prefix/include" "-DZLIB_LIB_PATH=$WORK/prefix/lib/libzs.a" \
 "-DLIBJPEG_H_PATH=$WORK/prefix/include" "-DLIBJPEG_LIB_PATH=$WORK/prefix/lib/libjpeg.a"
cmake --build qpdf-build --target qpdf --parallel 2
mkdir -p engine
cp qpdf-build/qpdf/qpdf.exe engine/qpdf.exe
llvm-mingw-20260616-ucrt-ubuntu-22.04-x86_64/bin/llvm-strip engine/qpdf.exe
llvm-mingw-20260616-ucrt-ubuntu-22.04-x86_64/bin/llvm-readobj --file-headers --coff-imports engine/qpdf.exe > engine/imports.txt
sha256sum engine/qpdf.exe
