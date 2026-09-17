# AGENTS.md

ブラウザだけで動く、カメラ／バーコード読み取り／撮影の検証用ページ。
ビルドもパッケージマネージャも使わない **静的サイト**で、GitHub Pages
(`https://github.com/pppken/web-test`) にそのまま置いて実機（主にスマートフォン）
から動作を確認する前提になっている。

## 構成

```
index.html   画面（マークアップ + CSS 全部）と、js を動的に読み込むローダ
camera.js    getUserMedia でのカメラ制御。barcode.js / photo.js のライフサイクル管理
barcode.js   バーコード検出（BarcodeDetector → ZXing フォールバック）
barcode-worker.js
             ZXing の解析を回す Worker。barcode.js からのみ使う
photo.js     静止画撮影（ImageCapture → video フレーム取得フォールバック）
vendor/      第三者ライブラリ（無改変で同梱）
```

- **依存関係なし。** npm も bundler もない。`index.html` をローカルサーバ経由で開けば動く。
- **テストなし・lint なし。** 検証は実機のブラウザで行う。
- CSS は `index.html` の `<style>` に全部入っている。別ファイルに切り出していない。

## モジュールの約束ごと

各 js は IIFE + `'use strict'` で、グローバルには**名前空間オブジェクトを 1 つだけ**生やす。

| ファイル | 公開するもの |
| --- | --- |
| `barcode.js` | `window.BarcodeScanner = { start, stop, pause, resume }` |
| `photo.js` | `window.PhotoCapture = { start(options), stop }` |
| `camera.js` | なし（上記を呼ぶ側） |

依存の向きは **`camera.js` → `BarcodeScanner` / `PhotoCapture`**、および
**`photo.js` → `BarcodeScanner`（pause/resume のみ）** の一方向。

重要な設計方針として、**呼び出し側は相手が無くても動く**。

```js
const scanner = window.BarcodeScanner || { start() {}, stop() {} };
```

このダミーのフォールバックは意図的なもの。片方の js の読み込みに失敗しても、
カメラ単体・撮影単体は動き続ける。新しいモジュールを足すときも同じ形にすること。

### 読み込み順

`index.html` 末尾のローダが `barcode.js` → `photo.js` → `camera.js` の順に
`script.async = false` で挿入する。この順序は必須（`camera.js` が他 2 つの
グローバルを参照するため）。

また **各 js には `?v=<Date.now()>` が付く**。GitHub Pages が `max-age=600` を返すため、
実機検証でキャッシュを踏まないようにしている（検証用の措置なので、本番運用に
するなら見直す箇所）。HTML 自体は `<meta http-equiv="Cache-Control" content="no-cache">`
で毎回再検証させている。

## 各モジュールの要点

### camera.js

- `getUserMedia({ video: { facingMode: {ideal}, width/height: {ideal: 1920x1080} } })`。
  `ideal` なので、対応していない端末では別解像度・別カメラに落ちる。
- 前後カメラの選択は `localStorage['cameraFacingMode']`（`'environment'` / `'user'`）に保存。
  既定はリア。**起動に成功した向きだけ**を保存し、失敗時は前の向きに戻す。
  localStorage は private mode / `file://` で例外を投げうるので、読み書きとも try/catch で握りつぶす。
- フロントカメラは CSS の `transform: scaleX(-1)`（`#video.mirrored`）で鏡像表示するだけ。
  映像データ自体は反転していない。これが barcode.js / photo.js の座標・反転処理の前提になる。
- 起動成功時に `scanner.start()` と `photo.start({ facingMode, track })` を呼ぶ。停止時は両方 `stop()`。
- Permissions API (`{ name: 'camera' }`) は Firefox / 一部 Safari で未対応なので、
  失敗しても `null` を返して無視する。`granted` なら自動起動、`change` でも自動起動。
- `window.isSecureContext` でない場合は起動せず、https / localhost で開くよう案内する。
- `pagehide` で必ずカメラを解放する。

### barcode.js

検出エンジンは 2 系統。**まず `BarcodeDetector`、駄目なら同梱 ZXing** に落ちる。
ZXing はさらに **Worker → メインスレッド** の 2 段になっていて、全体では
`BarcodeDetector` → `ZXing (Worker)` → `ZXing` の順に落ちる。
いま何で動いているかは `#engine` のバッジにそのまま出る。

