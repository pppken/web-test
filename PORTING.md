# 移植ガイド: カメラ起動とバーコード読み取り

このリポジトリのカメラ起動（`js/camera.js`）とバーコード読み取り（`js/barcode.js` ほか）を、
別のプロジェクトに持っていくための資料。撮影（`photo.js`）と前処理（`barcode-preprocess.js`）は
任意なので、末尾の「任意のモジュール」に分けて書いてある。

各 API の細かい約束ごとは各 js の先頭コメントと `AGENTS.md` が一次情報。
この資料は「何をコピーして、どう配線すれば動くか」に絞っている。

---

## 1. 全体像

```
<video>（呼び出し側が用意）
   │
camera.js      getUserMedia でカメラを起動し、フレームを 1 枚ずつ detector に渡す
   │ detector(frame)          ← BarcodeScanner.detect を渡す
   ▼
barcode.js     検出枠（呼び出し側が用意した要素）のぶんだけ切り出して、エンジンに渡す
   │
   ▼
barcode-worker.js（Worker）  BarcodeDetector / ZXing / ZXing-C++ で検出
   │ { text, format } | null
   ▼
camera.js      見つかったら自動で一時停止して onDetect(result) を呼ぶ
```

- **ライブラリは DOM を探さない。** `<video>` と検出枠の要素は `configure()` で渡す。
- **camera.js と barcode.js は互いを知らない。** 結び付けるのは呼び出し側のコード（この資料の例）。
- ビルド不要・依存なし。`<script>` で読み込むと `window.CameraController` /
  `window.BarcodeScanner` が生える。

---

## 2. 必要なファイル

### コピーするもの

| ファイル | 必須 | 役割 |
| --- | --- | --- |
| `js/camera.js` | 必須 | カメラの起動・停止、ズーム・明るさ、フレームの受け渡し |
| `js/barcode.js` | 必須 | 切り出しとエンジンの選択・切り替え |
| `js/barcode-worker.js` | 必須 | 検出そのもの（Worker としても `<script>` としても読まれる）。barcode.js が自分で読み込む |
| `js/barcode-quagga2.js` | 任意 | Quagga2 を選んだときだけ使う |
| `vendor/zxing-wasm-reader-3.1.4.min.js` | 必須 ※1 | ZXing-C++（wasm）。**起動時の既定のエンジン** |
| `vendor/zxing-wasm-reader-3.1.4.wasm` | 必須 ※1 | 上の js と 2 つで 1 組 |
| `vendor/zxing-0.21.3.min.js` | 必須 ※2 | ZXing（JS 版）。`auto` で `BarcodeDetector` が無い環境の落ち先 |
| `vendor/quagga2-1.12.1.min.js` | 任意 | Quagga2 を選んだときだけ使う |
| `vendor/*-LICENSE.txt`, `vendor/README.md` | 推奨 | ライセンス全文と取得元・SHA-256 |

※1 エンジンを `auto` / `zxing` に固定するなら不要。
※2 `auto` を使わず ZXing-C++ に固定するなら不要。ただし迷ったら **`js/` と `vendor/` を丸ごとコピー**するのが確実。

任意のファイルを省いた場合、そのエンジンを選んだときに `onError({ code: 'engine-switch-failed' })`
が出て、直前のエンジンのまま読み取りが続く（止まりはしない）。

### 置き方

**おすすめ: `vendor/` を `js/` の下に入れる。** barcode.js の既定がこの形なので設定が要らない。

```
your-app/
  index.html
  main.js           ← 呼び出し側のコード（このリポジトリの app.js にあたる）
  lib/scanner/      ← 名前は自由
    camera.js
    barcode.js
    barcode-worker.js
    barcode-quagga2.js
    vendor/
      zxing-0.21.3.min.js
      zxing-wasm-reader-3.1.4.min.js
      zxing-wasm-reader-3.1.4.wasm
      quagga2-1.12.1.min.js
      ...LICENSE.txt
```

このリポジトリのように `js/` と `vendor/` を並べて置く場合は、`vendorPath` で指す。

