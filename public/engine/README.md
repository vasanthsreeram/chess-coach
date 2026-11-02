# Stockfish engine

The JavaScript and WebAssembly engine files in this directory are Stockfish.js
19.0.1, distributed under GPL-3.0. See [STOCKFISH-COPYING.txt](STOCKFISH-COPYING.txt).
They are separate from the app's MIT-licensed source.

Corresponding upstream source: [Stockfish.js v19.0.1](https://github.com/nmrugg/stockfish.js/tree/v19.0.1),
commit `0d5dd7944f88c817c07a26bc4fb1905d5f9c46d6`. The upstream build instructions
and Emscripten version are in that source tree. Its lite network is
[`nn-61e7af4bb97d.nnue`](https://tests.stockfishchess.org/api/nn/nn-61e7af4bb97d.nnue).

These files match the Stockfish.js 19.0.1 npm distribution by SHA-256:

```
ccb130d7ff29408531c47d859a49f91d59d4f482d05a53eb1a3231a4f624c91a  stockfish-19-lite-single.js
ee4f115bdb2d32cadf96cada104a05b5ec257d7ad6f57582190b49bc71f096de  stockfish-19-lite-single.wasm
```

The upstream source build has not been independently reproduced for this release.