- **読み取る種類は `FORMATS` に集約してある。現状は CODE39 のみ。**
  `BarcodeDetector` には `code_39`、ZXing には `POSSIBLE_FORMATS` として渡す。
  両者で表記が違うので 1 件につき 2 つ書く（`pdf417` / `PDF_417` のように
  大文字化だけでは揃わないものがあるため、機械変換にしていない）。
- `BarcodeDetector` は API があっても `getSupportedFormats()` が空配列を返す環境がある
  （`FORMATS` のどれも含まれない場合も同じ扱い。いずれも ZXing へ）。
  実行中に例外を投げた場合も `runDetect()` が捕まえて ZXing に切り替える。
- ZXing (`vendor/zxing-0.21.3.min.js`, 約 330KB) は**必要になった時だけ**
  読み込む（Worker なら `importScripts`、メインスレッドなら `loadScript()`）。
  どちらも `ZXING_TIMEOUT_MS` = 10 秒でタイムアウトさせる。
- **ZXing の解析は既定で `barcode-worker.js` に投げる。** ZXing は同期処理なので、
  メインスレッドで回すと解析のあいだ画面が固まる。Worker 側に移すと、メインスレッドに
  残るのは `drawImage` と `getImageData` だけになる。
  `ImageData` の `ArrayBuffer` は転送で渡す（コピーしない）ので、
  送ったあと元の `ImageData` は使えなくなる（毎フレーム作り捨てにしている）。
- Worker を作れない場合と、動き出した Worker が途中で落ちた場合は、
  `useZXingMain()` でメインスレッド実行に落ちる（`runDetect()` が面倒を見る）。
  遅くはなるが読み取り自体は続く。
- Worker には canvas が無いので `HTMLCanvasElementLuminanceSource` は使えない。
  代わりに同じ係数で自前に RGBA → 輝度へ変換し（メインスレッド経路と 1 バイトも
  違わないことを確認済み）、`RGBLuminanceSource` に渡している。
  こちらは `isRotateSupported()` が false だが、回転が要るのは `TRY_HARDER` を
  付けたときだけなので今は影響しない。**`TRY_HARDER` を入れるならここも見直すこと。**

性能に直結するので、次の 4 点は安易に変えないこと（いずれもコメントに理由あり）。

1. **`TRY_HARDER` を付けない。** 全フォーマット有効だと 1 回の解析が約 31ms → 311ms になり、
   実効 3 回/秒まで落ちる。縦向きバーコードは代わりに**こちら側で 1 フレームおきに
   90 度回転**させて対応している（`rotateNext`、ZXing 経路のみ。
   `BarcodeDetector` は向きを自前で処理するので常に正立で渡す）。
   なお 311ms は全フォーマット時の数字なので、`FORMATS` を絞った今なら
   入れられる可能性はある。試すなら `#engine` の N/s で実測してから。
2. **`HTMLCanvasElementLuminanceSource(source, false)`** の第 2 引数は `false`。
   `true` だと 1 フレームおきに白黒反転画像を試し、通常のバーコードの実効回数が半減する。
3. **`MAX_SCAN_SIDE = 640`** に縮小してから解析に渡す。グレースケール変換・二値化は
   画素数に比例するので、ここが効く。900 のときは大半の端末で切り出しサイズ
   （1080p 縦持ちで 864x768 程度）を下回らず、実質的に働いていなかった。
4. **作業用 canvas は正立用と回転用の 2 枚**（`scanCanvases`）。1 枚を使い回すと
   1 フレームおきに幅と高さが入れ替わり、毎フレーム canvas の再確保が走る。

スキャンループ:

- `SCAN_INTERVAL_MS = 120`（約 8 回/秒）。`setTimeout` は**解析完了後に予約**する
  （`setInterval` にするとフレームが溜まる）。
- `captureScanArea()` が `#scanArea` の画面座標を `getBoundingClientRect()` 差分で
  映像の実ピクセル座標に変換して切り出す。枠は中央基準なので、CSS の左右反転が
  あっても座標は変わらない。
- ZXing 経路では、切り出した画像の**左右に幅 `SCAN_PAD_X` = 50px の白い帯**を足してから渡す。
  枠いっぱいにバーコードが写っているとクワイエットゾーンが足りず読めないため。
  回転経路でもバーが並ぶのは canvas の横方向なので、足す位置は正立時と同じ。
  `BarcodeDetector` には足さない（端末側の実装に任せる）。