```js
BarcodeScanner.configure({
  scanArea,
  vendorPath: new URL('vendor/', document.baseURI).href
});
```

| パス | 既定 | 変えるオプション |
| --- | --- | --- |
| `barcode-worker.js` / `barcode-quagga2.js` | barcode.js 自身と同じディレクトリ | `basePath` |
| `vendor/` のライブラリ | `basePath` の下の `vendor/` | `vendorPath` |

---

## 3. 動作条件と注意

- **HTTPS か `http://localhost` でしか動かない。** `file://` や LAN の `http://` ではカメラが起動せず、
  `onError({ code: 'insecure-context' })` が出る。ローカル確認は `python -m http.server` などを使う。
- **`.wasm` を `application/wasm` で返すサーバにする。** 返さないと ZXing-C++ の読み込みが遅い経路に
  落ちる（動きはする）。
- **js は同じオリジンに置く。** barcode.js は `barcode-worker.js` を `new Worker()` で起動するので、
  CDN など別オリジンに置くと Worker が作れない。
- **普通の `<script>` で読み込む。** barcode.js は `document.currentScript.src` から自分の置き場所を
  求めている。`type="module"` や bundler に通すと取れないので、その場合は `basePath` を明示する。

  ```js
  BarcodeScanner.configure({ scanArea, basePath: '/lib/scanner/' });
  ```
- **`<video>` には `playsinline muted autoplay` を付ける。** iOS Safari で全画面再生に切り替わったり、
  再生が始まらなかったりするのを防ぐ。
- **検出枠は `<video>` の表示に重ねて置く。** 切り出しは「`<video>` の中で映像が描かれている矩形」と
  「検出枠の `getBoundingClientRect()`」の差で決まる。
  `object-fit` のレターボックスは差し引かれるが、`object-position` は中央（既定）を前提にしている。
- 1D バーコード（横長）を想定した作り。検出枠も横長にする。
- 解析に回す画像の縮め方は検出枠の形で変わる（barcode.js の `scanSize()`）。幅が高さの 2 倍以上の横長の枠なら
  横は 1280px まで実寸で残し（縦向きのバーコードは読まない）、それより正方形に近い枠は長辺 640px に縮める。
  正方形に近い大きな枠にすると細いバーが潰れる。

---

## 4. 最小構成のコード例

カメラを起動し、検出枠の中のバーコードを読んで画面に出すだけの 1 ページ。
下の 2 ファイルを `lib/scanner/`（前節の置き方）と同じ階層に置けば、そのまま動く。

### index.html

```html
<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>バーコード読み取り</title>
  <style>
    body {
      margin: 0;
      font-family: system-ui, sans-serif;
      background: #111;
      color: #fff;
    }

    /* 映像の描画サイズにぴったり追従する箱。検出枠はこの中に重ねる */
    .camera {
      position: relative;
      width: fit-content;
      max-width: 100%;
      margin: 0 auto;
      background: #000;
    }

    /* 箱を映像そのものの大きさにして、レターボックスを作らない */
    .camera video {
      display: block;
      width: auto;
      height: auto;
      max-width: 100vw;
      max-height: 70vh;
    }

    /* フロントカメラの鏡像表示。camera.js が 'mirrored' クラスを付け外しする */
    .camera video.mirrored {
      transform: scaleX(-1);
    }

    /* 検出枠。この要素の矩形の内側だけを切り出して解析する */
    .scan-area {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 90%;
      height: 25%;
      border: 2px solid rgba(255, 255, 255, 0.9);
      border-radius: 12px;
      box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.35);
      pointer-events: none;
    }

    .camera.idle .scan-area {
      display: none;
    }

    .controls {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: center;
      padding: 12px;
    }

    .status {
      text-align: center;
      font-size: 14px;
      opacity: 0.8;
    }

    .result {
      margin: 12px;
      padding: 12px;
      border-radius: 8px;
      background: #222;
      word-break: break-all;
    }
  </style>
</head>
<body>
  <div class="camera idle" id="camera">
    <video id="video" playsinline muted autoplay></video>
    <div class="scan-area" id="scanArea" aria-hidden="true"></div>
  </div>

  <div class="controls">
    <button id="startBtn" type="button">カメラ起動</button>
    <button id="stopBtn" type="button">停止</button>
    <button id="switchBtn" type="button">前後切替</button>
    <button id="rescanBtn" type="button" hidden>もう一度読む</button>
  </div>

  <p class="status" id="status">停止中</p>
  <p class="status" id="engine"></p>
  <div class="result" id="result" hidden></div>

  <!-- 読み込み順: ライブラリ（順不同）→ 呼び出し側（必ず最後） -->
  <script src="lib/scanner/camera.js"></script>
  <script src="lib/scanner/barcode.js"></script>
  <script src="main.js"></script>
</body>
</html>
```

