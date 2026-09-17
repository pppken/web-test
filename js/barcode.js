(() => {
  'use strict';

  // バーコード検出。検出は BarcodeDetector（Chrome / Android 等）を優先し、
  // 非対応のブラウザ（iOS Safari / Firefox / デスクトップ Chrome）では同梱の ZXing を使う。
  // ZXing-C++ と Quagga2 は自動では選ばれず、setEngine() で明示的に選んだときだけ使う。
  //
  // このファイルは DOM を探さない。<video> と検出枠の要素、そして結果の受け口は
  // configure() で受け取る。ダイアログ・バッジ・ボタンはすべて呼び出し側の責任。
  //
  //   BarcodeScanner.configure({
  //     video,                 // 必須。HTMLVideoElement
  //     scanArea,              // 必須。この要素の矩形の内側だけを切り出して解析する
  //     basePath,              // barcode-worker.js の基準。既定はこの js の場所
  //     vendorPath,            // 同梱ライブラリの置き場所。既定は basePath + 'vendor/'
  //     formats,               // 読み取る対象（既定は FORMATS ＝ CODE39 のみ）
  //     engine,                // 'auto' | 'zxing' | 'zxing-cpp' | 'quagga'
  //     storageKey,            // エンジン選択の保存先。null で保存しない
  //     autoPause,             // 検出したら自動で pause する（既定 true）
  //     onDetect({ text, format }),
  //     onEngineChange(state),
  //     onError({ code, message, error })
  //   });
  //   BarcodeScanner.start() / stop() / pause() / resume()
  //   BarcodeScanner.setEngine(choice) / nextEngine() / capturePreview()
  //
  // onDetect が呼ばれた時点で（autoPause が既定のままなら）解析は止まっている。
  // 結果を見せ終わったら resume() を呼ぶこと。呼ばない限り読み直さない。
  //
  // onError の code は 'init-failed' / 'engine-switch-failed' / 'detect-failed'。
  //
  // 切り出しは <video> の表示矩形と scanArea の表示矩形の差から求める。
  // object-fit によるレターボックスは videoContentRect() で差し引くので、
  // 枠の中で映像に余白ができるレイアウトでもずれない（object-position は中央を前提）。

  // barcode-worker.js と vendor/ の場所は、この js の URL からの相対で解決する。
  // ページのどこに置かれても（サブディレクトリでも）動くようにしておく
  const SCRIPT_URL = (document.currentScript && document.currentScript.src) || location.href;
  const DEFAULT_BASE_PATH = new URL('.', SCRIPT_URL).href;

  // どのライブラリも、初回に必要になったときだけ読み込む
  // （ZXing 約 330KB / ZXing-C++ 約 36KB + wasm 約 930KB / Quagga2 約 150KB）
  const ZXING_SRC = 'zxing-0.21.3.min.js';
  const QUAGGA_SRC = 'quagga2-1.12.1.min.js';
  const LIB_TIMEOUT_MS = 10000;

  // ZXing-C++（zxing-wasm の reader ビルド）。js と wasm の 2 つで 1 組なので、
  // 版を上げるときは両方を差し替える。wasm の場所は locateFile で指定するため、
  // ファイル名は vendor の流儀（バージョン入り）に揃えてある
  const ZXING_CPP_SRC = 'zxing-wasm-reader-3.1.4.min.js';
  const ZXING_CPP_WASM = 'zxing-wasm-reader-3.1.4.wasm';

  // ZXing-C++ の初期化を打ち切るまでの時間。js（約 36KB）の読み込みだけでなく
  // wasm（約 930KB）の取得とコンパイルまで待つので、他のライブラリ
  // （LIB_TIMEOUT_MS = 10 秒）と同じ尺では回線の細い実機で足りない
  const WASM_INIT_TIMEOUT_MS = 30000;

  // ZXing-C++ の解析オプション。formats は configure() の formats から入れるのでここには書かない。
  //   maxNumberOfSymbols  1 件見つかった時点で打ち切る（枠内に複数は想定していない）
  //   tryInvert           白黒反転した画像は試さない。ZXing 経路で
  //                       HTMLCanvasElementLuminanceSource の第 2 引数を false に
  //                       しているのと同じ理由で、通常のバーコードの実効回数が落ちる
  //   tryHarder           既定でも true だが、ZXing 経路と揃えて明示しておく。
  //                       重いときに最初に外す場所なので、既定任せにしない
  // tryRotate / tryDownscale は既定（いずれも true）のまま。
  // 特に tryRotate が効くので、この経路ではこちら側で 90 度回転させない
  // （needsRotation() が false）。速度が足りないときは onEngineChange の rate を見ながら外す
  const ZXING_CPP_OPTIONS = {
    maxNumberOfSymbols: 1,
    tryInvert: false,
    tryHarder: true
  };

  // Quagga2 の 1 フレームぶんの解析を打ち切るまでの時間。
  // decodeSingle は画像を <img> 経由でしか受け取れない作りで、読み込みが返らないと
  // Promise が解決も棄却もされないまま残る。そうなるとスキャンループが二度と
  // 進まなくなる（0/s のまま無反応になる）ので、必ず打ち切れるようにしておく
  const QUAGGA_DECODE_TIMEOUT_MS = 3000;

  // ZXing は同期処理なので、メインスレッドで回すと解析のあいだ画面が固まる。
  // 既定では Worker に投げ、Worker を使えない環境だけメインスレッドで実行する
  const ZXING_WORKER_SRC = 'barcode-worker.js';

  const SCAN_INTERVAL_MS = 120;      // 1 秒あたり約 8 回スキャンする

  // 解析に回す画像の最大辺。切り出したあとの処理（getImageData →
  // グレースケール変換 → 二値化 → デコード）はすべて画素数に比例するので、
  // ここを絞るのが一番素直に効く。
  //
  // 900 では大半の端末で切り出しサイズを下回らず、実質的に無効だった
  // （例: 1080p 縦持ちの iPhone で切り出しは 864x768）。640 まで落としても
  // CODE39 のバーの太さは十分残る
  const MAX_SCAN_SIDE = 640;

  // ZXing / Quagga2 に渡す画像の左右に足す白い余白の幅（px）。
  // 検出枠いっぱいにバーコードが写っていると、CODE39 の開始/終了記号の外側に
  // 必要な静止領域（クワイエットゾーン）まで切り落とされて読めないことがあるので、
  // 切り出した画像の左右を白で埋めて補う。
  // 回転経路でもバーが並ぶ向きは canvas の横方向なので、足す位置は同じ
  const SCAN_PAD_X = 50;

  // 読み取る対象のフォーマット。既定は CODE39 のみ。
  // BarcodeDetector / ZXing / ZXing-C++ / Quagga2 で表記が違うので 4 つとも持つ。大半は
  // 大文字小文字と区切りの差でしかないが、PDF417 だけ 'pdf417' / 'PDF_417' と規則が
  // 揃わないため機械的な変換はせず、増やすときは 4 つとも書くこと。
  // Quagga2 はリーダー名で指定する（対応表は同梱ライブラリの Readers を参照）。
  // ZXing-C++ の表記は zxing-wasm の README にある一覧を参照。
  // 結果の format は全経路で zxing の表記（CODE_39）に揃えてから返す
  const FORMATS = [
    { native: 'code_39', zxing: 'CODE_39', zxingCpp: 'Code39', quagga: 'code_39_reader' }
  ];

  // 同じバーコードを同じ端末で読み比べられるように、使うエンジンを選べるようにしてある。
  // 'auto' は従来どおり BarcodeDetector → ZXing。Android 実機では BarcodeDetector が
  // 常に勝つので、'auto' のままだと ZXing / ZXing-C++ / Quagga2 の実力を実機で見られない。
  // 表示用のラベルは呼び出し側が持つ（このファイルは値だけを扱う）
  const ENGINE_CHOICES = ['auto', 'zxing', 'zxing-cpp', 'quagga'];
  const DEFAULT_STORAGE_KEY = 'barcodeEngine';

  // onError の既定の文言。呼び出し側は code だけを見て自前の文言を出してもよい
  const MESSAGES = {
    'init-failed': 'バーコード読み取りを初期化できませんでした。',
    'engine-switch-failed': 'エンジンを切り替えられませんでした。',
    'detect-failed': 'バーコードの解析に失敗しました。'
  };

  const config = {
    video: null,
    scanArea: null,
    basePath: DEFAULT_BASE_PATH,
    vendorPath: null,
    formats: FORMATS,
    engine: null,
    storageKey: DEFAULT_STORAGE_KEY,
    autoPause: true,
    onDetect: null,
    onEngineChange: null,
    onError: null
  };

  let configured = false;

  // 検出領域だけを切り出すための作業用キャンバス。
  // ZXing は getImageData を多用するので willReadFrequently を立てておく。
  //
  // 正立用と回転用で 2 枚持つ。1 枚を使い回すと、ZXing 経路では 1 フレームおきに
  // 幅と高さが入れ替わるせいで、下の再確保ガードが毎回すり抜けてしまう
  // （canvas への width/height 代入はバッキングストアの再確保とゼロクリアを伴う）
  function createScanCanvas() {
    const element = document.createElement('canvas');
    return { canvas: element, ctx: element.getContext('2d', { willReadFrequently: true }) };
  }

  // [0] = 正立, [1] = 90 度回転
  const scanCanvases = [createScanCanvas(), createScanCanvas()];

  // プレビュー（<video>）の複製先。解析はこのコピーに対して行い、解析のあいだは
  // 映像そのものには一切触らない。
  //
  // 持つのは検出枠のぶんだけ・縮小済み（正立・余白なし）。**ここを広げないこと。**
  // 映像を丸ごと複製すると 1 回あたり約 200 万画素（1080p 縦持ち）を読むことになるが、
  // 実際に要るのは枠のぶん（縮小後で約 36 万画素）しかない。映像に触る量は少ないほどよい。
  //
  // こちらは getImageData を呼ばない（描き込むだけ・読むのは scanCanvases 側）ので
  // willReadFrequently は立てない。立てるとソフトウェア canvas になり、
  // 映像からの複製が GPU からの読み戻しになって逆に重くなる
  const frameBuffer = {
    canvas: document.createElement('canvas'),
    ctx: null,
    ready: false
  };
  frameBuffer.ctx = frameBuffer.canvas.getContext('2d');

  let detect = null;         // (canvas) => { text, format } | null （Promise でも可）

  // いま動いている経路。切り出し方（余白・回転）とフォールバック先をこれで決める。
  //   'native'           BarcodeDetector
  //   'zxing-worker'     ZXing（Worker）
  //   'zxing'            ZXing（メインスレッド）
  //   'zxing-cpp-worker' ZXing-C++ / wasm（Worker）
  //   'zxing-cpp'        ZXing-C++ / wasm（メインスレッド）
  //   'quagga'           Quagga2
  let engineKind = '';

  // 選択値 -> Promise<エンジン>。一度作ったものは取っておき、エンジンを
  // 切り替えて戻したときにライブラリの読み直しや Worker の作り直しをしない
  const detectorCache = new Map();

  let active = false;        // 読み取り中か（start / stop で切り替わる）
  let paused = false;        // 撮影中・結果表示中など、一時的に解析を止めているか
  let timerId = null;
  let rotateNext = false;
  let runToken = 0;          // ループを畳むたびに進める。tick の世代を見分ける

  // 解析中の件数。0 でないあいだはプレビューのコピーを行わない。
  // 真偽値ではなく数で持つのは、ループを畳んだ直後に古い tick の解析が
  // まだ返っていないことがあるため（それぞれが自分のぶんだけ戻す）
  let pendingDetects = 0;

  let engineChoice = ENGINE_CHOICES[0];
  let engineStatus = 'idle';  // 'idle' | 'loading' | 'ready' | 'error'
  let engineName = '';
  let engineBusy = false;
  let scanCount = 0;
  let scanRate = null;
  let rateTimerId = null;

  // 呼び出し側のコールバックが投げても、こちらの処理は止めない
  function emit(name, payload) {
    const handler = config[name];
    if (typeof handler !== 'function') return;

    try {
      handler(payload);
    } catch (err) {
      console.error(`${name} の処理でエラーが発生しました`, err);
    }
  }

  function fail(code, error) {
    const detail = error && error.message ? `\n${error.message}` : '';
    emit('onError', { code, message: `${MESSAGES[code]}${detail}`, error: error || null });
  }

  // barcode-worker.js はこの js と同じ場所にある前提
  function resolveUrl(path) {
    return new URL(path, config.basePath).href;
  }

  // 同梱ライブラリ（vendor/）は別の場所に置けるようにしてある。
  // 既定は basePath の下の vendor/ なので、この js と vendor/ を丸ごと同じ場所に
  // コピーすれば設定は要らない。このリポジトリのように js/ と vendor/ を
  // 並べて置く場合は configure({ vendorPath }) で指す
  function resolveVendor(name) {
    return new URL(name, config.vendorPath || new URL('vendor/', config.basePath).href).href;
  }

  function isAnalyzing() {
    return pendingDetects > 0;
  }

  // 余白を足すのは同梱ライブラリの経路だけ。BarcodeDetector は向きも含めて
  // 端末側の実装に任せるので、余分な画素を渡して 1 回の検出を重くしない
  function needsQuietZone() {
    return engineKind !== 'native';
  }

  // 1 フレームおきの 90 度回転が要るのは ZXing だけ。BarcodeDetector・
  // ZXing-C++（tryRotate）・Quagga2（locator）はバーコードの向きを自前で処理する
  function needsRotation() {
    return engineKind === 'zxing' || engineKind === 'zxing-worker';
  }

  // --- 状態の通知 -------------------------------------------------------

  // 呼び出し側がバッジとボタンの表示を決めるのに要るものを全部入れて渡す。
  //   status  'idle'（停止中）/ 'loading'（読み込み中）/ 'ready' / 'error'
  //   name    いま動いている（または読み込んでいる）エンジンの名前
  //   rate    直近 1 秒の実際の解析回数。null なら未集計
  //   choice  選択値（ENGINE_CHOICES のいずれか）
  function getEngineState() {
    return {
      status: engineStatus,
      name: engineName,
      rate: scanRate,
      kind: engineKind,
      choice: engineChoice,
      active,
      paused,
      busy: engineBusy
    };
  }

  function emitEngine() {
    emit('onEngineChange', getEngineState());
  }

  function setEngineState(status, name) {
    engineStatus = status;
    engineName = name;
    emitEngine();
  }

  // 1 秒ごとに実際の解析回数を集計する。0/s ならループが回っていない
  function startRateMeter() {
    stopRateMeter();
    rateTimerId = setInterval(() => {
      scanRate = scanCount;
      scanCount = 0;
      emitEngine();
    }, 1000);
  }

  function stopRateMeter() {
    clearInterval(rateTimerId);
    rateTimerId = null;
    scanCount = 0;
    scanRate = null;
  }

  // --- エンジンの選択 ---------------------------------------------------

  // camera.js の向き設定と同じ理由で、localStorage は読み書きとも握りつぶす
  function loadEngineChoice() {
    if (!config.storageKey) return ENGINE_CHOICES[0];

    try {
      const saved = localStorage.getItem(config.storageKey);
      if (ENGINE_CHOICES.includes(saved)) return saved;
    } catch (err) {
      console.warn('エンジン設定の読み込みに失敗しました', err);
    }
    return ENGINE_CHOICES[0];
  }

  function saveEngineChoice(value) {
    if (!config.storageKey) return;

    try {
      localStorage.setItem(config.storageKey, value);
    } catch (err) {
      console.warn('エンジン設定の保存に失敗しました', err);
    }
  }

  // 動作中ならカメラは止めずに、検出器だけその場で差し替える。
  // 停止中は選択を覚えるだけで、次の start() がこの選択で初期化する
  async function setEngine(choice) {
    ensureConfigured();
    if (!ENGINE_CHOICES.includes(choice) || choice === engineChoice) return;

    const previous = engineChoice;
    const previousStatus = engineStatus;
    const previousName = engineName;

    engineChoice = choice;
    saveEngineChoice(engineChoice);

    if (!active) {
      emitEngine();
      return;
    }

    engineBusy = true;
    setEngineState('loading', '');

    try {
      await applyEngine(getDetector());
    } catch (err) {
      // 切り替えに失敗しても直前のエンジンはそのまま動いているので、
      // 選択だけ戻して読み取りは続ける（camera.js の前後切替と同じ扱い）
      detectorCache.delete(engineChoice);
      engineChoice = previous;
      saveEngineChoice(previous);
      setEngineState(previousStatus, previousName);
      console.error(err);
      fail('engine-switch-failed', err);
    } finally {
      engineBusy = false;
      emitEngine();
    }
  }

  // 押すたびに auto -> zxing -> zxing-cpp -> quagga と巡回する
  function nextEngine() {
    const index = ENGINE_CHOICES.indexOf(engineChoice);
    return setEngine(ENGINE_CHOICES[(index + 1) % ENGINE_CHOICES.length]);
  }

  // --- 検出エンジン -----------------------------------------------------

  // 読み込みが返らないまま固まるのを避けるため、必ずタイムアウトさせる
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');

      const timer = setTimeout(() => {
        script.remove();
        reject(new Error(`スクリプトの読み込みがタイムアウトしました: ${src}`));
      }, LIB_TIMEOUT_MS);

      script.src = src;
      script.onload = () => {
        clearTimeout(timer);
        resolve();
      };
      script.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`スクリプトの読み込みに失敗しました: ${src}`));
      };

      document.head.appendChild(script);
    });
  }

  // 解決も棄却もされないままの Promise でスキャンループが止まらないようにする
  function withTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);

      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  // 読み取る対象のうち、この端末の BarcodeDetector が扱えるものだけを有効にする。
  // 無関係なフォーマットを渡さないぶん、ネイティブ側の 1 回の検出も軽くなる
  async function createNativeDetector() {
    if (!('BarcodeDetector' in window)) return null;

    const supported = await window.BarcodeDetector.getSupportedFormats();
    const formats = config.formats.map((format) => format.native).filter((name) =>
      supported.includes(name)
    );
    // API はあってもプラットフォーム側が未対応だと空配列が返る。
    // 読みたいフォーマットが 1 つも無い場合も同じく ZXing に任せる
    if (!formats.length) return null;

    const detector = new window.BarcodeDetector({ formats });

    return {
      kind: 'native',
      name: 'BarcodeDetector',
      detect: async (source) => {
        const results = await detector.detect(source);
        if (!results.length) return null;

        // 他のエンジンと表記を揃える（code_39 -> CODE_39）
        return { text: results[0].rawValue, format: String(results[0].format).toUpperCase() };
      }
    };
  }

  // 解析を barcode-worker.js に投げる経路。メインスレッドに残るのは drawImage と
  // getImageData だけになるので、解析中もプレビューや UI が固まらない。
  // spec は { kind, name, timeout, init }。init はそのまま Worker の init メッセージになる
  function createWorkerDetector(spec) {
    if (typeof Worker !== 'function') {
      return Promise.reject(new Error('Worker に対応していません。'));
    }

    const workerSrc = resolveUrl(ZXING_WORKER_SRC);
    // 他の js と同じ理由でキャッシュ対策を付ける（AGENTS.md の読み込み順を参照）
    const worker = new Worker(`${workerSrc}?v=${Date.now()}`);
    let pending = null;
    let nextId = 0;

    function detect(source) {
      // 既に 2d コンテキストがあるので、getContext は作成済みのものを返す
      const image = source.getContext('2d').getImageData(0, 0, source.width, source.height);

      return new Promise((resolve, reject) => {
        // 前の解析が応答を返さないまま次が来た場合は捨てる。放置すると
        // Promise が残り続けて、スキャンループが二度と進まなくなる
        if (pending) pending.reject(new Error('前の解析が完了していません。'));

        const id = (nextId += 1);
        pending = { id, resolve, reject };

        // ArrayBuffer は転送で渡す（サイズによらずコピーが起きない）
        worker.postMessage(
          { id, width: image.width, height: image.height, buffer: image.data.buffer },
          [image.data.buffer]
        );
      });
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error(`Worker の初期化がタイムアウトしました: ${workerSrc}`));
      }, spec.timeout);

      // 初期化前なら初期化の失敗として、初期化後なら解析中の失敗として伝える
      // （解決済みの Promise への reject は無視される）。
      // 名前を failWorker にしてあるのは、モジュール側の fail()（onError を出す方）と
      // 紛らわしくしないため
      function failWorker(err) {
        clearTimeout(timer);
        reject(err);

        if (pending) {
          pending.reject(err);
          pending = null;
        }
      }

      worker.onerror = (event) => {
        failWorker(new Error(event.message || `Worker を読み込めませんでした: ${workerSrc}`));
      };

      worker.onmessage = (event) => {
        const message = event.data;

        if (message.type === 'ready') {
          clearTimeout(timer);
          resolve({ kind: spec.kind, name: spec.name, detect });
          return;
        }

        if (message.type === 'error') {
          worker.terminate();
          failWorker(new Error(message.message));
          return;
        }

        // stop() などをまたいだ古い応答は捨てる
        if (!pending || pending.id !== message.id) return;

        const current = pending;
        pending = null;

        if (message.error) current.reject(new Error(message.error));
        else current.resolve(message.result);
      };

      worker.postMessage({ type: 'init', formats: config.formats, ...spec.init });
    });
  }

  function createZXingWorkerDetector() {
    return createWorkerDetector({
      kind: 'zxing-worker',
      name: 'ZXing (Worker)',
      timeout: LIB_TIMEOUT_MS,
      init: {
        engine: 'zxing',
        // Worker 内は相対パスの基準が変わるので、絶対 URL にしてから渡す
        src: resolveVendor(ZXING_SRC)
      }
    });
  }

  // ZXing-C++ を Worker で動かす経路。wasm の解析も呼び出したスレッドを止めるので、
  // ZXing と同じくメインスレッドからは追い出す
  function createZXingCppWorkerDetector() {
    return createWorkerDetector({
      kind: 'zxing-cpp-worker',
      name: 'ZXing-C++ (Worker)',
      // wasm の取得とコンパイルまで ready を待つので、こちらは長めのタイムアウト
      timeout: WASM_INIT_TIMEOUT_MS,
      init: {
        engine: 'zxing-cpp',
        // js も wasm も Worker 内は相対パスの基準が変わるので絶対 URL で渡す
        src: resolveVendor(ZXING_CPP_SRC),
        wasm: resolveVendor(ZXING_CPP_WASM),
        options: ZXING_CPP_OPTIONS
      }
    });
  }

  // Worker を使えない環境向けの経路。解析のあいだメインスレッドが止まる
  async function createZXingMainDetector() {
    await loadScript(resolveVendor(ZXING_SRC));

    const ZXing = window.ZXing;
    if (!ZXing) throw new Error('ZXing の初期化に失敗しました。');

    // POSSIBLE_FORMATS を渡さないと、MultiFormatReader は 1D 系・QR・DataMatrix・
    // Aztec・PDF417 のリーダーをすべて用意し、しかも未検出のフレームでは
    // 毎回その全部を走らせる（未検出が大半なので、これが 1 回の解析の主な中身になる）。
    // CODE39 だけに絞ると Code39Reader 1 本で済む。
    //
    // TRY_HARDER を付けると、doDecode が高さ方向に見る行が 15 行から画像の高さぶん
    // 全部に増える（行ステップも h>>5 から h>>8 になる）。
    // 全フォーマット有効だった頃は 1 回の解析が 10 倍（約 31ms -> 311ms）になり
    // 実効 3 回/秒まで落ちたが、POSSIBLE_FORMATS を CODE39 だけに絞った今は
    // Code39Reader 1 本ぶんの増加で済む。**重くなったらまずここを外す。**
    // 判断は onEngineChange の rate を実機で見て行うこと。
    //
    // なお TRY_HARDER の回転リトライ（未検出なら 90 度回してもう一度）は、この
    // ライブラリでは使い物にならない。Worker 経路の RGBLuminanceSource は
    // isRotateSupported() が false で走らず、メインスレッド経路の
    // HTMLCanvasElementLuminanceSource は true を返すのに rotateCounterClockwise() が
    // 縦横を入れ替えずに同じ寸法を返す（0.21.3 で確認）。縦向きバーコードは
    // これまで通り rotateNext で拾う。
    //
    // setHints は TRY_HARDER をキーの有無で見る（値が false でも「あり」扱い）。
    // 外すときは false を入れるのではなく set ごと消すこと。
    // 1D リーダーを最後尾に回す副作用もあるが、CODE39 だけなので並びは変わらない
    const hints = new Map();
    hints.set(
      ZXing.DecodeHintType.POSSIBLE_FORMATS,
      config.formats.map((format) => ZXing.BarcodeFormat[format.zxing])
    );
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);

    const reader = new ZXing.MultiFormatReader();
    reader.setHints(hints);

    return {
      kind: 'zxing',
      name: 'ZXing',
      detect: (source) => {
        // 第 2 引数を true にすると 1 フレームおきに白黒反転した画像を試す挙動になり、
        // 通常の（黒地に白でない）バーコードの実効スキャン回数が半減するので false
        const luminance = new ZXing.HTMLCanvasElementLuminanceSource(source, false);
        const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(luminance));

        try {
          const result = reader.decodeWithState(bitmap);
          return {
            text: result.getText(),
            format: ZXing.BarcodeFormat[result.getBarcodeFormat()]
          };
        } catch (err) {
          // 未検出はフレームごとに例外で返ってくるので通常系として扱う
          if (err instanceof ZXing.NotFoundException) return null;
          throw err;
        } finally {
          reader.reset();
        }
      }
    };
  }

  // ZXing-C++ は 'Code39' という独自の表記で返してくるので、他のエンジンと同じ
  // 大文字表記（CODE_39）に直す。barcode-worker.js にも同じものがある
  function zxingCppFormat(result) {
    // symbology は変種（Code39Ext など）を束ねた親を返すので、あればそちらを見る
    const name = String(result.symbology || result.format || '');
    const known = config.formats.find(
      (format) => format.zxingCpp.toLowerCase() === name.toLowerCase()
    );
    return known ? known.zxing : name.toUpperCase();
  }

  // Worker を使えない環境向けの ZXing-C++ 経路。解析のあいだメインスレッドが止まる
  async function createZXingCppMainDetector() {
    const wasmUrl = resolveVendor(ZXING_CPP_WASM);

    await loadScript(resolveVendor(ZXING_CPP_SRC));

    const ZXingWASM = window.ZXingWASM;
    if (!ZXingWASM) throw new Error('ZXing-C++ の初期化に失敗しました。');

    const options = {
      ...ZXING_CPP_OPTIONS,
      formats: config.formats.map((format) => format.zxingCpp)
    };

    // 既定の locateFile は wasm を jsDelivr から取りに行くので、同梱したものを指すように
    // 差し替える。prepareZXingModule は overrides の中身が前回と同じなら作った Module を
    // 使い回すため、呼ぶたびに新しい関数を渡さないよう 1 つだけ作って持つ。
    // fireImmediately で、wasm の取得とコンパイルまでここで終わらせる
    // （待たずに返すと、最初の数フレームの解析がまとめて待たされる）
    await withTimeout(
      ZXingWASM.prepareZXingModule({
        overrides: zxingCppOverrides(wasmUrl),
        fireImmediately: true
      }),
      WASM_INIT_TIMEOUT_MS,
      `wasm の読み込みがタイムアウトしました: ${wasmUrl}`
    );

    return {
      kind: 'zxing-cpp',
      name: 'ZXing-C++',
      detect: async (source) => {
        // 既に 2d コンテキストがあるので、getContext は作成済みのものを返す
        const image = source.getContext('2d').getImageData(0, 0, source.width, source.height);
        const results = await ZXingWASM.readBarcodes(image, options);

        if (!results.length) return null;
        return { text: results[0].text, format: zxingCppFormat(results[0]) };
      }
    };
  }

  // prepareZXingModule は overrides の中身が前回と同じかどうかで Module を使い回すので、
  // 呼ぶたびに新しい関数を作らないよう wasm の URL ごとに 1 つだけ持つ
  const zxingCppOverridesCache = new Map();
  function zxingCppOverrides(wasmUrl) {
    if (!zxingCppOverridesCache.has(wasmUrl)) {
      zxingCppOverridesCache.set(wasmUrl, {
        locateFile: (path, prefix) => (path.endsWith('.wasm') ? wasmUrl : prefix + path)
      });
    }

    return zxingCppOverridesCache.get(wasmUrl);
  }

  // Quagga2 の経路。自動では選ばれず、setEngine('quagga') で選んだときだけ使う。
  //
  // 公開 API の decodeSingle は画像を URL でしか受け取れないので、切り出した canvas を
  // 毎フレーム data URL にしてから渡している（ZXing のように ImageData を直接渡す口が
  // 無く、PNG のエンコードとデコードが 1 フレームぶん余計に乗る）。
  // 同梱の UMD は読み込み時に window を直接参照するので Worker にも移せず、
  // 解析のあいだメインスレッドが止まる。読み比べ用の経路と割り切って、
  // この重さはそのままにしてある（実際に何回回っているかは onEngineChange の rate を見る）
  async function createQuaggaDetector() {
    await loadScript(resolveVendor(QUAGGA_SRC));

    const Quagga = window.Quagga;
    if (!Quagga) throw new Error('Quagga2 の初期化に失敗しました。');

    const readers = config.formats.map((format) => format.quagga);

    return {
      kind: 'quagga',
      name: 'Quagga2',
      detect: async (source) => {
        const decoding = Quagga.decodeSingle({
          src: source.toDataURL('image/png'),
          inputStream: {
            // 既定の 800 のままだと切り出した画像が引き伸ばされるので実寸を渡す
            size: Math.max(source.width, source.height),
            willReadFrequently: true
          },
          // 検出枠の描画用 canvas は使わないので作らせない
          canvas: { createOverlay: false },
          // ZXing の POSSIBLE_FORMATS と同じ意図。既定の code_128_reader を置き換える
          decoder: { readers },
          // 縮小は MAX_SCAN_SIDE で済ませてあるので、locator の halfSample は
          // decodeSingle の既定（false）のまま。ここで更に半分にするとバーが潰れる。
          // バーコードの位置と傾きは locator が探すので、ZXing のように
          // こちら側で 90 度回転させる必要は無い
          locate: true
        });

        const result = await withTimeout(
          decoding,
          QUAGGA_DECODE_TIMEOUT_MS,
          'Quagga2 の解析がタイムアウトしました。'
        );

        const code = result && result.codeResult;
        if (!code || !code.code) return null;

        // 他のエンジンと表記を揃える（code_39 -> CODE_39）
        return { text: code.code, format: String(code.format).toUpperCase() };
      }
    };
  }

  // ZXing の経路。Worker を作れない環境ではメインスレッド実行に落ちる
  function useZXing() {
    setEngineState('loading', 'ZXing');

    return createZXingWorkerDetector().catch((err) => {
      // Worker が駄目でも読み取り自体は続けられるようにする。
      // どちらで動いているかは onEngineChange の name で分かる
      console.warn('ZXing を Worker で動かせないため、メインスレッドで実行します', err);
      return createZXingMainDetector();
    });
  }

  // ZXing-C++ の経路。ZXing と同じく、Worker を作れない環境ではメインスレッド実行に落ちる
  function useZXingCpp() {
    setEngineState('loading', 'ZXing-C++');

    return createZXingCppWorkerDetector().catch((err) => {
      console.warn('ZXing-C++ を Worker で動かせないため、メインスレッドで実行します', err);
      return createZXingCppMainDetector();
    });
  }

  // 'auto'。BarcodeDetector が使えなければ ZXing に落ちる（従来どおりの順序）
  function useAuto() {
    return createNativeDetector()
      .catch((err) => {
        console.warn('BarcodeDetector を利用できません', err);
        return null;
      })
      .then((native) => native || useZXing());
  }

  // いまの選択に対応する検出器。一度作ったものは detectorCache から使い回す
  function getDetector() {
    if (!detectorCache.has(engineChoice)) {
      if (engineChoice === 'quagga') {
        setEngineState('loading', 'Quagga2');
        detectorCache.set(engineChoice, createQuaggaDetector());
      } else if (engineChoice === 'zxing-cpp') {
        detectorCache.set(engineChoice, useZXingCpp());
      } else if (engineChoice === 'zxing') {
        detectorCache.set(engineChoice, useZXing());
      } else {
        detectorCache.set(engineChoice, useAuto());
      }
    }

    return detectorCache.get(engineChoice);
  }

  // 出来上がった検出器を「いま動いているもの」として据える。
  // 切り出し方（余白・回転）とフォールバック先は、ここで入る kind で決まる
  async function applyEngine(promise) {
    const engine = await promise;

    detect = engine.detect;
    engineKind = engine.kind;
    setEngineState('ready', engine.name);
  }

  // --- スキャンループ ---------------------------------------------------

  // <video> の箱の中で、映像が実際に描かれている矩形を求める。
  // object-fit が既定（contain）のままでも、箱と映像のアスペクト比が違えば
  // 上下か左右にレターボックスができる。そこを差し引かないと切り出し位置がずれるので、
  // 箱の矩形ではなく映像の矩形を基準にする。object-position は既定（中央）を前提
  function videoContentRect() {
    const video = config.video;
    const rect = video.getBoundingClientRect();
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!rect.width || !rect.height || !vw || !vh) return null;

    const fit = getComputedStyle(video).objectFit || 'contain';
    if (fit === 'fill') return rect;

    const contain = Math.min(rect.width / vw, rect.height / vh);
    let scale;
    if (fit === 'cover') scale = Math.max(rect.width / vw, rect.height / vh);
    else if (fit === 'none') scale = 1;
    else if (fit === 'scale-down') scale = Math.min(1, contain);
    else scale = contain;

    const width = vw * scale;
    const height = vh * scale;

    return {
      left: rect.left + (rect.width - width) / 2,
      top: rect.top + (rect.height - height) / 2,
      width,
      height
    };
  }

  // 画面上の検出枠を、映像の実ピクセル座標に変換する
  function measureScanArea() {
    const video = config.video;
    const videoRect = videoContentRect();
    if (!videoRect) return null;

    const areaRect = config.scanArea.getBoundingClientRect();
    if (!areaRect.width) return null;

    const scaleX = video.videoWidth / videoRect.width;
    const scaleY = video.videoHeight / videoRect.height;

    // フロントカメラは CSS で左右反転しているだけなので、
    // 中央基準の枠の座標は反転の有無に関わらず同じになる
    const sx = Math.max(0, Math.round((areaRect.left - videoRect.left) * scaleX));
    const sy = Math.max(0, Math.round((areaRect.top - videoRect.top) * scaleY));
    const sw = Math.min(video.videoWidth - sx, Math.round(areaRect.width * scaleX));
    const sh = Math.min(video.videoHeight - sy, Math.round(areaRect.height * scaleY));
    if (sw <= 0 || sh <= 0) return null;

    return { sx, sy, sw, sh };
  }

  // プレビューの現在のフレームから、検出枠のぶんをバッファに複製する。
  // 解析に渡すのはこのコピーで、映像そのものを読むのはここだけ。
  //
  // 解析中は呼ばれても何もしない。1 回のコピーにつき解析は 1 回、その結果が
  // 返ってから次をコピーする（tick() が回す）。切り出し範囲はここで確定させる
  // （あとから測ると、コピーした絵と枠がずれる）
  function copyPreviewFrame() {
    const video = config.video;
    if (isAnalyzing()) return false;
    if (!video.videoWidth || !video.videoHeight) return false;

    const crop = measureScanArea();
    if (!crop) return false;

    const { sx, sy, sw, sh } = crop;

    // 大きすぎる場合は縮小して取り込む
    const ratio = Math.min(1, MAX_SCAN_SIDE / Math.max(sw, sh));
    const dw = Math.max(1, Math.round(sw * ratio));
    const dh = Math.max(1, Math.round(sh * ratio));

    const { canvas, ctx } = frameBuffer;
    // 大きさが変わったときだけ再確保する（代入はゼロクリアを伴う）
    if (canvas.width !== dw || canvas.height !== dh) {
      canvas.width = dw;
      canvas.height = dh;
    }

    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh);
    frameBuffer.ready = true;
    return true;
  }

  // コピーを捨てる。停止後に古いフレームを解析／表示しないため
  function releasePreviewFrame() {
    frameBuffer.ready = false;
    frameBuffer.canvas.width = 0;
    frameBuffer.canvas.height = 0;
  }

  // コピー済みのフレームに、経路ごとの味付け（余白・回転）をして解析用の画像にする。
  // rotate=true なら 90 度回転して描画する（縦向きバーコード用）
  function captureScanArea(rotate) {
    if (!frameBuffer.ready) return null;

    const dw = frameBuffer.canvas.width;
    const dh = frameBuffer.canvas.height;
    if (!dw || !dh) return null;

    // 余白も回転も要らない経路（＝ BarcodeDetector）では、コピーをそのまま渡す。
    // 解析中はコピーが止まるので、渡したあとに書き換わることはない
    if (!needsQuietZone() && !rotate) return frameBuffer.canvas;

    const { canvas, ctx } = scanCanvases[rotate ? 1 : 0];

    const pad = needsQuietZone() ? SCAN_PAD_X : 0;

    const cw = (rotate ? dh : dw) + pad * 2;
    const chh = rotate ? dw : dh;
    // 向きごとに canvas を分けたので、ここを通るのは画面回転やリサイズのときだけ
    if (canvas.width !== cw || canvas.height !== chh) {
      canvas.width = cw;
      canvas.height = chh;
    }

    // 余白は drawImage が触らない領域なので自分で塗る。canvas を再確保した直後は
    // 透明のままなので、毎フレーム塗り直しておく（左右の細い帯だけなので安い）
    if (pad) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, pad, chh);
      ctx.fillRect(cw - pad, 0, pad, chh);
    }

    ctx.save();
    // 左の余白のぶんだけずらして映像を描く
    ctx.translate(pad, 0);
    if (rotate) {
      ctx.translate(dh, 0);
      ctx.rotate(Math.PI / 2);
    }
    // 縮小はコピーの時点で済んでいるので、ここは等倍で置くだけ
    ctx.drawImage(frameBuffer.canvas, 0, 0);
    ctx.restore();

    return canvas;
  }

  // いま解析に渡しているのと同じ画像を返す（動作確認用）。
  // 枠のズレ・余白の付き方・縮小後にバーが潰れていないかを実機で見るためのもの。
  // 回転経路は 1 フレームおきなので、見比べやすいよう常に正立で切り出す。
  // 解析中はバッファを書き換えないので、その場合はいま渡している画像がそのまま出る
  function capturePreview() {
    ensureConfigured();
    copyPreviewFrame();

    const canvas = captureScanArea(false);
    if (!canvas) return null;

    return {
      canvas,
      width: canvas.width,
      height: canvas.height,
      pad: needsQuietZone() ? SCAN_PAD_X : 0
    };
  }

  // 予約済みの次回ぶんを取り消し、世代を進める。
  // 解析の途中（await 中）の tick は、完了時に世代のずれを見て自分で畳む
  function cancelLoop() {
    runToken += 1;
    clearTimeout(timerId);
    timerId = null;
  }

  // 停止・一時停止のあとにループを回し直す。
  // 走りっぱなしの tick があっても、世代が変わるので二重には回らない
  function restartLoop() {
    cancelLoop();
    if (active && !paused) tick();
  }

  // BarcodeDetector は端末側のモジュール未取得などで例外を返すことがあり、
  // Worker も動き出したあとで落ちることがある。どちらも黙って止まらず、
  // ひとつ下の経路（ネイティブ -> ZXing、Worker -> メインスレッド）に切り替える。
  // メインスレッド実行の ZXing / ZXing-C++ と、明示的に選ばれた Quagga2 には
  // 落ちる先が無いので、そのまま投げ返して onEngineChange にエラーを出す
  async function runDetect(source) {
    try {
      return await detect(source);
    } catch (err) {
      let fallback = null;

      if (engineKind === 'native') {
        console.warn('BarcodeDetector が失敗したため ZXing に切り替えます', err);
        fallback = useZXing();
      } else if (engineKind === 'zxing-worker') {
        console.warn('Worker での解析が失敗したため、メインスレッドに切り替えます', err);
        fallback = createZXingMainDetector();
      } else if (engineKind === 'zxing-cpp-worker') {
        console.warn('Worker での解析が失敗したため、メインスレッドに切り替えます', err);
        fallback = createZXingCppMainDetector();
      }

      if (!fallback) throw err;

      // 次に start() したときも、落ちた先から始める
      detectorCache.set(engineChoice, fallback);
      await applyEngine(fallback);
      return null;
    }
  }

  // 検出したら、既定では解析を止めてから呼び出し側に渡す。
  // 止めないと、結果を見せている間も 8 回/秒で同じコードを拾い続けることになる。
  // 読み直したくなったら呼び出し側が resume() を呼ぶ
  function handleResult(result) {
    if (config.autoPause) pause();
    emit('onDetect', result);
  }

  async function tick() {
    timerId = null;
    // 解析を待っている間にループが畳まれたかどうかを、あとで見分けるための世代番号
    const token = runToken;
    if (!active || paused) return;

    try {
      // ZXing 経路だけ、縦向きバーコード用に 1 フレームおきで 90 度回転させる
      rotateNext = needsRotation() && !rotateNext;

      // プレビューのコピーはここだけ。前回の結果が返ってから次を取る
      const source = copyPreviewFrame() ? captureScanArea(rotateNext) : null;
      if (source) {
        scanCount += 1;
        pendingDetects += 1;
        try {
          const result = await runDetect(source);
          if (active && !paused && result) handleResult(result);
        } finally {
          // 解析が終わるまではコピーを止めておきたいので、必ずここで戻す
          pendingDetects -= 1;
        }
      }
    } catch (err) {
      console.error('バーコードの解析に失敗しました', err);
      setEngineState('error', engineName);
      fail('detect-failed', err);
    }

    // 解析を待っている間にループが畳まれて回し直されていたら、この呼び出しは
    // 古い世代なのでここで終わる。放っておくとループが二重に回り、
    // ZXing の Worker には解析要求が重なって届く
    if (token !== runToken) return;

    // 解析が遅れてもフレームが溜まらないよう、完了してから次を予約する
    if (active && !paused) timerId = setTimeout(tick, SCAN_INTERVAL_MS);
  }

  // --- ライフサイクル ---------------------------------------------------

  function configure(options = {}) {
    Object.assign(config, options);

    if (!config.video) throw new Error('BarcodeScanner.configure: video が必要です。');
    if (!config.scanArea) throw new Error('BarcodeScanner.configure: scanArea が必要です。');

    engineChoice = options.engine || loadEngineChoice();
    configured = true;

    // 停止中の状態を一度流しておく。呼び出し側はこれでボタンの初期表示を決められる
    emitEngine();
  }

  function ensureConfigured() {
    if (!configured) throw new Error('BarcodeScanner: 先に configure() を呼んでください。');
  }

  async function start() {
    ensureConfigured();
    if (active) return;

    active = true;
    paused = false;
    setEngineState('loading', '');

    try {
      await applyEngine(getDetector());
    } catch (err) {
      active = false;
      detectorCache.delete(engineChoice); // 次回の起動で読み込みを再試行する
      stopRateMeter();
      setEngineState('idle', '');
      console.error(err);
      fail('init-failed', err);
      return;
    }

    if (!active) return; // 初期化中に停止された
    startRateMeter();
    tick();
  }

  // 撮影プレビューを開いている間など、カメラは動かしたまま解析だけ止める
  function pause() {
    if (paused) return;
    paused = true;
    cancelLoop();
    emitEngine();
  }

  function resume() {
    if (!paused) return;
    paused = false;
    restartLoop();
    emitEngine();
  }

  function stop() {
    active = false;
    paused = false;
    cancelLoop();
    releasePreviewFrame();
    stopRateMeter();
    setEngineState('idle', '');
  }

  window.BarcodeScanner = {
    configure,
    start,
    stop,
    pause,
    resume,
    setEngine,
    nextEngine,
    capturePreview,
    getEngineState,
    getEngineChoices: () => ENGINE_CHOICES.slice(),
    isActive: () => active,
    isPaused: () => paused
  };
})();
