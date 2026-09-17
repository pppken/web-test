# AGENTS.md

ブラウザだけで動く、カメラ／バーコード読み取り／撮影の検証用ページ。
ビルドもパッケージマネージャも使わない **静的サイト**で、GitHub Pages
(`https://github.com/pppken/web-test`) にそのまま置いて実機（主にスマートフォン）
から動作を確認する前提になっている。

## 構成

```
index.html   画面（マークアップ + CSS 全部）と、js を動的に読み込むローダ
camera.js    getUserMedia でのカメラ制御。barcode.js / photo.js のライフサイクル管理
barcode.js   バーコード検出（BarcodeDetector → ZXing フォールバック、
             選択で ZXing-C++ / Quagga2）
barcode-worker.js
             ZXing / ZXing-C++ の解析を回す Worker。barcode.js からのみ使う
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

#### ズーム

「ズーム」ボタン（`#zoomBtn`）で倍率を巡回させる。**設定できる値は端末が
`track.getCapabilities().zoom`（`{ min, max, step }`）で返したものだけ**で、
こちらから任意の倍率を投げることはしない。

- 巡回する段は `ZOOM_FACTORS`（現状 `[1, 2, 3, 5]`）を起動時に `buildZoomLevels()` で
  実際の値へ落として作る。`zoom` の尺度は端末差があり、`1〜8` で返すものもあれば
  `100〜400` で返すものもあるので、**絶対値ではなく `min`（＝等倍）の何倍か**で持つ。
  `step` がある端末は `min + step * n` しか受け付けないので `snapZoom()` で丸め、
  範囲を超えて `max` に張り付いたぶんは前の段と重なるので落とす
  （例: `max` が 2.5 倍の端末なら 1x / 2x / 2.5x の 3 段）。
- 次のいずれでもボタンは無効＋ラベル `ズーム: 非対応` になる。
  `getCapabilities()` が無い（Firefox）／例外を投げる／`zoom` を返さない
  （iOS Safari や大半の PC）／`min` と `max` が同じ／段が 1 つしか作れない。
- 適用は `applyConstraints({ advanced: [{ zoom }] })`。失敗したら選択を元に戻し、
  直前の倍率のまま使い続ける（前後切替・エンジン切替と同じ扱い）。
- ラベルの倍率は要求値ではなく `getSettings().zoom` の実値から出す（`currentZoom()`）。
  端末側で丸められることがあるため。起動時も同じ値を見て、一番近い段から巡回を始める。
- 段の並びはカメラごとに違うので、**起動のたびに `setupZoom()` で作り直す**
  （前後切替でも作り直す）。停止時は `clearZoom()` で捨てる。
- ズームしても `videoWidth / videoHeight` は変わらないので、barcode.js の切り出し座標には
  影響しない。photo.js も同じトラックを使うため、撮影結果にもそのまま効く。

### barcode.js

検出エンジンは 4 系統。**まず `BarcodeDetector`、駄目なら同梱 ZXing** に落ちる。
ZXing はさらに **Worker → メインスレッド** の 2 段になっていて、自動では
`BarcodeDetector` → `ZXing (Worker)` → `ZXing` の順に落ちる。
**ZXing-C++ と Quagga2 はこの自動の連鎖には入らない**（下の「エンジンの選択」を参照）。
いま何で動いているかは `#engine` のバッジにそのまま出る。

- **読み取る種類は `FORMATS` に集約してある。現状は CODE39 のみ。**
  `BarcodeDetector` には `code_39`、ZXing には `POSSIBLE_FORMATS` として、
  ZXing-C++ には `formats` として `Code39` を、
  Quagga2 には `decoder.readers` として `code_39_reader` を渡す。
  4 者とも表記が違うので 1 件につき 4 つ書く（`pdf417` / `PDF_417` のように
  大文字化だけでは揃わないものがあるため、機械変換にしていない）。
  結果の `format` は全経路で大文字表記（`CODE_39`）に揃えてから返す。
  ZXing-C++ だけは `Code39` のような独自表記で返ってくるので、`FORMATS` を逆に引いて直す
  （`zxingCppFormat()`。barcode.js と barcode-worker.js の両方に同じものがある）。
- `BarcodeDetector` は API があっても `getSupportedFormats()` が空配列を返す環境がある
  （`FORMATS` のどれも含まれない場合も同じ扱い。いずれも ZXing へ）。
  実行中に例外を投げた場合も `runDetect()` が捕まえて ZXing に切り替える。