### main.js

```js
(() => {
  'use strict';

  const cameraBox = document.getElementById('camera');
  const video = document.getElementById('video');
  const scanArea = document.getElementById('scanArea');
  const statusText = document.getElementById('status');
  const engineText = document.getElementById('engine');
  const resultBox = document.getElementById('result');
  const rescanBtn = document.getElementById('rescanBtn');

  const camera = window.CameraController;
  const scanner = window.BarcodeScanner;

  // --- バーコード読み取り -------------------------------------------

  scanner.configure({
    scanArea,
    // vendor/ を barcode.js と同じ場所に置いていれば vendorPath は要らない
    // vendorPath: new URL('vendor/', document.baseURI).href,

    // localStorage のキーがホスト側とぶつからないように名前空間を付ける（null なら保存しない）
    storageKey: 'myapp.barcodeSettings',

    // 状態の通知。status は 'idle' / 'loading' / 'ready' / 'error'、rate は直近 1 秒の解析回数
    onEngineChange: ({ status, name, rate }) => {
      if (status === 'idle') engineText.textContent = '';
      else if (status === 'loading') engineText.textContent = 'エンジンを準備中...';
      else engineText.textContent = rate === null ? name : `${name} · ${rate}/s`;
    },

    onError: ({ code, message }) => {
      // detect-failed は 1 フレームごとに起きうるので、ここでは出さない
      if (code === 'detect-failed') return;
      statusText.textContent = message;
    }
  });

  // --- カメラ ---------------------------------------------------------

  camera.configure({
    video,
    storageKey: 'myapp.cameraFacingMode',

    // フレームの渡し先。barcode.js の検出をそのまま渡す
    detector: scanner.detect,

    // 読み取れたら呼ばれる。この時点でフレームの受け渡しは止まっている（autoPause）
    onDetect: ({ text, format }) => {
      if (navigator.vibrate) navigator.vibrate(60);
      resultBox.textContent = `${format}: ${text}`;
      resultBox.hidden = false;
      rescanBtn.hidden = false;
      // 読み直すときは camera.resumeScan() を呼ぶ（呼ばない限り止まったまま）
    },

    onStarting: () => {
      statusText.textContent = 'カメラを起動中...';
    },

    // カメラが起動したらエンジンを用意する。フレームは camera.js が勝手に渡してくる
    onStart: ({ facingMode }) => {
      cameraBox.classList.remove('idle');
      statusText.textContent = facingMode === 'user' ? 'フロントカメラ' : 'リアカメラ';
      scanner.start();
    },

    // 前後切替の途中・ページ離脱でも必ず呼ばれる（silent が true）
    onStop: ({ silent }) => {
      cameraBox.classList.add('idle');
      scanner.stop();
      if (!silent) statusText.textContent = '停止中';
    },

    onError: ({ message }) => {
      statusText.textContent = message;
    }
  });

  // --- ボタン ---------------------------------------------------------

  document.getElementById('startBtn').addEventListener('click', () => camera.start());
  document.getElementById('stopBtn').addEventListener('click', () => camera.stop());
  document.getElementById('switchBtn').addEventListener('click', () => camera.switchCamera());

  rescanBtn.addEventListener('click', () => {
    resultBox.hidden = true;
    rescanBtn.hidden = true;
    camera.resumeScan();
  });

  // 権限が許可済みなら自動で起動する（未許可ならボタンを押すまで待つ）
  camera.watchPermission();
})();
```