- 右上の `#engine` バッジは **`エンジン名 · N/s`** を 1 秒ごとに表示する動作確認用。
  `0/s` ならループが回っていない。デバッグの第一手として見る。
- 結果ダイアログを開いている間は解析を止め、`close` で即座に再開する。
  同じバーコードが枠内にあればすぐ読み直す（`1912ba5` で入れた検証用の挙動）。
- 作業用 canvas は `getContext('2d', { willReadFrequently: true })`。
  ZXing が `getImageData` を多用するため。

### photo.js

撮影も 2 系統。**`ImageCapture.takePhoto()` → 失敗したら `<video>` の現在フレーム**。

- `takePhoto()` はプレビューより高解像度で撮れるが、iOS Safari / Firefox は未対応。
  対応端末でも撮影モードに入れず失敗することがあるため、失敗したら
  `imageCapture = null` にして以後はフレーム取得に固定する。
- どちらの経路を使ったかは撮影ダイアログの `#photoInfo` に
  「静止画撮影」／「フレーム取得」と出る。
- **フロントカメラの反転**: プレビューは CSS で反転しているだけなので、画像側も揃える。
  フレーム取得経路は canvas 描画時に反転、`takePhoto` 経路は `mirrorBlob()` で
  再エンコードして反転する（再エンコードになるので必要なときだけ通す）。
- 出力は `image/jpeg` / quality `0.92`。ファイル名は `photo-YYYYMMDD-HHMMSS.<ext>`。
  拡張子は `takePhoto` の返す実 MIME に合わせる。
- 保存は `<a download>`（`#photoSaveBtn`）、共有は `navigator.canShare({files})` が
  true のときだけボタンを出す。
- objectURL は `releasePhoto()` で必ず revoke。ダイアログを閉じるときは
  **`img` から src を外してから** revoke する（表示中に revoke すると消える）。
- 撮影ダイアログを開いている間は `scanner.pause()`、閉じたら `resume()`。
  結果ダイアログと撮影ダイアログが重なるのを防ぐため。

## UI の約束ごと

- 画面は `#stage`（全画面）＞ `#frame`（映像の描画サイズに追従）で、
  UI は全部 `#frame` の中に重ねる。
- **`#frame.idle`**（カメラ停止中）が状態のスイッチ。`idle` のとき枠を画面いっぱいに
  広げ、`#scanArea` / `#engine` / `#flash` を隠す。`camera.js` の `setRunning()` が付け外しする。
- ダイアログは `<dialog>` + `showModal()`。未対応ブラウザ向けに
  `setAttribute('open', '')` のフォールバックを両方のダイアログに入れてある。
- ボタンの一時的なラベル変更（「コピーしました」「共有できません」など）は
  1.5 秒で元に戻す。`photo.js` は `dataset.label` に原文を退避している。

## vendor/

`vendor/README.md` に取得元・SHA-256・更新手順がある。**ファイルは無改変で置く。**
ファイル名にバージョンが入っているので、更新したら `barcode.js` の `ZXING_SRC` も
併せて変えること。ライセンス表記は上流に既知の不整合（MIT / Apache-2.0）があり、
同梱されていた Apache-2.0 全文を `vendor/zxing-LICENSE.txt` に置いている。

## 作業するときの注意

- **HTTPS か localhost でしか動かない。** `file://` で開くとカメラは起動しない。
  ローカル確認は `python -m http.server` 等でサーバ経由にする。
- デスクトップ Chrome は `BarcodeDetector` が使えず ZXing 経路になる。
  ネイティブ経路を確認したいなら Android 実機が必要。`ImageCapture` も
  同様に端末差が大きいので、**両方の経路を実機で確認する**こと。
- ブラウザ差分に対する防御（try/catch で握りつぶす、未対応なら `null` を返す、
  ダミーオブジェクトにフォールバックする）が随所にある。これは意図的なもので、
  「エラーを握りつぶしている」ように見えても消さないこと。理由はコメントに書いてある。
- コメントもコミットメッセージも日本語。既存の文体に合わせる。
- 性能に関わる定数（`SCAN_INTERVAL_MS`, `MAX_SCAN_SIDE`, `JPEG_QUALITY`,
  `ZXING_TIMEOUT_MS`）は各ファイル先頭にまとめてある。新しい定数も同じ場所に置く。
