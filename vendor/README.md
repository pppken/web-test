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