### 押さえるべき配線（4 点）

1. `camera.configure({ detector: scanner.detect })` — フレームを barcode.js に渡す。
2. `onStart` で `scanner.start()`、`onStop` で `scanner.stop()` — エンジンの用意と後始末。
3. `onDetect` のあと、**読み直すなら `camera.resumeScan()`** — 呼ばない限り読み直さない。
4. ライブラリの `<script>` を呼び出し側より先に読み込む。

---

## 5. よくある使い方

### 読み取ったら入力欄に入れて、少し待って次を読む

```js
camera.configure({
  onDetect: ({ text }) => {
    document.querySelector('#code').value = text;
    setTimeout(() => camera.resumeScan(), 1500);
  }
});
```

`configure()` は何度でも呼べる（渡したものだけ上書きされる）。

### モーダルを開いている間は読み取りを止める

ライブラリはダイアログの存在を知らないので、開閉に合わせて呼び出し側で止める。

```js
dialog.addEventListener('close', () => camera.resumeScan());

function openDialog() {
  camera.pauseScan();   // カメラは動かしたまま、フレームの受け渡しだけ止める
  dialog.showModal();
}
```

複数のダイアログがあるなら「どれか 1 つでも開いていれば止める」関数を 1 つ作り、開閉のたびに
必ず通すこと（このリポジトリの `app.js` の `syncScanning()`）。

### 止めずに連続で読む

```js
camera.configure({
  autoPause: false,
  onDetect: ({ text }) => {
    if (text === lastText) return;  // 同じコードを 8 回/秒で拾い続けるので、自前で間引く
    lastText = text;
    list.append(text);
  }
});
```

### 読み取るフォーマットを変える

既定は **CODE128 / EAN-13 / EAN-8 / CODE39**。

- **既定の 4 種類から絞る**: `scanner.setFormats(['CODE_128', 'EAN_13'])`（`configure()` のあとに呼ぶ。
  選択は `storageKey` に保存される。1 つも無い指定は受け付けない）。
- **種類そのものを差し替える**: `configure({ formats })`。エンジンごとに表記が違うので、
  1 件につき 4 つとも書く。

```js
scanner.configure({
  scanArea,
  formats: [
    { native: 'code_128', zxing: 'CODE_128', zxingCpp: 'Code128', quagga: 'code_128_reader' },
    { native: 'itf',      zxing: 'ITF',      zxingCpp: 'ITF',     quagga: 'i2of5_reader' }
  ]
});
```

| キー | 渡す先 | 綴りの一覧 |
| --- | --- | --- |
| `native` | `BarcodeDetector` | `BarcodeDetector.getSupportedFormats()` |
| `zxing` | ZXing（JS 版）の `BarcodeFormat`。**結果の `format` もこの表記に揃う** | zxing-js の `BarcodeFormat` |
| `zxingCpp` | ZXing-C++ | 同梱 js の `ZXingWASM.barcodeFormats` |
| `quagga` | Quagga2 の `decoder.readers` | Quagga2 の Readers |

**ZXing-C++ は綴りを間違えても例外にならず、黙って全フォーマットを探しに行く。** 増やすときは
一覧と突き合わせること。Quagga2 は 2D コード（QR など）を読めない。

### エンジンを選ぶ

| 値 | 中身 |
| --- | --- |
| `'zxing-cpp'` | **既定。** ZXing-C++（wasm）。Worker で動く |
| `'auto'` | `BarcodeDetector`（Worker → メインスレッド）→ 無ければ ZXing（Worker → メインスレッド） |
| `'zxing'` | ZXing（JS 版） |
| `'quagga'` | Quagga2（メインスレッドで動く。読み比べ用） |

