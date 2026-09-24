# AGENTS.md

ブラウザだけで動く、カメラ／バーコード読み取り／撮影の検証用ページ。
ビルドもパッケージマネージャも使わない **静的サイト**で、GitHub Pages
(`https://github.com/pppken/web-test`) にそのまま置いて実機（主にスマートフォン）
から動作を確認する前提になっている。

## 構成

```
index.html   画面（マークアップ + CSS 全部）と、js を動的に読み込むローダ
app.js       このページ固有の配線。DOM を探すのはここだけ
js/          ページに依存しないライブラリ。そのまま他へ持っていける
  camera.js    カメラの起動と停止（ズーム・明るさ含む）、フレームの取得と、
               検出結果の通知（フレームを detector に渡し、結果を onDetect で出す）
  barcode.js   camera.js から渡されたフレームの切り出し・前処理と、検出エンジンの
               選択・切り替え（BarcodeDetector → ZXing フォールバック、選択で ZXing-C++ / Quagga2）
  barcode-worker.js
               検出処理そのもの（BarcodeDetector / ZXing / ZXing-C++）。既定は Worker で、
               Worker が使えないときはメインスレッドに読み込まれる。barcode.js からのみ使う
  barcode-quagga2.js
               Quagga2 での検出処理。Worker に乗らないので分けてある。barcode.js からのみ使う
  barcode-preprocess.js
               バーコードの前処理（縦方向の集約）。検討中の機能で、
               barcode.js の frameFilter に差し込んだときだけ動く
  photo.js     静止画撮影（ImageCapture → video フレーム取得フォールバック）
vendor/      第三者ライブラリ（無改変で同梱）
```

- **依存関係なし。** npm も bundler もない。`index.html` をローカルサーバ経由で開けば動く。
- **テストなし・lint なし。** 検証は実機のブラウザで行う。
- CSS は `index.html` の `<style>` に全部入っている。別ファイルに切り出していない。
- **`js/` の中身はこのページを知らない。** ページ固有のものを足すなら `app.js` 側に置く。

## モジュールの約束ごと

**ライブラリ（`camera.js` / `barcode.js` / `barcode-preprocess.js` / `photo.js`）と、ページ（`app.js`）を分けてある。**
`barcode-worker.js` / `barcode-quagga2.js` は barcode.js の部品で、barcode.js が必要になったときに読み込む。
ライブラリ側は DOM を一切探さず、要素も結果の受け口も `configure()` で受け取る。
そのまま別のページ・別のプロジェクトに持っていけるようにするための分け方で、
**ライブラリ側に `getElementById` を書かないこと**が一番の約束ごと。

各 js は IIFE + `'use strict'` で、グローバルには**名前空間オブジェクトを 1 つだけ**生やす。

| ファイル | 公開するもの |
| --- | --- |
| `camera.js` | `window.CameraController = { configure, start, stop, switchCamera, watchPermission, zoomNext, setBrightness, pauseScan, resumeScan, isScanPaused, getZoomState, getBrightnessState, isRunning, getFacingMode, getTrack }` |
| `barcode.js` | `window.BarcodeScanner = { configure, start, stop, detect, setEngine, nextEngine, capturePreview, getEngineState, getEngineChoices, isActive }` |
| `barcode-worker.js` | Worker として読まれたときは何も生やさない（`onmessage` だけ）。メインスレッドに読まれたときは `window.BarcodeWorkerCore = { createDecoder }` |
| `barcode-quagga2.js` | `window.BarcodeQuagga2 = { createDecoder }` |
| `barcode-preprocess.js` | `window.BarcodePreprocess = { configure, filter, setMode, nextMode, getState, getChoices, getStats, resetStats, getLastOutput }` |
| `photo.js` | `window.PhotoCapture = { configure, attach, detach, capture, isActive, isBusy }` |
| `app.js` | なし（上記のライブラリを組み合わせる側） |

**ライブラリは互いを参照しない。** 結び付けるのは `app.js` の役目
（camera.js の `detector` に `BarcodeScanner.detect` を渡す、カメラが起動したら検出と撮影の
準備をする、ダイアログを開いている間はフレームの受け渡しを止める、前処理を barcode.js の
`frameFilter` に差し込む、など）。
依存の向きは **`app.js` → 各ライブラリ**の一方向だけ（barcode.js → barcode-worker.js /
barcode-quagga2.js は部品の読み込みなので例外）。

1 枚のフレームが結果になるまでの流れは次のとおり。

```
camera.js   フレームを取る（requestVideoFrameCallback で新しいものだけ）
  │ detector(frame)          ← app.js が BarcodeScanner.detect を渡してある
  ▼
barcode.js  検出枠のぶんを切り出す → 前処理（frameFilter。barcode-preprocess.js）
  │         → 余白・回転 → いまのエンジンの decode(request)
  ▼
barcode-worker.js（Worker / メインスレッド） or barcode-quagga2.js
  │ { text, format } | null
  ▼
camera.js   結果があれば autoPause して onDetect(result) → app.js が結果ダイアログを出す
```

各ライブラリは `configure(options)` で要素とコールバックを受け取る。要点は各ファイル
先頭のコメントに書いてある（そちらが一次情報）。共通する作りは次のとおり。

- コールバックは `on...` で受け、**呼び出し側が例外を投げてもライブラリ側は止まらない**
  （`emit()` が try/catch で握る）。
- エラーは `onError({ code, message, error })` で渡す。`code` は機械判定用、
  `message` は既定の日本語。文言を自前で用意するなら `code` だけを見ればよい。
- `localStorage` のキーは `storageKey` で差し替えられる（`null` で保存しない）。
  ホスト側のキーとぶつからないようにするため。
- 表示用の文言（ボタンのラベル、エンジン名の和訳、`静止画撮影`／`フレーム取得` など）は
  **ライブラリ側に持たない**。`app.js` の `ENGINE_LABELS` / `PHOTO_METHOD_LABELS` /
  `CAMERA_LABELS` が持つ。

重要な設計方針として、**呼び出し側は相手が無くても動く**。

```js
const scanner = window.BarcodeScanner || { configure() {}, start() {}, stop() {}, /* ... */ };
```

このダミーのフォールバックは意図的なもの。どれか 1 つの js の読み込みに失敗しても、
残りは動き続ける。以前は各モジュールが持っていたが、いまは `app.js` の先頭にまとめてある。
新しいモジュールを足すときも同じ形にすること。

### 読み込み順

`index.html` 末尾のローダが `js/camera.js` → `js/barcode.js` → `js/barcode-preprocess.js` →
`js/photo.js` → `app.js` の順に `script.async = false` で挿入する。
**ライブラリは互いを参照しないので順不同だが、`app.js` は必ず最後**（各 `window.*` を使うため）。
`js/barcode-preprocess.js` の行は消しても他は動く（検討中の前処理。下の「barcode-preprocess.js」を参照）。
`barcode-worker.js` / `barcode-quagga2.js` はローダには入れない。barcode.js が必要になったときに
読み込む（どちらも `?v=` 付き）。

また **各 js には `?v=<Date.now()>` が付く**。GitHub Pages が `max-age=600` を返すため、
実機検証でキャッシュを踏まないようにしている（検証用の措置なので、本番運用に
するなら見直す箇所）。HTML 自体は `<meta http-equiv="Cache-Control" content="no-cache">`
で毎回再検証させている。

## 各モジュールの要点

### camera.js

`configure({ video, facingMode, width, height, storageKey, mirrorClass, zoomFactors, detector, scanInterval, autoPause, on... })`。
`video` だけが必須。状態は `onStarting` / `onStart` / `onStop` / `onResolution` /
`onZoom` / `onBrightness` / `onError` で、検出結果は `onDetect` で流す。
`configure()` は設定を足すために何度でも呼べる（向きの復元と初期状態の通知は初回だけ）。