- ZXing (`vendor/zxing-0.21.3.min.js`, 約 330KB)、
  ZXing-C++ (`vendor/zxing-wasm-reader-3.1.4.min.js`, 約 36KB ＋ wasm 約 930KB)、
  Quagga2 (`vendor/quagga2-1.12.1.min.js`, 約 150KB) は**必要になった時だけ**
  読み込む（Worker なら `importScripts`、それ以外は `loadScript()`）。
  ZXing と Quagga2 は `LIB_TIMEOUT_MS` = 10 秒、ZXing-C++ は wasm の取得とコンパイルまで
  待つので `WASM_INIT_TIMEOUT_MS` = 30 秒でタイムアウトさせる。
- **ZXing と ZXing-C++ の解析は既定で `barcode-worker.js` に投げる。** どちらも
  呼び出したスレッドを止めるので、メインスレッドで回すと解析のあいだ画面が固まる。
  Worker 側に移すと、メインスレッドに残るのは `drawImage` と `getImageData` だけになる。
  `ImageData` の `ArrayBuffer` は転送で渡す（コピーしない）ので、
  送ったあと元の `ImageData` は使えなくなる（毎フレーム作り捨てにしている）。
  どちらのエンジンを動かすかは init メッセージの `engine` で決まり、
  Worker 側の口（`{ id, width, height, buffer }` → `{ text, format } | null`）は共通。
  メインスレッド側も `createWorkerDetector()` 1 つを使い回す。
- Worker を作れない場合と、動き出した Worker が途中で落ちた場合は、
  `createZXingMainDetector()` / `createZXingCppMainDetector()` でメインスレッド実行に
  落ちる（`runDetect()` が面倒を見る）。遅くはなるが読み取り自体は続く。
- Worker には canvas が無いので `HTMLCanvasElementLuminanceSource` は使えない。
  代わりに同じ係数で自前に RGBA → 輝度へ変換し（メインスレッド経路と 1 バイトも
  違わないことを確認済み）、`RGBLuminanceSource` に渡している。
  こちらは `isRotateSupported()` が false だが、回転が要るのは `TRY_HARDER` を
  付けたときだけなので今は影響しない。**`TRY_HARDER` を入れるならここも見直すこと。**

#### エンジンの選択

Android 実機では `BarcodeDetector` が常に勝つため、自動のままだと ZXing や ZXing-C++、
Quagga2 の実力を実機で確かめられない。そこで「エンジン」ボタン（`#engineBtn`）で
**自動 / ZXing / ZXing-C++ / Quagga2** を巡回して選べるようにしてある。

- 選択は `localStorage['barcodeEngine']`
  （`'auto'` / `'zxing'` / `'zxing-cpp'` / `'quagga'`）に保存。
  既定は `'auto'`。camera.js の向き設定と同じく、読み書きとも try/catch で握りつぶす。
- カメラ稼働中に押した場合は**カメラを止めずに検出器だけ差し替える**。
  切替に失敗したら選択を元に戻し、直前のエンジンのまま読み取りを続ける
  （camera.js の前後切替と同じ扱い）。停止中に押したときは選択を覚えるだけ。
- 一度作った検出器は `detectorCache`（選択値 → `Promise<エンジン>`）に取っておく。
  行き来のたびにライブラリを読み直したり、ZXing の Worker を作り直したりしないため。
- 各検出器は `{ kind, name, detect }` を返し、`applyEngine()` が現在値として据える。
  `kind`（`'native'` / `'zxing-worker'` / `'zxing'` / `'zxing-cpp-worker'` /
  `'zxing-cpp'` / `'quagga'`）が、切り出し方
  （余白 `needsQuietZone()` ・回転 `needsRotation()`）とフォールバック先を決める。

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
- 解析オプションは `ZXING_CPP_OPTIONS`。`maxNumberOfSymbols: 1`（枠内に複数は想定しない）と
  `tryInvert: false`（ZXing 経路で `HTMLCanvasElementLuminanceSource` の第 2 引数を
  `false` にしているのと同じ理由）だけを指定し、`tryHarder` / `tryRotate` /
  `tryDownscale` は既定（いずれも true）のまま。
- **`tryRotate` が効くので 90 度回転は渡さない**（`needsRotation()` が false）。
  左右の白い帯（`SCAN_PAD_X`）は ZXing / Quagga2 と同じく足す。
- `readBarcodes()` は `{ data, width, height }` を `ImageData` として受け取るので、
  Quagga2 のように PNG に起こす必要は無い。RGBA → 輝度の変換はライブラリ側で
  ZXing 経路と同じ係数で行われる。
- 明示的に選ばれた経路なので、Worker が落ちたときにメインスレッド実行へ下りる以外は
  他のエンジンに落ちない。

#### Quagga2

`vendor/quagga2-1.12.1.min.js`。**選択したときだけ**使う読み比べ用の経路で、
自動では選ばれない。ZXing と違って次の制約がある。

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
  残り、スキャンループが二度と進まなくなる。`QUAGGA_DECODE_TIMEOUT_MS` = 3 秒で
  必ず打ち切る（`withTimeout()`）。