```js
scanner.configure({ scanArea, engine: 'auto' }); // 起動時のエンジン（保存しない）
scanner.setStartupEngine('auto');                 // 起動時のエンジンを保存して、いまも切り替える
scanner.setEngine('zxing');                       // その場限りの切り替え（カメラは止めない）
```

どれで動いているかは `onEngineChange` の `name` に出る。Worker を作れない環境や、
Worker が途中で落ちた場合は、同じ検出コードをメインスレッドで動かす（遅くはなるが止まらない）。

### ズームと明るさ（任意）

端末が `track.getCapabilities()` で返した範囲だけを使う。iOS Safari や大半の PC は非対応で、
そのときは `supported: false` が届く。

```js
camera.configure({
  onZoom: ({ supported, factor }) => {
    zoomBtn.disabled = !supported;
    zoomBtn.textContent = supported ? `ズーム: ${factor.toFixed(1)}x` : 'ズーム: 非対応';
  },
  onBrightness: ({ supported, min, max, step, value, reason }) => {
    slider.disabled = !supported;
    if (!supported) return;
    slider.min = min;
    slider.max = max;
    slider.step = step;
    // 起動時と失敗時だけ書き戻す（applied で書き戻すと、ドラッグ中のつまみが巻き戻る）
    if (reason === 'setup' || reason === 'failed') slider.value = value;
  }
});

zoomBtn.addEventListener('click', () => camera.zoomNext());          // 1x → 2x → 3x → 5x（対応範囲まで）
slider.addEventListener('input', () => camera.setBrightness(Number(slider.value)));
```

### 片方の js が読めなくても落ちないようにする

このリポジトリでは、読み込みに失敗したライブラリをダミーで置き換えている。
カメラだけ・読み取りだけでも動き続けるようにするため。

```js
const camera = window.CameraController || {
  configure() {}, start() {}, stop() {}, switchCamera() {}, watchPermission() {},
  zoomNext() {}, setBrightness() {}, pauseScan() {}, resumeScan() {},
  isScanPaused: () => false, isRunning: () => false, getFacingMode: () => 'environment', getTrack: () => null
};

const scanner = window.BarcodeScanner || {
  configure() {}, start() {}, stop() {}, detect: () => Promise.resolve(null),
  setEngine() {}, nextEngine() {}, capturePreview: () => Promise.resolve(null),
  getEngineState: () => ({ status: 'idle' }), getEngineChoices: () => [], isActive: () => false,
  setStartupEngine() {}, setFormats() {}, setReaderOption() {},
  getSettings: () => null,
  getSettingChoices: () => ({ engines: [], formats: [], zxingCpp: [], binarizers: [] })
};
```

---

## 6. API リファレンス

### CameraController（camera.js）

`configure(options)` — `video` だけが必須。何度でも呼べる。

| オプション | 既定 | 説明 |
| --- | --- | --- |
| `video` | — | **必須。** `HTMLVideoElement` |
| `facingMode` | 保存値 → `'environment'` | `'environment'`（リア）/ `'user'`（フロント） |
| `width`, `height` | `1920`, `1080` | `getUserMedia` に渡す `ideal` の解像度 |
| `storageKey` | `'cameraFacingMode'` | 前後の向きの保存先。`null` で保存しない |
| `mirrorClass` | `'mirrored'` | フロントのとき `video` に付ける class。`null` で付けない（CSS は呼び出し側） |
| `zoomFactors` | `[1, 2, 3, 5]` | ズームで巡回する倍率（等倍の何倍か） |
| `detector` | `null` | `(frame) => Promise<result \| null>`。無ければフレームを取らない |
| `scanInterval` | `120` | 1 回の解析が終わってから次のフレームを取るまでの ms（約 8 回/秒）。解析が Worker で動くなら詰めてよい（このページの app.js は 30） |
| `autoPause` | `true` | 検出したら自動で `pauseScan()` する |