- `getUserMedia({ video: { facingMode: {ideal}, width/height: {ideal: 1920x1080} } })`。
  `ideal` なので、対応していない端末では別解像度・別カメラに落ちる。
- 前後カメラの選択は `localStorage['cameraFacingMode']`（`'environment'` / `'user'`）に保存。
  既定はリア。**起動に成功した向きだけ**を保存し、失敗時は前の向きに戻す。
  localStorage は private mode / `file://` で例外を投げうるので、読み書きとも try/catch で握りつぶす。
- フロントカメラは CSS の `transform: scaleX(-1)`（`#video.mirrored`）で鏡像表示するだけ。
  映像データ自体は反転していない。これが barcode.js / photo.js の座標・反転処理の前提になる。
  class 名は `mirrorClass` で変えられ、`null` を渡せば付けない（CSS は呼び出し側が用意する）。
- **`onStop` は silent な停止（前後切替の途中・ページ離脱）でも必ず呼ぶ。**
  `silent` は「停止した旨を画面に出すほどではない」という印でしかない。
  ここを黙らせると、前後切替のときに呼び出し側が読み取りや撮影を止め損ねる。
- Permissions API (`{ name: 'camera' }`) は Firefox / 一部 Safari で未対応なので、
  失敗しても `null` を返して無視する。`watchPermission()` は `granted` なら自動起動し、
  `change` でも自動起動する。
- `window.isSecureContext` でない場合は起動せず、`onError({ code: 'insecure-context' })` を出す。
- `pagehide` で必ずカメラを解放する。
- 起動したら呼び出し側が `scanner.start()` と `photo.attach({ facingMode, track })` を呼ぶ
  （`app.js` の `onStart`）。camera.js は他の 2 つを知らない。

#### フレームの受け渡し（検出のループ）

カメラが動いている間、フレームを 1 枚ずつ `detector` に渡し、返ってきた結果を
`onDetect` で知らせる（このページでは `detector` は `BarcodeScanner.detect`）。
`detector` を渡さなければフレームは取らない。

- **フレームは画素のコピーではなく `<video>` そのもの**（`{ video, width, height, time, serial,
  facingMode }`）。受け取った側が要る範囲（検出枠のぶん）だけを読めばよいため。
  映像を丸ごと複製すると 1 回あたり約 200 万画素（1080p 縦持ち）になる。
- `requestVideoFrameCallback` で届いたフレームを数え、**前回渡したものより新しいフレームが
  来るまで次を渡さない**（同じフレームを 2 回解析しない）。未対応のブラウザでは待たずに渡す。
- `SCAN_INTERVAL_MS = 120`（`scanInterval`。約 8 回/秒）。`setTimeout` は**解析完了後に予約**する
  （`setInterval` にするとフレームが溜まる）。`detector` の結果が返るまで次は渡さないので、
  解析が重なることはない。
- **`onDetect` を呼ぶ時点でフレームの受け渡しは止まっている**（`autoPause` の既定が true）。
  見せ終わったら `resumeScan()` を呼ぶこと。呼ばない限り読み直さない。
  止めないと、結果を見せている間も 8 回/秒で同じコードを拾い続ける。
- **ダイアログが開いているかどうかは camera.js は知らない。** 止める（`pauseScan()`）／
  再開する（`resumeScan()`）のは呼び出し側の責任（`app.js` の `syncScanning()`）。
- ループを外から止める／回し直すのは `cancelScan()` / `restartScan()` の 2 つだけ。
  解析（`await`）の途中で停止されてもその続きを畳めるよう、`scanToken` で世代を
  数えている。これが無いと、解析待ちのあいだに停止 → 再開したときにループが
  二重に回り、Worker には解析要求が重なって届く。
- `detector` が投げてもループは止めない（知らせるのは `detector` 側の役目）。
- 起動したら（`onStart` を出したあと）自動で回り始め、停止で畳む。
  検出側の準備（エンジンの読み込み）が終わるまでの `detector` は `null` を返すだけでよい。

#### ズーム

`zoomNext()` で倍率を巡回させる（このページでは「ズーム」ボタン `#zoomBtn`）。
**設定できる値は端末が
`track.getCapabilities().zoom`（`{ min, max, step }`）で返したものだけ**で、
こちらから任意の倍率を投げることはしない。

- 巡回する段は `ZOOM_FACTORS`（現状 `[1, 2, 3, 5]`）を起動時に `buildZoomLevels()` で
  実際の値へ落として作る。`zoom` の尺度は端末差があり、`1〜8` で返すものもあれば
  `100〜400` で返すものもあるので、**絶対値ではなく `min`（＝等倍）の何倍か**で持つ。
  `step` がある端末は `min + step * n` しか受け付けないので `snapZoom()` で丸め、
  範囲を超えて `max` に張り付いたぶんは前の段と重なるので落とす
  （例: `max` が 2.5 倍の端末なら 1x / 2x / 2.5x の 3 段）。
- 次のいずれでも `onZoom` の state が `supported: false` になる（app.js がボタンを無効にし、
  ラベルを `ズーム: 非対応` にする）。
  `getCapabilities()` が無い（Firefox）／例外を投げる／`zoom` を返さない
  （iOS Safari や大半の PC）／`min` と `max` が同じ／段が 1 つしか作れない。
- 適用は `applyConstraints({ advanced: [{ zoom }] })`。失敗したら選択を元に戻し、
  直前の倍率のまま使い続ける（前後切替・エンジン切替と同じ扱い）。
- state の `value` / `factor` は要求値ではなく `getSettings().zoom` の実値から出す（`currentZoom()`）。
  端末側で丸められることがあるため。起動時も同じ値を見て、一番近い段から巡回を始める。
- 段の並びはカメラごとに違うので、**起動のたびに `setupZoom()` で作り直す**
  （前後切替でも作り直す）。停止時は `clearZoom()` で捨てる。
- ズームしても `videoWidth / videoHeight` は変わらないので、barcode.js の切り出し座標には
  影響しない。photo.js も同じトラックを使うため、撮影結果にもそのまま効く。

#### 明るさ

`setBrightness(value)` で上げ下げする（このページでは「明るさ」ボタン `#brightnessBtn` で
スライダー `#brightnessPanel` を開閉する）。ズームと同じく**指定できる値は端末が `getCapabilities()` で返したものだけ**で、
こちらから範囲や刻みを決めることはしない。

- 使うのは `BRIGHTNESS_KEYS`（`['brightness', 'exposureCompensation']`）を順に見て
  **先に見つかったほう**。Android Chrome は `brightness` を返さず `exposureCompensation`
  だけを持つことが多く、逆に PC の UVC カメラは `brightness` を返す。どちらで動いているかは
  スライダー脇の読み値に出る（`exposureCompensation 2.00` など）。
  尺度も意味も端末任せなので、値はこちらで換算しない。
- `{ min, max, step }` はそのまま `onBrightness` の state に入れて渡す（app.js が
  `<input type="range">` にそのまま入れる）。`step` を返さない端末だけ
  保険として、範囲が `BRIGHTNESS_STEPS`（100）より広ければ 1 刻み（0〜255 のような整数の
  尺度に半端な値を送らないため）、狭ければ 100 等分にする。初期値は `getSettings()` の実値
  （端末が前回の設定を覚えていることがあるので、こちらでは初期化しない）。
- 次のいずれでも `onBrightness` の state が `supported: false` になる（app.js がボタンを
  無効にし、ラベルを `明るさ: 非対応` にする）。
  `getCapabilities()` が無い（Firefox）／例外を投げる／どちらのキーも返さない
  （iOS Safari など）／`min` と `max` が同じ。
- 適用は `applyConstraints({ advanced: [{ [key]: value }] })`。失敗したらスライダーを直前の
  値に戻し、その明るさのまま使い続ける（ズーム・前後切替・エンジン切替と同じ扱い）。
