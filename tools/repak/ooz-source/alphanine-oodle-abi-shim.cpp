#include "ooz.h"
#include <cstddef>
#include <cstdint>

#define OOZ_EXPORT extern "C" __declspec(dllexport)

OOZ_EXPORT std::ptrdiff_t OodleLZ_Decompress(
    const void *compressed,
    std::size_t compressed_size,
    void *output,
    std::size_t output_size,
    int,
    int,
    int,
    void *,
    std::size_t,
    void *,
    void *,
    void *,
    std::size_t,
    int) {
    if (!compressed || !output || compressed_size == 0 || output_size == 0) return 0;
    const int written = Kraken_Decompress(compressed, compressed_size, output, output_size);
    return written < 0 ? 0 : static_cast<std::ptrdiff_t>(written);
}

OOZ_EXPORT std::ptrdiff_t OodleLZ_Compress(
    int, const void *, std::size_t, void *, int, const void *, const void *,
    const void *, void *, std::size_t) {
    return -1;
}

OOZ_EXPORT std::size_t OodleLZ_GetCompressedBufferSizeNeeded(int, std::size_t raw_size) {
    return raw_size + 65536;
}

OOZ_EXPORT void OodleCore_Plugins_SetPrintf(void *) {}