| コールバック | 引数 | タイミング |
| --- | --- | --- |
| `onStarting` | `{ facingMode }` | 起動を始めたとき |
| `onStart` | `{ facingMode, track, mirrored }` | 起動したとき |
| `onStop` | `{ silent }` | 停止したとき（前後切替の途中・ページ離脱も含む） |
| `onResolution` | `{ width, height }` | 解像度が決まった・変わったとき |
| `onZoom` | `{ supported, running, busy, levels, index, value, factor }` | ズームの状態が変わったとき |
| `onBrightness` | `{ supported, running, reason, key, min, max, step, value, ratio }` | 明るさの状態が変わったとき |
| `onDetect` | `detector` が返した結果（`{ text, format }`） | 検出したとき |
| `onError` | `{ code, message, error }` | 失敗したとき |

| メソッド | 説明 |
| --- | --- |
| `start()` / `stop()` | 起動・停止。`pagehide` では自動で停止する |
| `switchCamera()` | 前後を切り替える。失敗したら元の向きに戻す |
| `watchPermission()` | 権限が許可済みなら起動し、あとから許可されたときも起動する |
| `pauseScan()` / `resumeScan()` / `isScanPaused()` | カメラは動かしたまま、フレームの受け渡しだけ止める・再開する |
| `zoomNext()` / `getZoomState()` | ズームの巡回・状態 |
| `setBrightness(value)` / `getBrightnessState()` | 明るさの変更・状態 |
| `isRunning()` / `getFacingMode()` / `getTrack()` | いまの状態 |

`onError` の `code`:

| code | 意味 |
| --- | --- |
| `insecure-context` | HTTPS / localhost ではない |
| `unsupported` | `getUserMedia` が無い |
| `denied` | 権限を拒否された |
| `blocked` | 権限がブロックされている（`watchPermission()` で判明） |
| `not-found` | 指定した向きのカメラが無い |
| `in-use` | 他のアプリが使用中 |
| `unknown` | その他 |
| `zoom-failed` / `brightness-failed` | ズーム・明るさの適用に失敗（直前の値のまま続く） |

### BarcodeScanner（barcode.js）

`configure(options)` — `scanArea` だけが必須。何度でも呼べる。

| オプション | 既定 | 説明 |
| --- | --- | --- |
| `scanArea` | — | **必須。** 検出枠の要素。この矩形の内側だけを解析する |
| `basePath` | barcode.js の置き場所 | `barcode-worker.js` / `barcode-quagga2.js` の基準 |
| `vendorPath` | `basePath` + `vendor/` | 同梱ライブラリの置き場所 |
| `formats` | CODE128 / EAN-13 / EAN-8 / CODE39 | 読み取れる種類の一覧（「読み取るフォーマットを変える」を参照） |
| `engine` | 保存値 → `'zxing-cpp'` | 起動時のエンジン。保存値より優先し、保存はしない |
| `storageKey` | `'barcodeSettings'` | 設定（起動時のエンジン・有効フォーマット・ZXing-C++ のオプション）の保存先。`null` で保存しない |
| `frameFilter` | `null` | 解析に渡す画像の差し込み口（前処理用。通常は不要） |

| コールバック | 引数 |
| --- | --- |
| `onEngineChange` | `{ status, name, rate, kind, choice, active, busy }`（1 秒ごとにも届く） |
| `onSettingsChange` | `{ engine, formats, zxingCpp }` |
| `onError` | `{ code, message, error }`。code は `init-failed` / `engine-switch-failed` / `detect-failed` |

| メソッド | 説明 |
| --- | --- |
| `start()` / `stop()` | カメラの起動・停止に合わせて呼ぶ（エンジンの用意と後始末） |
| `detect(frame)` | camera.js の `detector` に渡す関数。`Promise<{ text, format } \| null>` |
| `setEngine(choice)` / `nextEngine()` | その場限りのエンジン切り替え |
| `setStartupEngine(choice)` | 起動時のエンジンを保存して、いまも切り替える |
| `setFormats(names)` | 有効にする種類を zxing の表記で選ぶ |
| `setReaderOption(name, value)` | ZXing-C++ のオプション（`tryHarder` / `tryRotate` / `tryInvert` / `tryDownscale` / `tryDenoise` / `binarizer` / `minLineCount`） |
| `getSettings()` / `getSettingChoices()` | いまの設定・選べる値 |
| `getEngineState()` / `getEngineChoices()` / `isActive()` | いまの状態 |
| `capturePreview()` | いま解析に渡している画像を `{ canvas, width, height, filtered }` で返す（枠のズレの確認用） |