- **`setBrightness()` はスライダーを動かすたびに飛んでくるが、`applyConstraints` は
  1 つずつしか待てない。**
  適用中に動かされたぶんは最新の 1 つだけ `brightnessPending` に控え、終わってから続けて出す
  （間の値は捨てる）。溜めると指を離したあとも延々と追いかけることになる。
- ボタンのラベルは実値ではなく**範囲の何 %**（state の `ratio` を app.js の
  `renderBrightnessButton()` が使う）。値の尺度が端末ごとに違って倍率のようには
  読めないため。実値（`exposureCompensation 2.00` など）はスライダー脇に出す。
- **state の `reason` を見てからスライダーのつまみを書き戻すこと。**
  `setup`（起動・前後切替）と `failed`（適用に失敗して戻した）のときだけ書き戻す。
  `applied` でも毎回書き戻すと、適用を待っている間に動かされたぶんを巻き戻してしまい、
  指を離すまでつまみが引っかかったように見える。
- 範囲はカメラごとに違うので、**起動のたびに `setupBrightness()` で作り直す**
  （前後切替でも作り直し、開いていたスライダーは畳む）。停止時は `clearBrightness()`。
- `getCapabilities()` / `getSettings()` の読み出し（未対応・例外の握りつぶし）は
  ズームと共通の `readCapabilities()` / `readSettings()` にまとめてある。
- 映像そのものには手を入れないので barcode.js の切り出しには影響しない。
  photo.js も同じトラックを使うため、撮影結果にはそのまま効く。

### barcode.js

`configure({ scanArea, basePath, vendorPath, formats, engine, storageKey, frameFilter, on... })`。
`scanArea` が必須。状態は `onEngineChange(state)`、失敗は `onError({ code, message, error })` で流す。
**検出の入口は `detect(frame)`**（camera.js の `detector` に渡す）。フレームを切り出して
（前処理を通して）いまのエンジンに渡し、`Promise<{ text, format } | null>` を返す。
結果を知らせるのは camera.js（`onDetect`）で、barcode.js は返すだけ。
`start()` / `stop()` はカメラの起動・停止に合わせて呼ぶ（エンジンの用意と後始末だけ）。

- **映像はフレームごとに `frame.video` で受け取る。** 画面に出している `<video>` であること
  （検出枠との位置合わせを、その表示矩形で行うため）。最後に受け取ったフレームは
  `capturePreview()` が使う。
- 解析に失敗しても投げずに `null` を返し、`onError`（`detect-failed`）で知らせる。
- **パスは 2 つに分かれている。**
  `barcode-worker.js` / `barcode-quagga2.js` は `basePath` 起点（既定は **この js 自身の置き場所** ＝
  `document.currentScript.src` のディレクトリ）。同梱ライブラリは `vendorPath` 起点
  （既定は `basePath` の下の `vendor/`）。どちらも既定のままなら、
  `barcode.js` と `vendor/` を丸ごと同じ場所にコピーするだけで動く。
  このリポジトリは `js/` と `vendor/` を並べて置いているので、`app.js` が
  `vendorPath` を渡している。

検出エンジンは 4 系統。**まず `BarcodeDetector`、駄目なら同梱 ZXing** に落ちる。
Quagga2 以外はさらに **Worker → メインスレッド** の 2 段になっていて、自動では
`BarcodeDetector (Worker)` → `BarcodeDetector` → `ZXing (Worker)` → `ZXing` の順に落ちる
（`window` に `BarcodeDetector` が無ければ最初から ZXing）。
**検出そのものは barcode.js では行わない。** barcode.js は切り出した画像を
`barcode-worker.js`（Quagga2 だけ `barcode-quagga2.js`）の `decode` に渡すだけ。
**ZXing-C++ と Quagga2 はこの自動の連鎖には入らない**（下の「エンジンの選択」を参照）。
いま何で動いているかは `onEngineChange` の `name` に出る（このページでは `#engine` のバッジ）。

- **読み取る種類は `FORMATS` に集約してある。既定は CODE128 と JAN と CODE39**
  （JAN ＝ EAN-13 / EAN-8。13 桁と 8 桁は別フォーマット扱いなので全部で 4 件ある。
  `configure({ formats })` で差し替えられる）。
  `BarcodeDetector` には `code_128` / `ean_13` / `ean_8` / `code_39`、ZXing には `POSSIBLE_FORMATS`
  として `CODE_128` / `EAN_13` / `EAN_8` / `CODE_39`、ZXing-C++ には `formats` として
  `Code128` / `EAN13` / `EAN8` / `Code39`、Quagga2 には `decoder.readers` として
  `code_128_reader` / `ean_reader` / `ean_8_reader` / `code_39_reader` を渡す。
  4 者とも表記が違うので 1 件につき 4 つ書く（`pdf417` / `PDF_417` や
  EAN-13 の Quagga2 名が `ean_reader` であるように、
  大文字化だけでは揃わないものがあるため、機械変換にしていない）。
  ZXing-C++ の綴りは同梱 js の `ZXingWASM.barcodeFormats` が一覧。
  **綴りを間違えても例外にはならず黙って全フォーマットを見に行く**ので、
  増やすときはこの一覧と突き合わせること。
  結果の `format` は全経路で大文字表記（`CODE_128` / `EAN_13`）に揃えてから返す。
  ZXing-C++ だけは `EAN13` のような独自表記で返ってくるので、`FORMATS` を逆に引いて直す
  （`zxingCppFormat()`。barcode-worker.js にある。Worker でもメインスレッドでも同じコードを通る）。
  **引く順は `format` → `symbology`。** `symbology` は EAN13 / EAN8 のどちらでも
  `EANUPC` になり、13 桁と 8 桁を区別できない（3.1.4 で確認）。
  逆に CODE39 は `format` が `Code39Std` / `Code39Ext` になり `FORMATS` の `Code39` と
  一致しないので、`symbology`（`Code39`）のほうで拾われる。
- `BarcodeDetector` は API があっても `getSupportedFormats()` が空配列を返す環境がある
  （`FORMATS` のどれも含まれない場合も同じ扱い。いずれも ZXing へ）。
  実行中に例外を投げた場合も `analyze()` が捕まえて、`fallbackFor()` の落ち先
  （Worker → メインスレッド → ZXing）に切り替える。
- **`BarcodeDetector` も Worker で動かす**（仕様上 `DedicatedWorker` にも公開されている）。
  画像は `ImageBitmap` にして転送で渡す（画素の読み戻しは起きない）。Worker 側に
  `BarcodeDetector` が無い環境では、メインスレッドの `BarcodeDetector` に落ちる。
  **Android 実機で `#engine` が `BarcodeDetector (Worker)` になるかを確認すること**
  （デスクトップ Chrome には無いので、ヘッドレスでは偽物を入れたメインスレッド経路しか通せない）。
- ZXing (`vendor/zxing-0.21.3.min.js`, 約 330KB)、
  ZXing-C++ (`vendor/zxing-wasm-reader-3.1.4.min.js`, 約 36KB ＋ wasm 約 930KB)、
  Quagga2 (`vendor/quagga2-1.12.1.min.js`, 約 150KB) は**必要になった時だけ**
  読み込む（Worker なら `importScripts`、メインスレッドなら barcode.js の `loadScript()` を
  `createDecoder(message, load)` の `load` として渡す）。
  ZXing と Quagga2 は `LIB_TIMEOUT_MS` = 10 秒、ZXing-C++ は wasm の取得とコンパイルまで
  待つので `WASM_INIT_TIMEOUT_MS` = 30 秒でタイムアウトさせる。
