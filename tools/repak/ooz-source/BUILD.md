# Building the offline decompressor

The packaged `oo2core_9_win64.dll` is an open-source compatibility shim, not
the proprietary RAD Game Tools library. It was built from the source files in
this directory with Zig 0.16.0:

```powershell
zig c++ -target x86_64-windows-gnu -shared -O3 -I . `
  alphanine-oodle-abi-shim.cpp kraken.cpp bitknit.cpp lzna.cpp `
  -o oo2core_9_win64.dll
```

Expected SHA-256 for the 1.0.83 build:
`5ac5e474887a110bcee8ec454df99c2f0133102cd54f74bb309868fdd7253db3`.

The filename provides the ABI expected by repak. The Suite verifies the exact
hash before invoking repak so repak's network fallback is never used.