結果の `format` はどのエンジンでも zxing の表記（`CODE_128` / `EAN_13` / `EAN_8` / `CODE_39`）に揃っている。

---

## 7. 任意のモジュール

### 静止画撮影（photo.js）

撮影も使うなら `js/photo.js` を足して、カメラの起動・停止に合わせて `attach()` / `detach()` を呼ぶ。

```js
PhotoCapture.configure({
  video,
  onPhoto: ({ blob, name, method }) => {
    const url = URL.createObjectURL(blob);  // objectURL の作成・revoke は呼び出し側の仕事
    // ...表示・保存...
  }
});

camera.configure({
  onStart: ({ facingMode, track }) => {
    scanner.start();
    PhotoCapture.attach({ facingMode, track });
  },
  onStop: () => {
    scanner.stop();
    PhotoCapture.detach();
  }
});

shutterBtn.addEventListener('click', () => PhotoCapture.capture());
```

### 前処理（barcode-preprocess.js。検討中）

荒れた印字のラベル向けの前処理。**検討中の機能なので、移植先では入れないのが基本。**
入れる場合は `js/barcode-preprocess.js` を足して、barcode.js の差し込み口につなぐ。

```js
BarcodePreprocess.configure({ storageKey: 'myapp.barcodePreprocess' });
BarcodeScanner.configure({ frameFilter: BarcodePreprocess.filter });
```

既定では全部の段が無効（素通し）なので、段の選び方は `AGENTS.md` の「barcode-preprocess.js」を参照。

---

## 8. 本番に持っていく前に見直すこと

- **キャッシュ。** このリポジトリの `index.html` は js に `?v=<Date.now()>` を付けて毎回取り直している
  （検証用）。これは `index.html` 側の話なので移植先には付いてこないが、barcode.js が `barcode-worker.js` /
  `barcode-quagga2.js` を読むときの `?v=` は barcode.js の中（`withVersion()`）に残っている。
  本番でキャッシュを効かせたいなら、ファイル名かクエリで版を管理する形に直すこと。
- **`localStorage` のキー。** 既定の `cameraFacingMode` / `barcodeSettings` はホスト側とぶつかりうるので、
  `storageKey` で名前空間を付けるか `null` で保存を切る。
- **文言。** `onError` の `message` は既定の日本語。多言語にするなら `code` だけを見て自前で出す。
- **ライセンス。** `vendor/` のライセンス全文（ZXing: Apache-2.0、zxing-wasm / Quagga2: MIT）を一緒に配布する。

---

## 9. 動かないとき

| 症状 | 見るところ |
| --- | --- |
| カメラが起動しない | HTTPS / localhost か。`onError` の `code` |
| 起動するが読めない | `onEngineChange` の `rate`（N/s）。**0/s ならフレームが渡っていない**（`detector` の渡し忘れ、`resumeScan()` の呼び忘れ） |
| `status` が `loading` のまま・`init-failed` | `vendor/` のパス（`vendorPath` / `basePath`）。DevTools の Network で 404 を見る |
| 1 回読んだら止まる | 仕様（`autoPause`）。`resumeScan()` を呼ぶ |
| 枠と違う場所を読んでいる | `capturePreview()` の画像を `<img>` に出して確かめる。検出枠が `<video>` の表示の上に重なっているか |
| 細いバーが読めない | 枠が大きすぎないか（長辺 640px に縮めて解析する）。ズーム・距離で稼ぐ |
| iPhone で枠に物を入れるとプレビューが一瞬ずれる | カメラのフォーカス動作。標準のカメラアプリでも起きる |