- **解析は既定で `barcode-worker.js` の Worker に投げる。** どのエンジンも
  呼び出したスレッドを止めるので、メインスレッドで回すと解析のあいだ画面が固まる。
  メインスレッドに残るのは切り出し（`drawImage`）と転送のための `getImageData` /
  `createImageBitmap` だけになる。`ArrayBuffer` / `ImageBitmap` は転送で渡す（コピーしない）ので、
  送ったあと元は使えなくなる（毎フレーム作り捨てにしている）。
  どのエンジンを動かすかは init メッセージの `engine`（`'native'` / `'zxing'` / `'zxing-cpp'`）で決まる。
  解析の口は、画素で渡すもの（`{ width, height, buffer }`）と `ImageBitmap` で渡すもの
  （`{ bitmap }`。native）の 2 通りで、どちらも `{ text, format } | null` が返る。
  何で渡すかはエンジンの `input`（`'pixels'` / `'bitmap'` / `'canvas'`）で決まり、`toRequest()` が作る。
- **Worker を作れない場合と、動き出した Worker が途中で落ちた場合は、
  `barcode-worker.js` をそのまま `<script>` でメインスレッドに読み込んで使う**
  （`createMainEngine()`）。Worker として読まれたときは `onmessage` を、
  `<script>` として読まれたときは `window.BarcodeWorkerCore` を生やすだけなので、
  **検出コードは 1 か所にしかない**。遅くはなるが読み取り自体は続く。
- ZXing は canvas を使わず（Worker には無い）、同じ係数で自前に RGBA → 輝度へ変換して
  （本家の `HTMLCanvasElementLuminanceSource` と 1 バイトも違わないことを確認済み）
  `RGBLuminanceSource` に渡している。こちらは `isRotateSupported()` が false なので、
  `TRY_HARDER` を入れてある今も **ZXing 側の 90 度回転リトライは走らない**。
  縦向きバーコードは `rotateNext` で拾うので、そちらは外せない。

#### エンジンの選択

Android 実機では `BarcodeDetector` が常に勝つため、自動のままだと ZXing や ZXing-C++、
Quagga2 の実力を実機で確かめられない。そこで `setEngine(choice)` / `nextEngine()` で
**auto / zxing / zxing-cpp / quagga** を選べるようにしてある
（このページでは「エンジン」ボタン `#engineBtn` が `nextEngine()` を巡回で呼ぶ）。
選べる値は `getEngineChoices()` が返す。**日本語のラベルは barcode.js は持たない**
（`app.js` の `ENGINE_LABELS`）。

- 選択は `localStorage['barcodeEngine']`
  （`'auto'` / `'zxing'` / `'zxing-cpp'` / `'quagga'`）に保存。
  既定は `'auto'`。camera.js の向き設定と同じく、読み書きとも try/catch で握りつぶす。
- 読み取り中に呼んだ場合は**カメラを止めずに検出器だけ差し替える**。
  切替に失敗したら選択を元に戻し、直前のエンジンのまま読み取りを続ける
  （camera.js の前後切替と同じ扱い）。停止中に呼んだときは選択を覚えるだけ。
- 一度作った検出器は `detectorCache`（選択値 → `Promise<エンジン>`）に取っておく。
  行き来のたびにライブラリを読み直したり、ZXing の Worker を作り直したりしないため。
- 各エンジンは `{ base, kind, worker, name, input, decode }` で、`applyEngine()` が現在値として据える。
  `base`（`'native'` / `'zxing'` / `'zxing-cpp'` / `'quagga'`）が切り出し方
  （余白 `needsQuietZone()` ・回転 `needsRotation()`）を、`worker` がフォールバック先を決める。
  `kind` は `base` に `-worker` を足したもの（`'zxing-worker'` など）で、状態の通知用。

#### ZXing-C++（wasm）