- 明示的に選ばれた経路なので、失敗しても他のエンジンには落ちない。
  `#engine` に「解析エラー」を出してループは回り続ける。

性能に直結するので、次の 4 点は安易に変えないこと（いずれもコメントに理由あり。
1 と 2 は ZXing（zxing-js）経路の話で、3 と 4 は全経路に効く）。

1. **`TRY_HARDER` を付けない。** 全フォーマット有効だと 1 回の解析が約 31ms → 311ms になり、
   実効 3 回/秒まで落ちる。縦向きバーコードは代わりに**こちら側で 1 フレームおきに
   90 度回転**させて対応している（`rotateNext`、ZXing 経路のみ。
   `BarcodeDetector` / ZXing-C++ / Quagga2 は向きを自前で処理するので常に正立で渡す）。
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
- **解析はプレビューのコピーに対して行う。** `copyPreviewFrame()` が `<video>` の現在の
  フレームから検出枠のぶんを `frameBuffer` へ複製し（正立・余白なし・`MAX_SCAN_SIDE` まで
  縮小済み）、`captureScanArea()` がそこに経路ごとの味付け（余白・回転）をして解析用の
  画像にする。**`<video>` を読むのはこの 1 箇所だけ。**
  - **コピーは枠のぶんだけにする。広げないこと。** 映像を丸ごと複製すると 1 回あたり
    約 200 万画素（1080p 縦持ち）を読むことになるが、実際に要るのは枠のぶん
    （縮小後で約 36 万画素）しかない。
  - 余白も回転も要らない経路（＝ `BarcodeDetector`）では `frameBuffer` をそのまま
    解析に渡す（canvas 間の複製を 1 回省く）。解析中はコピーが止まるので、
    渡したあとに書き換わることはない。
  - **解析中はコピーしない。** 1 回のコピーにつき解析は 1 回で、結果が返ってから次を
    コピーする。判定は `pendingDetects`（解析中の件数）で、0 のときだけコピーが通る。
    真偽値ではなく数なのは、ループを畳んだ直後に古い tick の解析がまだ返っていない
    ことがあるため。
  - 切り出し範囲（`#scanArea` の画面座標 → `getBoundingClientRect()` 差分で映像の実
    ピクセル座標）も `measureScanArea()` でコピーした瞬間に決めて `frameBuffer.crop` に
    控える。あとから測るとコピーした絵と枠がずれる。枠は中央基準なので、CSS の
    左右反転があっても座標は変わらない。
  - `frameBuffer` には `willReadFrequently` を立てない。読むのは `scanCanvases` 側で、
    こちらは描き込むだけ。立てるとソフトウェア canvas になり、映像からの複製が
    GPU からの読み戻しになって逆に重くなる。
  - `stop()` で `releasePreviewFrame()` を呼び、停止後に古いフレームを解析／表示しない
    ようにする。
- 同梱ライブラリの経路（ZXing / ZXing-C++ / Quagga2）では、切り出した画像の**左右に幅 `SCAN_PAD_X` = 50px の白い帯**を
  足してから渡す。枠いっぱいにバーコードが写っているとクワイエットゾーンが足りず
  読めないため。回転経路でもバーが並ぶのは canvas の横方向なので、足す位置は正立時と同じ。
  `BarcodeDetector` には足さない（端末側の実装に任せる）。
- 右上の `#engine` バッジは **`エンジン名 · N/s`** を 1 秒ごとに表示する動作確認用。
  `0/s` ならループが回っていない。デバッグの第一手として見る。
- 「検出画像」ボタン（`#scanPreviewBtn`）で、いま解析に渡しているのと同じ画像を
  `#scanPreview` ダイアログに出す。枠のズレ・余白・縮小後のバーの潰れを実機で見るための
  動作確認用。常に正立（`captureScanArea(false)`）で切り出し、PNG の data URL にして
  `<img>` に入れる。ボタンの有効・無効は `BarcodeScanner` の `start` / `stop` が切り替える。
  解析中に押されたときはコピーを行わないので、**いま解析に渡しているバッファがそのまま出る**。
- 結果ダイアログを開いている間は解析を止め、`close` で即座に再開する。
  同じバーコードが枠内にあればすぐ読み直す（`1912ba5` で入れた検証用の挙動）。
- ループを外から止める／回し直すのは `cancelLoop()` / `restartLoop()` の 2 つだけ。
  解析（`await`）の途中で停止されてもその呼び出しを畳めるよう、`runToken` で世代を
  数えている。これが無いと、解析待ちのあいだに停止 → 再開したときにループが
  二重に回り、ZXing の Worker には解析要求が重なって届く。
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
  同じ理由で、barcode.js 側も結果／検出画像のどちらかが開いていれば解析しない
  （`anyDialogOpen()`）。

