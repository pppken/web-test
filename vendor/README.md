# vendor

第三者ライブラリの同梱物。手を加えずにそのまま置いている。

## zxing-0.21.3.min.js

`BarcodeDetector` が使えないブラウザ（iOS Safari / Firefox / デスクトップ Chrome など）で
バーコードの解析に使うフォールバック。`barcode.js` から必要になったときだけ読み込まれる。

- パッケージ: [`@zxing/library`](https://github.com/zxing-js/library) 0.21.3
- 取得元: `https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js`
- SHA-256: `d7cc8f69dd70bdcf3ac00c9ae572bf2acb9f4132ba379c72df842e4db918652d`
- ライセンス: `package.json` は MIT、同梱の LICENSE は Apache-2.0 と食い違っている
  （上流の既知の不整合）。両方の全文が `zxing-LICENSE.txt` ではなく上流リポジトリ側に
  あるため、ここには同梱されていた Apache-2.0 の全文を置いている。

### 更新手順

```sh
curl -sSL -o vendor/zxing-0.21.3.min.js \
  https://cdn.jsdelivr.net/npm/@zxing/library@<version>/umd/index.min.js
```

ファイル名にバージョンを入れているので、更新したら `barcode.js` の `ZXING_SRC` も合わせて変える。

## quagga2-1.12.1.min.js

読み比べ用のもう 1 つの検出エンジン。`barcode.js` の「エンジン」ボタンで Quagga2 を
選んだときだけ読み込まれる（自動では選ばれない）。

- パッケージ: [`@ericblade/quagga2`](https://github.com/ericblade/quagga2) 1.12.1
- 取得元: `https://cdn.jsdelivr.net/npm/@ericblade/quagga2@1.12.1/dist/quagga.min.js`
- SHA-256: `ae6c469103c5d427625a9a4c41175bd15420a14aa5579ea57dc1571d42346f4d`
- ライセンス: MIT（全文を `quagga2-LICENSE.txt` に置いている）

UMD が読み込み時に `window` を直接参照するので、このファイルは Worker では動かない。

### 更新手順

```sh
curl -sSL -o vendor/quagga2-1.12.1.min.js \
  https://cdn.jsdelivr.net/npm/@ericblade/quagga2@<version>/dist/quagga.min.js
curl -sSL -o vendor/quagga2-LICENSE.txt \
  https://cdn.jsdelivr.net/npm/@ericblade/quagga2@<version>/LICENSE
```

ZXing と同じく、更新したら `barcode.js` の `QUAGGA_SRC` も合わせて変える。