`vendor/zxing-wasm-reader-3.1.4.min.js` ＋ `vendor/zxing-wasm-reader-3.1.4.wasm`
（[zxing-wasm](https://github.com/Sec-ant/zxing-wasm) の `reader` サブパスの IIFE 版）。
Quagga2 と同じく**選択したときだけ**使う読み比べ用の経路で、自動では選ばれない。

- **js と wasm の 2 つで 1 組。** 版を上げるときは `ZXING_CPP_SRC` と
  `ZXING_CPP_WASM` を両方とも直すこと。
- 既定の `locateFile` は wasm を jsDelivr から取りに行くので、`prepareZXingModule()` で
  同梱したもの（絶対 URL）を指すように差し替えている。`fireImmediately: true` にして、
  wasm の取得とコンパイルまで初期化のうちに終わらせる。ここを待たずに検出器を返すと、
  最初の数フレームの解析がまとめて待たされる。
- 解析オプションは `ZXING_CPP_OPTIONS`。**zxing-wasm 3.1.4 の ReaderOptions を、既定値のものも
  含めて全項目書いてある**（`formats` だけは `configure({ formats })` から barcode-worker.js が入れる）。
  既定値は同梱の js が持つ既定のオブジェクトで確認したもので、版を上げたら突き合わせ直すこと。
  既定から変えているのは `maxNumberOfSymbols: 1`（枠内に複数は想定しない）、
  `tryInvert: false`（白黒反転を試すと通常のバーコードの実効回数が落ちるため）、
  `tryDownscale: false` の 3 つ。`tryHarder: true` は既定と同じだが、重いときに最初に外す
  場所として意識しておく。`tryDownscale` を true にすると、ライブラリ側が
  `downscaleThreshold`（500）を超える辺だけを `downscaleFactor`（3）で縮めた層も読むので、
  `MAX_SCAN_SIDE` = 640 のこの経路では実際に走る。`tryRotate` は既定（true）のまま。
- **`tryRotate` が効くので 90 度回転は渡さない**（`needsRotation()` が false）。
  左右の白い帯（`SCAN_PAD_X`）は ZXing / Quagga2 と同じく足す。
- `readBarcodes()` は `{ data, width, height }` を `ImageData` として受け取るので、
  Quagga2 のように PNG に起こす必要は無い。RGBA → 輝度の変換はライブラリ側で
  ZXing 経路と同じ係数で行われる。
- 明示的に選ばれた経路なので、Worker が落ちたときにメインスレッド実行へ下りる以外は
  他のエンジンに落ちない。

#### Quagga2

`vendor/quagga2-1.12.1.min.js`。**選択したときだけ**使う読み比べ用の経路で、
自動では選ばれない。検出処理は `js/barcode-quagga2.js`（`window.BarcodeQuagga2`）にあり、
選ばれたときに barcode.js が読み込む。口は barcode-worker.js と同じ
`createDecoder(message, load)` だが、画素ではなく切り出した canvas をそのまま受け取る
（`input: 'canvas'`）。ZXing と違って次の制約がある。

- 公開 API の `decodeSingle()` は画像を **URL でしか受け取れない**ので、切り出した
  canvas を毎フレーム PNG の data URL にしてから渡している。`ImageData` を直接渡す口が
  無いため、PNG のエンコードとデコードが 1 フレームぶん丸ごと乗る。
- 同梱の UMD は読み込み時に `window` を直接参照するため、**Worker では動かない**。
  解析のあいだメインスレッドが止まる。上の 2 点とも読み比べ用と割り切って
  そのままにしてある。実際に何回回っているかは `#engine` の N/s を見ること。
- バーコードの位置と傾きは Quagga2 の locator が探すので、**90 度回転は渡さない**
  （`needsRotation()` が false）。`locator.halfSample` は `decodeSingle` の既定
  （`false`）のまま。`MAX_SCAN_SIDE` で既に縮めてあり、更に半分にするとバーが潰れる。
- 既定の `inputStream.size`（800）のままだと切り出した画像が引き伸ばされるので、
  実寸（`Math.max(width, height)`）を渡している。
  既定の `decoder.readers`（`code_128_reader`）は `FORMATS` の内容で置き換わる。
- `decodeSingle()` は画像の読み込みに失敗すると Promise が解決も棄却もされないまま
  残り、camera.js のループが二度と進まなくなる。`QUAGGA_DECODE_TIMEOUT_MS` = 3 秒（barcode-quagga2.js）で
  必ず打ち切る（`withTimeout()`）。
- 明示的に選ばれた経路なので、失敗しても他のエンジンには落ちない。
  `#engine` に「解析エラー」を出してループは回り続ける。

#### 差し込みの前処理（frameFilter）

`configure({ frameFilter })` で、解析に渡す画像を差し込んだ処理で作り直せる。
いまは `js/barcode-preprocess.js`（縦方向の集約。検討中）がここに入る。
**前処理にまつわるもの（定数・作業用 canvas・A/B の集計）は全部あちらにあり、
barcode.js が持つのはこの口だけ。** 既定の `null` なら従来どおり素通しで解析する。

- 呼ぶのは `detect()`（camera.js から来たフレーム）と `capturePreview()` の 2 か所だけ。
- 受け取る `frame` は `{ video, crop, preview, plain(), analyze(source) }`。
  `crop` は検出枠を映像の実ピクセル座標にしたもの（`measureFrame()` がコピーの直前に決める）。
  `plain()` は素通しの画像（余白・回転込み）、`analyze()` は解析して結果を返す
  （preview のときは解析せずに画像をそのまま返す）。
- 呼ばれるのは解析中でないときだけ。`analyze()` は 1 回の呼び出しにつき 1 回まで。
- 中身は下の「barcode-preprocess.js」を参照。

性能に直結するので、次の 4 点は安易に変えないこと（いずれもコメントに理由あり。
1 は ZXing（zxing-js）経路の話で、2〜4 は全経路に効く）。

1. **`TRY_HARDER` は入れてあるが、重くなったら最初にここを外す。** 全フォーマット有効
   だった頃は 1 回の解析が約 31ms → 311ms（実効 3 回/秒）まで落ちたので付けていなかったが、
   `FORMATS` を CODE39 だけに絞ったあとに測り直したところ、未検出フレーム
   （740x568、実機相当のサイズ）で **ZXing 0.9ms → 12.9ms、ZXing-C++ 1.0ms → 3.5ms**
   で収まった（検出フレームは 1 行目で当たるのでどちらも変わらない）。
   `SCAN_INTERVAL_MS = 120` に対しては十分小さい。**ただしこれはデスクトップでの数字で、
   しかも CODE39 1 本だった頃のもの。** いまは CODE128 と JAN と CODE39 の
   `Code128Reader` + `MultiFormatUPCEANReader` + `Code39Reader` の 3 本を回すぶん重く、
   実写フレームはさらに当たりが多い。実機では必ず `#engine` の N/s を見ること。
   なお縦向きバーコードは `TRY_HARDER` の回転リトライ任せにはできない。
   いまの `RGBLuminanceSource` は `isRotateSupported()` が false で走らず、
   以前メインスレッド経路で使っていた `HTMLCanvasElementLuminanceSource` も、true を返すのに
   `rotateCounterClockwise()` が縦横を入れ替えずに同じ寸法を返す（0.21.3 で確認済み。
   縦向きの画像を渡しても読めない）。
   これまで通り**こちら側で 1 フレームおきに 90 度回転**させて対応する
   （`rotateNext`、ZXing 経路のみ。`BarcodeDetector` / ZXing-C++ / Quagga2 は
   向きを自前で処理するので常に正立で渡す）。
   外すときは `false` を入れるのではなく `hints.set` ごと消すこと
   （`setHints` はキーの有無で見るため、`false` でも「あり」扱いになる）。
2. **白黒反転は試さない**（ZXing-C++ の `tryInvert: false`）。試すと通常のバーコードの
   実効回数が半減する（以前の ZXing メインスレッド経路の `HTMLCanvasElementLuminanceSource`
   の第 2 引数を `false` にしていたのと同じ理由）。
3. **`MAX_SCAN_SIDE = 640`** に縮小してから解析に渡す。グレースケール変換・二値化は
   画素数に比例するので、ここが効く。900 のときは大半の端末で切り出しサイズ
   （1080p 縦持ちで 864x768 程度）を下回らず、実質的に働いていなかった。
4. **作業用 canvas は正立用と回転用の 2 枚**（`scanCanvases`）。1 枚を使い回すと
   1 フレームおきに幅と高さが入れ替わり、毎フレーム canvas の再確保が走る。

切り出し（`detect(frame)` の中）:

- ループ（間隔・一時停止・世代の管理）は camera.js 側にある（「フレームの受け渡し」を参照）。
- **解析はフレームのコピーに対して行う。** `copyPreviewFrame()` が `frame.video` の現在の
  フレームから検出枠のぶんを `frameBuffer` へ複製し（正立・余白なし・`MAX_SCAN_SIDE` まで
  縮小済み）、`captureScanArea()` がそこに経路ごとの味付け（余白・回転）をして解析用の
  画像にする。**barcode.js の中で `<video>` を読むのはこの 1 箇所だけ**
  （`frameFilter` を差し込んだときは、そちらも同じ `crop` の範囲だけを読む）。
  - **コピーは枠のぶんだけにする。広げないこと。** 映像を丸ごと複製すると 1 回あたり
    約 200 万画素（1080p 縦持ち）を読むことになるが、実際に要るのは枠のぶん
    （縮小後で約 36 万画素）しかない。camera.js が画素ではなく `<video>` を渡してくるのも同じ理由。
  - 余白も回転も要らない経路（＝ `BarcodeDetector`）では `frameBuffer` をそのまま
    `ImageBitmap` にして渡す（canvas 間の複製を 1 回省く）。解析中はコピーが止まるので、
    渡したあとに書き換わることはない。
  - **解析中はコピーしない。** 1 回のコピーにつき解析は 1 回で、結果が返ってから次を
    コピーする。判定は `pendingDetects`（解析中の件数）で、0 のときだけコピーが通る。
    真偽値ではなく数なのは、停止した直後に古い解析がまだ返っていないことがあるため。
  - 切り出し範囲（`scanArea` の画面座標 → `getBoundingClientRect()` 差分で映像の実
    ピクセル座標）も `measureFrame()` でコピーの直前に決める。
    あとから測るとコピーした絵と枠がずれる。枠は中央基準なので、CSS の
    左右反転があっても座標は変わらない。
  - **基準にするのは `<video>` の箱ではなく、その中で映像が実際に描かれている矩形**
    （`videoContentRect()`）。`object-fit`（既定は `contain`）で上下か左右にレターボックスが
    できると、箱をそのまま基準にした切り出しは縮尺がずれる。`object-position` は
    既定（中央）を前提にしている。このページのように余白が出ないレイアウトでは
    箱の矩形と一致するので、結果は変わらない。
  - `frameBuffer` には `willReadFrequently` を立てない。読むのは `scanCanvases` 側で、
    こちらは描き込むだけ。立てるとソフトウェア canvas になり、映像からの複製が
    GPU からの読み戻しになって逆に重くなる。
  - `stop()` で `releasePreviewFrame()` を呼び、停止後に古いフレームを解析／表示しない
    ようにする。
- **（いまは一時的に `SCAN_PAD_X` = 0 で無効。戻すときは 50 にする）**
  同梱ライブラリの経路（ZXing / ZXing-C++ / Quagga2）では、切り出した画像の**左右に幅 `SCAN_PAD_X` = 50px の白い帯**を
  足してから渡す。枠いっぱいにバーコードが写っているとクワイエットゾーンが足りず
  読めないため。回転経路でもバーが並ぶのは canvas の横方向なので、足す位置は正立時と同じ。
  `BarcodeDetector` には足さない（端末側の実装に任せる）。
- `onEngineChange` は 1 秒ごとにも飛んでくる（`rate` に直近 1 秒の実際の解析回数が入る）。
  このページでは右上の `#engine` バッジに **`エンジン名 · N/s`** として出す動作確認用の表示。
  `0/s` なら camera.js のループが回っていない。デバッグの第一手として見る。
- `capturePreview()` が、いま解析に渡しているのと同じ画像を
  `Promise<{ canvas, width, height, pad, filtered }>` で返す（`frameFilter` を通すので非同期）。
  `frameFilter` が作った画像なら `filtered` が true で、`pad` は分からないので `null`。
  枠のズレ・余白・縮小後のバーの潰れを実機で見るための動作確認用。
  最後に受け取ったフレームの `<video>` から、常に正立（`captureScanArea(false)`）で切り出す。
  data URL にして `<img>` に入れるのは呼び出し側（このページでは「検出画像」ボタン
  `#scanPreviewBtn` → `#scanPreview` ダイアログ。ボタンの有効・無効は `onEngineChange` の
  `active` で決める）。
  解析中に呼ばれたときはコピーを行わないので、**いま解析に渡しているバッファがそのまま出る**。
- 結果ダイアログを開いている間はフレームの受け渡しを止め、`close` で即座に
  `camera.resumeScan()` する。同じバーコードが枠内にあればすぐ読み直す
  （`1912ba5` で入れた検証用の挙動）。
- 作業用 canvas は `getContext('2d', { willReadFrequently: true })`。
  画素で渡すエンジン（ZXing / ZXing-C++）のために `getImageData` を毎回呼ぶため。

### barcode-preprocess.js（前処理・検討中）

`configure({ mode, threshold, smooth, shear, debug, storageKey, onChange })`。
**検討中の機能なので、barcode.js から切り出して 1 ファイルに閉じ込めてある。**
barcode.js 側にあるのは `frameFilter` という差し込み口 1 つだけで、
`BarcodeScanner.configure({ frameFilter: BarcodePreprocess.filter })` を呼んだときだけ動く
（このページでは `app.js` の `setupPreprocess()` の中）。

- **無効にするだけなら** `app.js` の「組み立て」にある `setupPreprocess();` の 1 行を消す。
  前処理は一切走らず、「前処理」ボタンも出ない（`#preprocessBtn` は HTML 側で `hidden`）。
  保存済みの選択が `'ab'` でも結果ダイアログは普段どおり出る（`isBenchmarking()` が
  `setupPreprocess()` を通ったかを見ている）。
- **完全に外すなら** 次の 4 か所。barcode.js の `frameFilter` は既定 `null` の口なので残してよい。
  - `js/barcode-preprocess.js`
  - `index.html` のローダの 1 行と、`#preprocessBtn` / `#scanOutput` / `#scanWave` / `#scanWaveInfo`
  - `app.js` の「前処理」の節と `setupPreprocess();` の行
  - `app.js` の `isBenchmarking()` / `preprocessDebug()` / `formatStats()` の呼び出し元
    （バッジ・`onDetect`・検出画像ダイアログ。いずれも「前処理」とコメントしてある）
- ライブラリの約束ごと（DOM を探さない・`emit()` で例外を握る・`storageKey`）は他と同じ。
  映像と切り出し範囲はフレームごとに `frameFilter` の引数で受け取り、barcode.js を直接は参照しない。
- `filter(frame)` は 1 フレームぶんの画像を作って `frame.analyze()` まで呼ぶ。前処理を
  使わないフレーム（`'off'`・`'ab'` の素通し側・振幅不足）は `frame.plain()` で素通しの画像を
  もらう。A/B の入れ替えと検出率の集計もこの中で完結する。
  `frame.preview` のとき（検出画像の表示）は数えず、`'ab'` でも前処理ありのほうを出す。

ラベルプリンタで刷った細いバーコードは、**印字そのものが荒れている**せいで読めないことがある
（バーの縁が 1px 単位でがたつく・かすれる・黒点が乗る）。1D デコーダは 1 本のスキャンライン
だけを見るので、この 1px がそのまま run length の誤差になる。ZXing-C++ の Code128 は
1 要素あたり **±0.7 モジュール**までしか許さない（`ODCode128Reader.cpp` の
`MAX_INDIVIDUAL_VARIANCE`）ので、モジュールが 2〜3px の画像では余裕がほとんど無い。

バーコードは高さ方向には同じ模様が続くので、**複数ラインを 1 本の波形に集約してから
画像を作り直す**経路を足してある（`configure({ mode })`、このページでは
「前処理」ボタン `#preprocessBtn`）。`'off' | 'mean' | 'median' | 'trimmed' | 'ab'` で、
**既定は `'median'`**。選択は `localStorage['barcodePreprocess']` に保存する。

```
█ █▓█ █  ██
█ ███ █░ ██   →  高さ方向に集約  →  ████    ██████    ███    █████
█ ██▓ █  ██
```

処理は `capture()` の中で完結していて、順に次のとおり。

1. 検出枠のぶんを **横は実寸のまま**（`PRE_MAX_WIDTH` = 1280）・縦だけ `PRE_ROWS` = 32 段に
   潰して取り込む。**barcode.js の素通しの経路と違って `MAX_SCAN_SIDE`（640）は掛けない。**
   細バーの太さは横の解像度でしか決まらないため。縦を潰すぶん画素数はむしろ減る
   （1280x32 = 4 万画素 < 640x267 = 17 万画素）。
2. 上下の帯の波形を突き合わせて**傾き（シアー）を測る**（`estimateShear()`）。
3. 段ごとに横へずらしながら、x ごとに mean / median / trimmed mean で集約する。
4. 振幅を 0〜255 に伸ばす（`normalize()`）。ZXing-C++ は 1 行のヒストグラムで
   山を 2 つ探し、間隔が 16 階調未満だとその行を捨てる（`EstimateBlackPoint` が -1）。
5. **横に `PRE_SCALE` = 2 倍へ線形補間で引き伸ばす**（`upsample()`）。
6. `PRE_OUT_ROWS` = 100 行の画像に起こして解析へ渡す（全行が同じ内容）。

**5 は 3 とセットで、片方だけでは効かない。** 集約で得られるのは「エッジが x と x+1 の
どこにあるか」というサブピクセルの情報で、そのまま出すと run length が整数に丸められて
元に戻る。最近傍で伸ばしても同じなので、**必ず線形補間**にすること。

**`PRE_OUT_ROWS` は検証のため 2 から 100 に上げてある。** 実機の ZXing-C++ で
前処理ありだと検出しなかったので、高さ不足を疑っている。2 行にしていた理由は次の 3 つで、
戻すかどうかはこれを踏まえて決めること。
`minLineCount`（既定 2）を満たす最小の行数であること。`tryDownscale` が true だと、
3 行以上で `LumImagePyramid` が縮小層を作り（`min(w, h) >= downscaleFactor` = 3）、細バーを
潰した層まで走査すること（いまの `ZXING_CPP_OPTIONS` は false なので効かない）。2 行なら
`tryRotate` 側の走査も `width < 3` で即座に打ち切られること（100 行ではそのぶん重くなる）。

合成した荒れ印字（module 3px・傾き 1.2 度・縁のゆらぎ ±1px・ドット抜けあり、
ZXing-C++ で n=90）での実測は次のとおり。**荒れていないラベルではどれも 100% で、
解析回数（7〜8/s）も変わらない。**

| | 検出率 |
| --- | --- |
| A 前処理なし | 0% |
| B 縦 mean | 3〜5% |
| C 縦 median | 36〜44% |
| C2 縦 trimmed mean | 42〜45% |
| D median + 1D 平滑化 | 18〜21% |
| E median + adaptive 二値化 | 33〜38% |
| E2 median + otsu 二値化 | 34〜36%（荒れていないラベルで 0% になることあり） |
| F median + 傾き補正なし | 0% |

ここから決まっている既定が 4 つある。**理由なしに動かさないこと。**

- **mean ではなく median。** 縁が 1px 単位でゆらいでいるとき、mean はそのゆらぎの
  累積分布（＝数 px かけてなだらかに変わる傾斜）を作る。ZXing-C++ 側は 1 行の
  ヒストグラムでしきい値を決めるので、その傾斜のどこで切るかが黒白の面積比に
  引きずられて run length が systematic にずれる。median は「エッジ位置の中央値」に
  段を立て直すので縁の鋭さが戻る。trimmed mean はほぼ同じ（差は測定誤差の範囲）。
- **傾き補正は必須。** 1.2 度でも外すと 0%（荒れていないラベルでも 0%）。
  ROI の高さが 500px あれば 2 度で 17px ずれ、細バーは完全に潰れる。
- **こちら側で二値化しない**（`threshold` の既定は `'none'`）。ZXing-C++ 側は
  `(-p[-1] + 4*p[0] - p[1]) / 2` の鋭化を掛けてから run length を取る
  （`GlobalHistogramBinarizer.cpp` の `ThresholdSharpened`）。この鋭化は直線的な傾斜を
  素通しするので、傾斜のまま渡したほうがサブピクセルのエッジ位置が残る。
  `'otsu'` は ROI に台紙や背景が写り込むと山を「白 vs 灰」に割ってしまい、
  クワイエットゾーンごと黒に倒れる。読み比べ用に残してあるだけ。
- **1D 平滑化を入れない**（`smooth` の既定は false）。縦の集約でノイズは
  既に落ちていて、横に鈍らせると細バーの縁まで鈍る。

**縦に潰すので、バーが縦に並んでいることが前提になる。** 振幅が `PRE_MIN_CONTRAST`
未満のとき（枠内にバーコードが無い・バーが横向き）は前処理を諦め、その場で素通しの
経路に落ちる。ZXing-C++ の `tryRotate` 任せの縦向き読み取りはそちらで従来どおり動く。

**module width（最細バーが何 px あるか）が足りないとどうにもならない。** 同じ荒れ方で
module を 2px にすると、前処理あり・なしのどれも 0% になった。実測値は「検出画像」
ダイアログの波形の下に出る（集約画像の尺と、元映像に割り戻した尺の両方）。
2px しか無いようなら、前処理ではなくズーム・距離・解像度で稼ぐこと。

検証用の表示は `debug`（既定 true）で切る。切ると波形も最細バーの実測も
出なくなる代わりに、ROI のコピー以外は何も残さない。

**前処理の出力画像は `getLastOutput()` で直接もらう**（「検出画像」ダイアログの
`#scanOutput`。等倍・横スクロールで出す）。barcode.js の `capturePreview()` は解析の途中に
呼ばれると前処理に回さず素通しの画像を返すので、そちらだけでは前処理の出力を見られない
ことがあるため。写しを作るのは呼ばれたときだけで、毎フレームの負担は無い。
`capturePreview()` が前処理の画像を作り直してしまうので、**app.js は必ずその前に呼ぶ**。
振幅不足で見送ったフレームでは作り直さないので、古い画像のことがある（`time` で分かる）。
`debug` が false なら `null` を返す。

#### 検出率の比較（A/B）

`'ab'` を選ぶと、**1 フレームおきに前処理あり／なしを入れ替えて**それぞれの検出率を数える
（`getStats()`、`getState().stats`。`app.js` はバッジを描くたびに読みに行く）。このページでは `#engine` バッジに
`前 42% / 素 0%` と出る。別々に試すと持ち方や明るさが変わってしまうので、
**必ず交互に回したこのモードで比べること。** `app.js` はこのとき結果ダイアログを出さず、
`autoPause` も切る（1 枚読めたところで止まると数が溜まらないため）。

### photo.js

`configure({ video, quality, fileNamePrefix, on... })` のあと、カメラの起動・停止に合わせて
`attach({ facingMode, track })` / `detach()` を呼ぶ。撮影は `capture()`。

撮影は 2 系統。**`ImageCapture.takePhoto()` → 失敗したら `<video>` の現在フレーム**。

- `takePhoto()` はプレビューより高解像度で撮れるが、iOS Safari / Firefox は未対応。
  対応端末でも撮影モードに入れず失敗することがあるため、失敗したら
  `imageCapture = null` にして以後はフレーム取得に固定する。
- どちらの経路を使ったかは結果の `method`（`'still'` / `'frame'`）で分かる。
  和訳は `app.js` の `PHOTO_METHOD_LABELS`（このページでは `#photoInfo` に出す）。
- **フロントカメラの反転**: プレビューは CSS で反転しているだけなので、画像側も揃える。
  フレーム取得経路は canvas 描画時に反転、`takePhoto` 経路は `mirrorBlob()` で
  再エンコードして反転する（再エンコードになるので必要なときだけ通す）。
- 出力は `image/jpeg` / quality `0.92`。ファイル名は `photo-YYYYMMDD-HHMMSS.<ext>`。
  拡張子は `takePhoto` の返す実 MIME に合わせる。
- 結果は `{ blob, file, name, type, size, method }` で返す（`onPhoto` と `capture()` の
  戻り値の両方）。**photo.js は objectURL を作らない。** 作る・revoke するのは呼び出し側で、
  寿命の持ち主を 1 つにするため。
- 保存は `<a download>`（`#photoSaveBtn`）、共有は `navigator.canShare({files})` が
  true のときだけボタンを出す。どちらも `app.js` の仕事。
- objectURL は `app.js` の `releasePhoto()` で必ず revoke。ダイアログを閉じるときは
  **`img` から src を外してから** revoke する（表示中に revoke すると消える）。
- 撮影ダイアログを開いている間は解析を止め、閉じたら再開する。結果ダイアログと
  撮影ダイアログが重なるのを防ぐため。3 つのダイアログをまとめて見ているのは
  `app.js` の `anyDialogOpen()` / `syncScanning()` で、**photo.js は barcode.js を知らない**。
- フラッシュと振動は `onCaptureStart` で呼び出し側が行う。`takePhoto()` は完了までに
  時間がかかることがあるので、先に反応を返すために撮影の実処理より前に呼ぶ。

## UI の約束ごと

**ここに書いてあることは全部 `app.js` と `index.html` の話。** ライブラリ側は
DOM も CSS のクラス名も知らない（唯一の例外が camera.js の `mirrorClass`）。

- 画面は `#stage`（全画面）＞ `#frame`（映像の描画サイズに追従）で、
  UI は全部 `#frame` の中に重ねる。
- **`#frame.idle`**（カメラ停止中）が状態のスイッチ。`idle` のとき枠を画面いっぱいに
  広げ、`#scanArea` / `#engine` / `#flash` を隠す。`app.js` の `setRunning()` が付け外しする。
- **`#video` の箱は常に映像そのものの大きさにする。** 枠の中で余白（レターボックス）を
  作らせない。そのために `#frame` は `align-items` / `justify-content` を中央寄せにし
  （既定の `stretch` だと `idle` のときだけ画面の高さまで引き伸ばされる）、`#video` の
  上限は `%`（＝高さが不定な枠が基準）ではなく `100vw` / `100dvh` で掛けている。
  - これを崩すと、`idle` を外した瞬間に video の箱の大きさが変わる
    （画面いっぱい → 映像そのもの。実測で 500x764 → 500x281 など）。
  - 切り出し自体は `barcode.js` の `videoContentRect()` がレターボックスを差し引くので、
    余白ができても位置はずれない。**それでもこのレイアウトは崩さないこと。**
    箱の大きさが起動の瞬間に変わると、枠の見た目がその場で飛ぶ。
- ダイアログは `<dialog>` + `showModal()`。未対応ブラウザ向けに
  `setAttribute('open', '')` のフォールバックを `openDialog()` に入れてある。
- **ダイアログを開いたら解析を止め、閉じたら再開する。** 3 つ（結果 / 撮影 / 検出画像）を
  まとめて見ているのが `anyDialogOpen()` / `syncScanning()` で、開閉のたびに必ず通す
  （止めるのは camera.js の `pauseScan()` / `resumeScan()`）。
  ライブラリ側はダイアログの存在を知らないので、ここを飛ばすとモーダルが重なる。
- ボタンの一時的なラベル変更（「コピーしました」「共有できません」など）は
  1.5 秒で元に戻す。`setLabel()` で行い、原文は `dataset.label` に退避している。
  タイマーはボタンごとに持つ（`labelTimers`）。別のボタンを押したときに
  巻き戻らないようにするため。
- 「エンジン」ボタン（`#engineBtn`）のラベルだけは常時その時の選択を表す
  （`エンジン: 自動` など）ので、`setLabel()` は通さず `renderEngineButton()` が書く。
  HTML 側の文字列は `app.js` が読めなかったときの見た目でしかない。
  カメラの状態に依らず押せる（停止中は選択を覚えるだけ）。
- 「ズーム」ボタン（`#zoomBtn`）も同じ扱いで、`handleZoomChange()` が
  `ズーム: 2.0x` / `ズーム: 非対応` / 停止中の `ズーム` を書く。
  こちらは端末の能力に依るので、稼働中でも非対応なら無効のまま。
- 「明るさ」ボタン（`#brightnessBtn`）も同じで、`handleBrightnessChange()` が
  `明るさ: 60%` / `明るさ: 非対応` / 停止中の `明るさ` を書く。
  スライダー（`#brightnessPanel`）は `#controls` の中に幅いっぱい（`flex: 0 0 100%`）で
  置いてあり、ボタンが何行に折り返しても常にその上の行に出る。
  `#controls` は `pointer-events: none` なので、触る箱（`#brightnessControl`）だけ戻している。

## vendor/

`vendor/README.md` に取得元・SHA-256・更新手順がある。**ファイルは無改変で置く。**
ファイル名にバージョンが入っているので、更新したら `js/barcode.js` の `ZXING_SRC` /
`ZXING_CPP_SRC` / `ZXING_CPP_WASM` / `QUAGGA_SRC` も併せて変えること
（ZXing-C++ は js と wasm の 2 つで 1 組）。ZXing のライセンス表記は上流に既知の不整合
（MIT / Apache-2.0）があり、同梱されていた Apache-2.0 全文を
`vendor/zxing-LICENSE.txt` に置いている。Quagga2 は MIT で、全文は
`vendor/quagga2-LICENSE.txt`。zxing-wasm は MIT で `vendor/zxing-wasm-LICENSE.txt`、
wasm の中身の ZXing-C++ 本体は Apache-2.0（全文は `vendor/zxing-LICENSE.txt` と同じもの）。

## 他のプロジェクトで使う

**`js/` フォルダと `vendor/` をコピーし、`app.js` に相当する配線を呼び出し側で書く。**
`js/` の中身はこのページに依存しない。`index.html` と `app.js` がその実例になっている。

```js
BarcodeScanner.configure({
  scanArea: document.querySelector('.scan-area')
});

CameraController.configure({
  video: document.querySelector('video'),
  detector: BarcodeScanner.detect,        // フレームの受け渡し先
  onDetect: ({ text, format }) => {
    input.value = text;
    CameraController.resumeScan();       // 見せ終わったら必ず再開する
  },
  onStart: ({ facingMode, track }) => {
    BarcodeScanner.start();
    PhotoCapture.attach({ facingMode, track });
  },
  onStop: () => { BarcodeScanner.stop(); PhotoCapture.detach(); },
  onError: ({ code, message }) => { /* 好きに出す */ }
});
```

持っていくときに要るもの・気を付けること。

- **`<video>` と検出枠の要素は呼び出し側が用意する。** 枠は `getBoundingClientRect()` で
  測るだけなので、位置決めの方法は問わない（`position: absolute` でも grid でもよい）。
- **フロントカメラの鏡像表示の CSS** は呼び出し側に要る（既定では `#video.mirrored` に
  `transform: scaleX(-1)`）。`mirrorClass: null` を渡せば camera.js は class を付けない。
- `barcode-worker.js` / `barcode-quagga2.js` は `barcode.js` と同じ場所（`js/`）に置く。
  別の場所に置くなら `configure({ basePath })` で指す。
- `vendor/` は `js/vendor/` に置けば設定は要らない。このリポジトリのように
  別の場所へ置くなら `configure({ vendorPath })` で指す（`app.js` の実例を参照）。
  `.wasm` を `application/wasm` で返すサーバであることも確認すること。
- **`localStorage` のキー**（`cameraFacingMode` / `barcodeEngine` / `barcodePreprocess`）はホスト側と
  ぶつかりうるので、`storageKey` で名前空間を付けるか `null` で保存を切る。
- **読み取るフォーマットを変えるなら `configure({ formats })`。** 1 件につき
  `{ native, zxing, zxingCpp, quagga }` の 4 つとも書くこと（理由は `FORMATS` の項）。
- `?v=<Date.now()>` のキャッシュ迂回は `index.html` のローダ側の話なので付いてこない
  （barcode.js が Worker に付けるぶんだけは残る）。本番運用ならファイル名か
  クエリで版を管理すること。
- 表示の文言は全部呼び出し側で作れる。ライブラリが返す `onError` の `message` は
  既定の日本語なので、多言語にするなら `code` だけを見る。

## 作業するときの注意

- **HTTPS か localhost でしか動かない。** `file://` で開くとカメラは起動しない。
  ローカル確認は `python -m http.server` 等でサーバ経由にする。
  ZXing-C++ を試すときは、そのサーバが `.wasm` を `application/wasm` で返すかも見ること
  （返さないと `WebAssembly.instantiateStreaming` が失敗する。ArrayBuffer 経由に
  落ちるので動きはするが、実機の GitHub Pages と条件が変わる）。
- デスクトップ Chrome は `BarcodeDetector` が使えず ZXing 経路になる。
  ネイティブ経路を確認したいなら Android 実機が必要。`ImageCapture` も
  同様に端末差が大きいので、**両方の経路を実機で確認する**こと。
- **iPhone で、検出枠に物を入れるとプレビューが一瞬ずれて見えるのはカメラの
  フォーカス動作。** 標準のカメラアプリでも同じように再現するので、このページ側の
  問題ではない（2026-09 に調査済み）。似た見え方を報告されたら、まず標準カメラアプリで
  再現するかを確かめること。
- エンジンを変えたら `onEngineChange` の `rate`（このページでは `#engine` の N/s）を
  実機で見ること。特に Quagga2 は
  PNG 経由でメインスレッド実行なので、端末によって速度が大きく変わる。
  ZXing-C++ は `tryHarder` / `tryDownscale`（いずれも明示）/ `tryRotate` が有効なので、
  端末によっては重く出る可能性がある。落ちるようなら `ZXING_CPP_OPTIONS` を削る。
  ZXing（zxing-js）側の `TRY_HARDER` も同じで、重いときに最初に外す候補。
- ブラウザ差分に対する防御（try/catch で握りつぶす、未対応なら `null` を返す、
  ダミーオブジェクトにフォールバックする）が随所にある。これは意図的なもので、
  「エラーを握りつぶしている」ように見えても消さないこと。理由はコメントに書いてある。
- **ライブラリ側（camera.js / barcode.js / barcode-worker.js / barcode-quagga2.js /
  barcode-preprocess.js / photo.js）に `getElementById` を書かないこと。**
  DOM を探すのは `app.js` だけ。UI の都合が出てきたらコールバックを 1 つ足して、
  描画は `app.js` にやらせる。
- コメントもコミットメッセージも日本語。既存の文体に合わせる。
- 性能に関わる定数（camera.js の `SCAN_INTERVAL_MS`、barcode.js の `MAX_SCAN_SIDE` /
  `LIB_TIMEOUT_MS` / `WASM_INIT_TIMEOUT_MS` / `ZXING_CPP_OPTIONS`、barcode-quagga2.js の
  `QUAGGA_DECODE_TIMEOUT_MS`、photo.js の `DEFAULT_QUALITY`）は各ファイル先頭にまとめてある。
  新しい定数も同じ場所に置く。ZXing の `TRY_HARDER` だけは検出処理の中
  （barcode-worker.js の `createZXing()`）にある。