## UI の約束ごと

- 画面は `#stage`（全画面）＞ `#frame`（映像の描画サイズに追従）で、
  UI は全部 `#frame` の中に重ねる。
- **`#frame.idle`**（カメラ停止中）が状態のスイッチ。`idle` のとき枠を画面いっぱいに
  広げ、`#scanArea` / `#engine` / `#flash` を隠す。`camera.js` の `setRunning()` が付け外しする。
- **`#video` の箱は常に映像そのものの大きさにする。** 枠の中で余白（レターボックス）を
  作らせない。そのために `#frame` は `align-items` / `justify-content` を中央寄せにし
  （既定の `stretch` だと `idle` のときだけ画面の高さまで引き伸ばされる）、`#video` の
  上限は `%`（＝高さが不定な枠が基準）ではなく `100vw` / `100dvh` で掛けている。
  - これを崩すと、`idle` を外した瞬間に video の箱の大きさが変わる
    （画面いっぱい → 映像そのもの。実測で 500x764 → 500x281 など）。
  - `barcode.js` の `captureScanArea()` も **video 要素の矩形＝映像の表示矩形**を前提に
    `videoWidth / rect.width` で倍率を出しているので、余白ができると切り出し位置がずれる。
- ダイアログは `<dialog>` + `showModal()`。未対応ブラウザ向けに
  `setAttribute('open', '')` のフォールバックを両方のダイアログに入れてある。
- ボタンの一時的なラベル変更（「コピーしました」「共有できません」など）は
  1.5 秒で元に戻す。`barcode.js` / `photo.js` とも `setLabel()` で行い、
  原文は `dataset.label` に退避している。
- 「エンジン」ボタン（`#engineBtn`）のラベルだけは常時その時の選択を表す
  （`エンジン: 自動` など）ので、`setLabel()` は通さず `renderEngineButton()` が書く。
  HTML 側の文字列は barcode.js が読めなかったときの見た目でしかない。
  カメラの状態に依らず押せる（停止中は選択を覚えるだけ）。
- 「ズーム」ボタン（`#zoomBtn`）も同じ扱いで、`renderZoomButton()` が
  `ズーム: 2.0x` / `ズーム: 非対応` / 停止中の `ズーム` を書く。
  こちらは端末の能力に依るので、稼働中でも非対応なら無効のまま。

## vendor/

`vendor/README.md` に取得元・SHA-256・更新手順がある。**ファイルは無改変で置く。**
ファイル名にバージョンが入っているので、更新したら `barcode.js` の `ZXING_SRC` /
`ZXING_CPP_SRC` / `ZXING_CPP_WASM` / `QUAGGA_SRC` も併せて変えること
（ZXing-C++ は js と wasm の 2 つで 1 組）。ZXing のライセンス表記は上流に既知の不整合
（MIT / Apache-2.0）があり、同梱されていた Apache-2.0 全文を
`vendor/zxing-LICENSE.txt` に置いている。Quagga2 は MIT で、全文は
`vendor/quagga2-LICENSE.txt`。zxing-wasm は MIT で `vendor/zxing-wasm-LICENSE.txt`、
wasm の中身の ZXing-C++ 本体は Apache-2.0（全文は `vendor/zxing-LICENSE.txt` と同じもの）。

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
- エンジンを変えたら `#engine` の N/s を実機で見ること。特に Quagga2 は
  PNG 経由でメインスレッド実行なので、端末によって速度が大きく変わる。
  ZXing-C++ は `tryHarder` / `tryRotate` / `tryDownscale` を既定のまま入れてあるので、
  端末によっては重く出る可能性がある。落ちるようなら `ZXING_CPP_OPTIONS` を削る。
- ブラウザ差分に対する防御（try/catch で握りつぶす、未対応なら `null` を返す、
  ダミーオブジェクトにフォールバックする）が随所にある。これは意図的なもので、
  「エラーを握りつぶしている」ように見えても消さないこと。理由はコメントに書いてある。
- コメントもコミットメッセージも日本語。既存の文体に合わせる。
- 性能に関わる定数（`SCAN_INTERVAL_MS`, `MAX_SCAN_SIDE`, `JPEG_QUALITY`,
  `LIB_TIMEOUT_MS`, `WASM_INIT_TIMEOUT_MS`, `QUAGGA_DECODE_TIMEOUT_MS`,
  `ZXING_CPP_OPTIONS`）は各ファイル先頭にまとめてある。新しい定数も同じ場所に置く。
