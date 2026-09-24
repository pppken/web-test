(() => {
  'use strict';

  // バーコード検出の段取り。camera.js から渡されたフレームを検出枠のぶんだけ切り出し、
  // （差し込まれていれば）前処理を通してから、いま選ばれている検出エンジンに渡す。
  //
  // 役割の分担:
  //   camera.js          フレームを取って detect(frame) を呼び、結果を onDetect で知らせる
  //   barcode.js         切り出し・前処理・エンジンの選択と切り替え（このファイル）
  //   barcode-worker.js  BarcodeDetector / ZXing / ZXing-C++ での検出そのもの
  //   barcode-quagga2.js Quagga2 での検出そのもの（Worker に乗らないので別ファイル）
  // 検出エンジンは BarcodeDetector（Chrome / Android 等）を優先し、非対応のブラウザ
  // （iOS Safari / Firefox / デスクトップ Chrome）では同梱の ZXing を使う。
  // ZXing-C++ と Quagga2 は自動では選ばれず、setEngine() で明示的に選んだときだけ使う。
  //
  // このファイルは DOM を探さない。検出枠の要素と結果の受け口は configure() で受け取り、
  // 映像はフレームごとに detect(frame) の frame.video で受け取る。
  //
  //   BarcodeScanner.configure({
  //     scanArea,              // 必須。この要素の矩形の内側だけを切り出して解析する
  //     basePath,              // barcode-worker.js / barcode-quagga2.js の基準。既定はこの js の場所
  //     vendorPath,            // 同梱ライブラリの置き場所。既定は basePath + 'vendor/'
  //     formats,               // 読み取る対象（既定は FORMATS ＝ CODE128 と JAN と CODE39）
  //     engine,                // 'auto' | 'zxing' | 'zxing-cpp' | 'quagga'
  //     storageKey,            // エンジン選択の保存先。null で保存しない
  //     frameFilter,           // 解析に渡す画像を作り直す差し込み口（既定 null ＝ 素通し）。
  //                            // 約束ごとは「差し込みの前処理」を参照
  //     onEngineChange(state),
  //     onError({ code, message, error })
  //   });
  //   BarcodeScanner.start() / stop()          // カメラの起動・停止に合わせて呼ぶ
  //   BarcodeScanner.detect(frame)             // → Promise<{ text, format } | null>
  //   BarcodeScanner.setEngine(choice) / nextEngine() / capturePreview()
  //
  // detect は camera.js の detector にそのまま渡す関数。frame は camera.js の
  // フレーム（{ video, width, height, ... }）で、video は画面に出している <video> であること
  // （検出枠との位置合わせを、その表示矩形で行うため）。
  // 解析中に次の detect が来ることは無い前提（camera.js が結果を待ってから次を渡す）。
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

  // 検出処理のファイル。barcode-worker.js は Worker としても <script> としても読む
  // （Worker を作れない・落ちたときのメインスレッド実行）。
  // barcode-quagga2.js は Quagga2 を選んだときだけ <script> で読む
  const WORKER_SRC = 'barcode-worker.js';
  const QUAGGA_MODULE_SRC = 'barcode-quagga2.js';

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

  // ZXing-C++ の解析オプション。検出は barcode-worker.js が行うが、重さの調整はここ
  // （定数の置き場）で行う。速度が足りないときは onEngineChange の rate を見ながら外す。
  //
  // **zxing-wasm 3.1.4 の ReaderOptions を全項目書いてある。** 何が効いているかを
  // ここだけで読めるようにするためで、既定値のものも省略しない。既定値は同梱の
  // vendor/zxing-wasm-reader-3.1.4.min.js が持つ既定のオブジェクトで確認した
  // （版を上げたら項目の増減と既定値を突き合わせ直すこと）。
  // 各行の末尾に「既定」とあるものは既定値のまま、「変更」は既定から変えてあるもの。
  //
  // formats だけはここに書かない。configure() の formats（既定は FORMATS）から
  // barcode-worker.js が入れる（既定は [] ＝ 全フォーマット）。
  const ZXING_CPP_OPTIONS = {
    // 既定 true。ZXing 経路（TRY_HARDER）と揃えて明示しておく。
    // 重いときに最初に外す場所
    tryHarder: true,
    // 既定 true。これが効くので、この経路ではこちら側で 90 度回転させない
    // （needsRotation() が false）
    tryRotate: true,
    // 変更（既定 true）。白黒反転した画像は試さない。通常のバーコードの実効回数が落ちる
    tryInvert: false,
    // 変更（既定 true）。縮小した画像でも読みに行く。ライブラリ側は downscaleThreshold を
    // 超える辺だけを downscaleFactor で縮めるので、MAX_SCAN_SIDE = 640 のこの経路では
    // 実際に走る（重いときは tryHarder の次に外す候補）
    tryDownscale: false,
    // 既定 false。3.1.4 では ZXING_EXPERIMENTAL_API の中にあり、しかも
    // Aztec / DataMatrix / QRCode にしか適用されない
    // （ReadBarcode.cpp の formatsBenefittingFromClosing）。1D には効かない
    tryDenoise: false,
    // 既定 'LocalAverage'。**1D では 'GlobalHistogram' と完全に同じ経路**を通る
    // （HybridBinarizer::getPatternRow が GlobalHistogramBinarizer::getPatternRow を
    // そのまま呼ぶ）。局所しきい値が効くのは 2D コードだけなので、読み比べても差は出ない
    binarizer: 'LocalAverage',
    // 既定 false。true にすると「画像全体が余白なしの 1 つのコード」とみなして探索を省く。
    // カメラ映像には使えない
    isPure: false,
    // 既定 3 / 500。tryDownscale のときに、辺が downscaleThreshold を超える画像を
    // 1/downscaleFactor に縮めた層を作る
    downscaleFactor: 3,
    downscaleThreshold: 500,
    // 既定 2。1D は 1 行ずつ読み、**同じ結果が 2 行で出ないと最後に捨てる**
    // （ODReader.cpp の DoDecode 末尾の erase_if）。印字が荒くて
    // 「まぐれで 1 行だけ読めた」ぶんはここで落ちている。
    // 1 にすれば拾えるが誤読の目が増えるので、**まず前処理を試すこと。**
    // 前処理（barcode-preprocess.js）の画像は全行が同じ内容なので、この条件は自動的に満たされる
    minLineCount: 2,
    // 変更（既定 255）。1 件見つかった時点で打ち切る（枠内に複数は想定していない）
    maxNumberOfSymbols: 1,
    // 既定 false。任意のチェックサム（Code39 / ITF など）も検証する。CODE128 / JAN の
    // チェックディジットは必須なので、この値に関わらず常に検証される
    validateOptionalChecksum: false,
    // 既定 false。true にすると読めなかった候補もエラー付きで返す。
    // barcode-worker.js は results[0] をそのまま結果にするので、true にしないこと
    returnErrors: false,
    // 既定 'Ignore'。JAN のアドオン（2 桁 / 5 桁の添え字）は読まない
    eanAddOnSymbol: 'Ignore',
    // 既定 'HRI'。text を人が読む形（Human Readable Interpretation）で返す
    textMode: 'HRI',
    // 既定 'Unknown'。文字コードは自動判定に任せる（1D の数字・英数字には関係しない）
    characterSet: 'Unknown',
    // 既定 true。Code39 の拡張モード（Full ASCII。'+A' を 'a' と読むなど）も試す。
    // 拡張として読めたものは format が Code39Ext になる（結果の表記はどちらも CODE_39）
    tryCode39ExtendedMode: true
  };

  // 解析に回す画像の最大辺。切り出したあとの処理（getImageData →
  // グレースケール変換 → 二値化 → デコード）はすべて画素数に比例するので、
  // ここを絞るのが一番素直に効く。
  //
  // 900 では大半の端末で切り出しサイズを下回らず、実質的に無効だった
  // （例: 1080p 縦持ちの iPhone で切り出しは 864x768）。640 まで落としても
  // JAN（95 モジュール）や短めの CODE128 ならバーの太さは十分残る。
  // 桁数の多い CODE128（20 桁で 250 モジュール程度）は細バーが 2〜3px まで
  // 痩せるので、読めないときはここを戻して実機で見ること
  const MAX_SCAN_SIDE = 640;

  // ZXing / Quagga2 に渡す画像の左右に足す白い余白の幅（px）。
  // 検出枠いっぱいにバーコードが写っていると、開始/終了記号の外側に必要な
  // 静止領域（クワイエットゾーン）まで切り落とされて読めないことがあるので、
  // 切り出した画像の左右を白で埋めて補う。
  // 回転経路でもバーが並ぶ向きは canvas の横方向なので、足す位置は同じ
  //
  // **一時的に 0（余白なし）にしてある。** 元に戻すときは 50 にする。
  // 0 のときは captureScanArea() が白い帯を塗らず、切り出した画像をそのまま渡す
  const SCAN_PAD_X = 0;

  // 読み取る対象のフォーマット。既定は CODE128 と JAN（＝ EAN-13 / EAN-8）と CODE39。
  // JAN は 13 桁と 8 桁で別のフォーマット扱いなので 2 件書く。
  // BarcodeDetector / ZXing / ZXing-C++ / Quagga2 で表記が違うので 4 つとも持つ。大半は
  // 大文字小文字と区切りの差でしかないが、PDF417 だけ 'pdf417' / 'PDF_417' と規則が
  // 揃わないため機械的な変換はせず、増やすときは 4 つとも書くこと。
  // Quagga2 はリーダー名で指定する（対応表は同梱ライブラリの Readers を参照）。
  // EAN-13 だけ 'ean_13_reader' ではなく 'ean_reader' なので注意。
  // ZXing-C++ の表記は同梱の js が持つ `ZXingWASM.barcodeFormats` が一覧（区切りは入らない。
  // 'EAN-13' のような綴りも受け付けるが、結果に入るのは 'EAN13' のほうなので一覧に合わせる。
  // **綴りが違っても例外にはならず、黙って全フォーマットを見に行く**ので注意）。
  // ZXing-C++ の 'Code39' は Code39Std / Code39Ext をまとめた括りで、結果の format には
  // 'Code39Std' などが入る。symbology のほうが 'Code39' になるので、barcode-worker.js の
  // zxingCppFormat() がそちらで拾って CODE_39 に直す。
  // 結果の format は全経路で zxing の表記（CODE_128 / EAN_13 / EAN_8 / CODE_39）に揃えてから返す
  // （揃えるのは barcode-worker.js / barcode-quagga2.js 側）
  const FORMATS = [
    { native: 'code_128', zxing: 'CODE_128', zxingCpp: 'Code128', quagga: 'code_128_reader' },
    { native: 'ean_13', zxing: 'EAN_13', zxingCpp: 'EAN13', quagga: 'ean_reader' },
    { native: 'ean_8', zxing: 'EAN_8', zxingCpp: 'EAN8', quagga: 'ean_8_reader' },
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
    scanArea: null,
    basePath: DEFAULT_BASE_PATH,
    vendorPath: null,
    formats: FORMATS,
    engine: null,
    storageKey: DEFAULT_STORAGE_KEY,
    frameFilter: null,
    onEngineChange: null,
    onError: null
  };

  let configured = false;

  // 検出領域だけを切り出すための作業用キャンバス。
  // 画素（getImageData）で渡すエンジンが多いので willReadFrequently を立てておく。
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

  // フレーム（<video>）の複製先。解析はこのコピーに対して行い、解析のあいだは
  // 映像そのものには一切触らない。
  //
  // 持つのは検出枠のぶんだけ・縮小済み（正立・余白なし）。**ここを広げないこと。**
  // 映像を丸ごと複製すると 1 回あたり約 200 万画素（1080p 縦持ち）を読むことになるが、
  // 実際に要るのは枠のぶん（縮小後で約 36 万画素）しかない。映像に触る量は少ないほどよい。
  // camera.js がフレームを画素ではなく <video> のまま渡してくるのも同じ理由。
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

  // いま動いているエンジン。{ base, kind, worker, name, input, decode }
  //   base    'native' | 'zxing' | 'zxing-cpp' | 'quagga'。切り出し方（余白・回転）を決める
  //   kind    base に Worker かどうかを足したもの（'zxing-worker' など）。状態の通知用
  //   input   decode に渡す形。'pixels'（RGBA）/ 'bitmap'（ImageBitmap）/ 'canvas'
  //   decode  (request) => Promise<{ text, format } | null>
  let engine = null;

  // 選択値 -> Promise<エンジン>。一度作ったものは取っておき、エンジンを
  // 切り替えて戻したときにライブラリの読み直しや Worker の作り直しをしない
  const detectorCache = new Map();

  let active = false;        // 読み取り中か（start / stop で切り替わる）
  let rotateNext = false;
  let lastFrame = null;      // 最後に受け取ったフレーム。capturePreview() が使う

  // 解析中の件数。0 でないあいだはフレームのコピーを行わない。
  // 真偽値ではなく数で持つのは、停止した直後に古い解析がまだ返っていない
  // ことがあるため（それぞれが自分のぶんだけ戻す）
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

  // barcode-worker.js / barcode-quagga2.js はこの js と同じ場所にある前提
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

  // 他の js と同じ理由でキャッシュ対策を付ける（AGENTS.md の読み込み順を参照）
  function withVersion(url) {
    return `${url}?v=${Date.now()}`;
  }

  function isAnalyzing() {
    return pendingDetects > 0;
  }

  // 余白を足すのは同梱ライブラリの経路だけ。BarcodeDetector は向きも含めて
  // 端末側の実装に任せるので、余分な画素を渡して 1 回の検出を重くしない
  function needsQuietZone() {
    return !engine || engine.base !== 'native';
  }

  // 1 フレームおきの 90 度回転が要るのは ZXing だけ。BarcodeDetector・
  // ZXing-C++（tryRotate）・Quagga2（locator）はバーコードの向きを自前で処理する
  function needsRotation() {
    return Boolean(engine) && engine.base === 'zxing';
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
      kind: engine ? engine.kind : '',
      choice: engineChoice,
      active,
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

  // 1 秒ごとに実際の解析回数を集計する。0/s なら camera.js のループが回っていない
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

  // --- 検出エンジンの用意 -----------------------------------------------
  //
  // 検出そのものはこのファイルでは行わない。barcode-worker.js（Worker、駄目なら
  // メインスレッドに <script> で読み込んだもの）か barcode-quagga2.js を用意して、
  // 解析の関数（decode）を受け取るだけ。

  // 読み込みが返らないまま固まるのを避けるため、必ずタイムアウトさせる。
  // barcode-worker.js / barcode-quagga2.js をメインスレッドで動かすときは、
  // 同梱ライブラリの読み込みにもこれを渡す
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

  // 解決も棄却もされないままの Promise で初期化が止まらないようにする
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

  // barcode-worker.js が扱うエンジンの設定。init はそのまま decoder の初期化に渡る
  // （Worker 内は相対パスの基準が変わるので、URL はすべて絶対 URL にしてから渡す）
  function engineSpec(base) {
    if (base === 'native') {
      return {
        base, name: 'BarcodeDetector', input: 'bitmap', timeout: LIB_TIMEOUT_MS,
        init: { engine: 'native' }
      };
    }

    if (base === 'zxing-cpp') {
      return {
        base, name: 'ZXing-C++', input: 'pixels',
        // wasm の取得とコンパイルまで待つので、こちらは長めのタイムアウト
        timeout: WASM_INIT_TIMEOUT_MS,
        init: {
          engine: 'zxing-cpp',
          src: resolveVendor(ZXING_CPP_SRC),
          wasm: resolveVendor(ZXING_CPP_WASM),
          options: ZXING_CPP_OPTIONS
        }
      };
    }

    return {
      base: 'zxing', name: 'ZXing', input: 'pixels', timeout: LIB_TIMEOUT_MS,
      init: { engine: 'zxing', src: resolveVendor(ZXING_SRC) }
    };
  }

  // 検出を barcode-worker.js に投げる経路（既定）。どのエンジンも解析のあいだ
  // 呼び出したスレッドを止めるので、メインスレッドに残るのは切り出しと転送だけにする
  function createWorkerEngine(spec) {
    if (typeof Worker !== 'function') {
      return Promise.reject(new Error('Worker に対応していません。'));
    }

    const workerSrc = resolveUrl(WORKER_SRC);
    const worker = new Worker(withVersion(workerSrc));
    let pending = null;
    let nextId = 0;

    function decode(request) {
      return new Promise((resolve, reject) => {
        // 前の解析が応答を返さないまま次が来た場合は捨てる。放置すると
        // Promise が残り続けて、camera.js のループが二度と進まなくなる
        if (pending) pending.reject(new Error('前の解析が完了していません。'));

        const id = (nextId += 1);
        pending = { id, resolve, reject };

        // 画素（ArrayBuffer）も ImageBitmap も転送で渡す（サイズによらずコピーが起きない）
        const transfer = request.buffer ? [request.buffer] : request.bitmap ? [request.bitmap] : [];
        worker.postMessage({ id, ...request }, transfer);
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
          resolve({
            base: spec.base,
            kind: `${spec.base}-worker`,
            worker: true,
            name: `${spec.name} (Worker)`,
            input: spec.input,
            decode
          });
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

  // Worker を使えない環境向けの経路。barcode-worker.js をそのまま <script> で読み込み、
  // 同じ検出コードをメインスレッドで動かす（解析のあいだ画面が止まる）
  async function createMainEngine(spec) {
    if (!window.BarcodeWorkerCore) await loadScript(withVersion(resolveUrl(WORKER_SRC)));

    const core = window.BarcodeWorkerCore;
    if (!core) throw new Error('barcode-worker.js を読み込めませんでした。');

    const decode = await withTimeout(
      core.createDecoder({ formats: config.formats, ...spec.init }, loadScript),
      spec.timeout,
      `${spec.name} の初期化がタイムアウトしました。`
    );

    return { base: spec.base, kind: spec.base, worker: false, name: spec.name, input: spec.input, decode };
  }

  // Quagga2 の経路。自動では選ばれず、setEngine('quagga') で選んだときだけ使う。
  // Worker に乗らないので barcode-quagga2.js をメインスレッドに読み込む
  async function createQuaggaEngine() {
    if (!window.BarcodeQuagga2) await loadScript(withVersion(resolveUrl(QUAGGA_MODULE_SRC)));

    const quagga = window.BarcodeQuagga2;
    if (!quagga) throw new Error('barcode-quagga2.js を読み込めませんでした。');

    const decode = await quagga.createDecoder(
      { formats: config.formats, src: resolveVendor(QUAGGA_SRC) },
      loadScript
    );

    // 画素ではなく canvas のまま渡す（decodeSingle は data URL でしか受け取れないため）
    return { base: 'quagga', kind: 'quagga', worker: false, name: 'Quagga2', input: 'canvas', decode };
  }

  // Worker で動かし、駄目ならメインスレッドに落ちる
  function useEngine(base) {
    const spec = engineSpec(base);
    setEngineState('loading', spec.name);

    return createWorkerEngine(spec).catch((err) => {
      // Worker が駄目でも読み取り自体は続けられるようにする。
      // どちらで動いているかは onEngineChange の name で分かる
      console.warn(`${spec.name} を Worker で動かせないため、メインスレッドで実行します`, err);
      return createMainEngine(spec);
    });
  }

  // 'auto'。BarcodeDetector が使えなければ ZXing に落ちる（従来どおりの順序）。
  // window に無ければ Worker にも無いので、最初から ZXing にする
  function useAuto() {
    if (!('BarcodeDetector' in window)) return useEngine('zxing');

    return useEngine('native').catch((err) => {
      console.warn('BarcodeDetector を利用できません', err);
      return useEngine('zxing');
    });
  }

  // いまの選択に対応する検出器。一度作ったものは detectorCache から使い回す
  function getDetector() {
    if (!detectorCache.has(engineChoice)) {
      if (engineChoice === 'quagga') {
        setEngineState('loading', 'Quagga2');
        detectorCache.set(engineChoice, createQuaggaEngine());
      } else if (engineChoice === 'zxing-cpp') {
        detectorCache.set(engineChoice, useEngine('zxing-cpp'));
      } else if (engineChoice === 'zxing') {
        detectorCache.set(engineChoice, useEngine('zxing'));
      } else {
        detectorCache.set(engineChoice, useAuto());
      }
    }

    return detectorCache.get(engineChoice);
  }

  // 出来上がったエンジンを「いま動いているもの」として据える。
  // 切り出し方（余白・回転）とフォールバック先は、ここで入る base / worker で決まる
  async function applyEngine(promise) {
    const next = await promise;

    engine = next;
    setEngineState('ready', next.name);
  }

  // 解析中に失敗したときの落ち先。BarcodeDetector は端末側のモジュール未取得などで
  // 例外を返すことがあり、Worker も動き出したあとで落ちることがある。
  // どちらも黙って止まらず、ひとつ下の経路（Worker -> メインスレッド、
  // ネイティブ -> ZXing）に切り替える。落ちる先が無ければ null
  function fallbackFor(current, err) {
    if (current.worker) {
      console.warn('Worker での解析が失敗したため、メインスレッドに切り替えます', err);
      return createMainEngine(engineSpec(current.base));
    }

    if (current.base === 'native') {
      console.warn('BarcodeDetector が失敗したため ZXing に切り替えます', err);
      return useEngine('zxing');
    }

    return null;
  }

  // --- 切り出し ---------------------------------------------------------

  // <video> の箱の中で、映像が実際に描かれている矩形を求める。
  // object-fit が既定（contain）のままでも、箱と映像のアスペクト比が違えば
  // 上下か左右にレターボックスができる。そこを差し引かないと切り出し位置がずれるので、
  // 箱の矩形ではなく映像の矩形を基準にする。object-position は既定（中央）を前提
  function videoContentRect(video) {
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
  function measureScanArea(video) {
    const videoRect = videoContentRect(video);
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

  // このフレームの切り出し範囲を決める。解析中・映像の準備前は null（＝コピーしない）。
  // 1 回のコピーにつき解析は 1 回、その結果が返ってから次をコピーする。
  // 範囲はコピーの直前にここで確定させる（あとから測ると、コピーした絵と枠がずれる）
  function measureFrame(frame) {
    const video = frame.video;
    if (isAnalyzing()) return null;
    if (!video.videoWidth || !video.videoHeight) return null;

    return measureScanArea(video);
  }

  // フレームから検出枠（crop）のぶんをバッファに複製する。
  // 解析に渡すのはこのコピーで、このファイルの中で映像そのものを読むのはここだけ
  // （frameFilter を差し込んだときは、そちらも同じ crop の範囲を読む）
  function copyPreviewFrame(video, crop) {
    if (!crop || isAnalyzing()) return false;

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

  // --- 差し込みの前処理（frameFilter）-----------------------------------
  //
  // 解析に渡す画像を、呼び出し側が差し込んだ処理で作り直せるようにする口。
  // いまは js/barcode-preprocess.js（縦方向の集約。検討中）がここに入る。
  // **前処理にまつわるもの（定数・作業用 canvas・A/B の集計）は全部あちらにあり、
  // このファイルが持つのはこの口だけ。** frameFilter を渡さなければ（既定）、
  // 従来どおり素通しの画像を解析する。
  //
  //   frameFilter(frame) → Promise<frame.analyze() の戻り値 | null>
  //     frame.video           <video>。読むのは frame.crop の範囲だけにすること
  //     frame.crop            検出枠を映像の実ピクセル座標にしたもの { sx, sy, sw, sh }
  //     frame.preview         capturePreview() からの呼び出しか（true なら数える類のことはしない）
  //     frame.plain()         素通しの画像（余白・回転込み）。作れなければ null
  //     frame.analyze(source) source を解析して { text, format } | null を返す。
  //                           preview のときは解析せず source をそのまま返す
  //
  // analyze は 1 回の呼び出しにつき 1 回まで。frameFilter が返るまで次のフレームは来ない。
  // 呼ばれるのは解析中でないときだけなので、差し込む側は自前の作業用 canvas を
  // 気兼ねなく書き換えてよい

  // 解析に渡す形にする。Worker には画素か ImageBitmap を転送で渡す
  async function toRequest(source, input) {
    if (input === 'canvas') return { canvas: source };
    if (input === 'bitmap') return { bitmap: await createImageBitmap(source) };

    // 既に 2d コンテキストがあるので、getContext は作成済みのものを返す
    const image = source.getContext('2d').getImageData(0, 0, source.width, source.height);
    return { width: image.width, height: image.height, buffer: image.data.buffer };
  }

  // 解析を 1 回回す。終わるまではフレームのコピーを止めておく
  async function analyze(source) {
    if (!source || !engine) return null;

    const current = engine;
    scanCount += 1;
    pendingDetects += 1;

    try {
      const request = await toRequest(source, current.input);

      try {
        return await current.decode(request);
      } catch (err) {
        const fallback = fallbackFor(current, err);
        if (!fallback) throw err;

        // 次に start() したときも、落ちた先から始める
        detectorCache.set(engineChoice, fallback);
        await applyEngine(fallback);
        return null;
      }
    } finally {
      // 解析が終わるまではコピーを止めておきたいので、必ずここで戻す
      pendingDetects -= 1;
    }
  }

  // camera.js から渡されたフレームを 1 枚解析する。camera.js の detector にそのまま渡す。
  // frameFilter が差し込まれていれば、画像づくりと解析の呼び出しをそちらに任せる。
  // **frameFilter を呼ぶのは、ここと capturePreview() だけ**。
  //
  // 失敗しても投げずに null を返し、onError で知らせる（camera.js のループは回し続ける）
  async function detect(frame) {
    if (!active || !engine || !frame || !frame.video) return null;

    lastFrame = frame;
    const crop = measureFrame(frame);
    if (!crop) return null;

    const filterFrame = {
      video: frame.video,
      crop,
      preview: false,
      // ZXing 経路だけ、縦向きバーコード用に 1 フレームおきで 90 度回転させる
      plain: () => {
        rotateNext = needsRotation() && !rotateNext;
        return copyPreviewFrame(frame.video, crop) ? captureScanArea(rotateNext) : null;
      },
      analyze
    };

    try {
      const result = await (config.frameFilter
        ? config.frameFilter(filterFrame)
        : analyze(filterFrame.plain()));

      // 解析を待っている間に止められていたら、結果は捨てる
      return active ? result || null : null;
    } catch (err) {
      console.error('バーコードの解析に失敗しました', err);
      setEngineState('error', engineName);
      fail('detect-failed', err);
      return null;
    }
  }

  // いま解析に渡しているのと同じ画像を返す（動作確認用）。
  // 枠のズレ・余白の付き方・縮小後にバーが潰れていないかを実機で見るためのもの。
  // 回転経路は 1 フレームおきなので、見比べやすいよう常に正立で切り出す。
  // 解析中はバッファを書き換えないので、その場合はいま渡している画像がそのまま出る。
  //
  // frameFilter が作った画像のときは filtered が true で、pad は分からないので null
  // （余白や検証用の情報は差し込んだ側に問い合わせること）
  async function capturePreview() {
    ensureConfigured();
    if (!active || !lastFrame) return null;

    const video = lastFrame.video;
    const crop = measureFrame(lastFrame);
    let plainUsed = false;

    const frame = {
      video,
      crop,
      preview: true,
      plain: () => {
        plainUsed = true;
        copyPreviewFrame(video, crop);
        return captureScanArea(false);
      },
      analyze: (source) => source
    };

    // 解析中（crop が null）は frameFilter にも回さない。差し込む側の作業用 canvas が
    // 解析に渡している最中のことがある
    const canvas = config.frameFilter && crop ? await config.frameFilter(frame) : frame.plain();
    if (!canvas) return null;

    return {
      canvas,
      width: canvas.width,
      height: canvas.height,
      pad: plainUsed ? (needsQuietZone() ? SCAN_PAD_X : 0) : null,
      filtered: !plainUsed
    };
  }

  // --- ライフサイクル ---------------------------------------------------

  function configure(options = {}) {
    Object.assign(config, options);

    if (!config.scanArea) throw new Error('BarcodeScanner.configure: scanArea が必要です。');

    // 選択の復元は初回だけ。configure() は設定を足すために何度でも呼べるので
    // （app.js は frameFilter の差し込みに使っている）、毎回ここを通すと
    // storageKey が null のときに選択が既定へ戻ってしまう
    if (options.engine) engineChoice = options.engine;
    else if (!configured) engineChoice = loadEngineChoice();

    configured = true;

    // 停止中の状態を一度流しておく。呼び出し側はこれでボタンの初期表示を決められる
    emitEngine();
  }

  function ensureConfigured() {
    if (!configured) throw new Error('BarcodeScanner: 先に configure() を呼んでください。');
  }

  // カメラの起動に合わせて呼ぶ。エンジンを用意するだけで、フレームは camera.js が
  // detect() で渡してくる（用意ができるまでの detect() は null を返す）
  async function start() {
    ensureConfigured();
    if (active) return;

    active = true;
    lastFrame = null;
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
  }

  function stop() {
    active = false;
    lastFrame = null;
    releasePreviewFrame();
    stopRateMeter();
    setEngineState('idle', '');
  }

  window.BarcodeScanner = {
    configure,
    start,
    stop,
    detect,
    setEngine,
    nextEngine,
    capturePreview,
    getEngineState,
    getEngineChoices: () => ENGINE_CHOICES.slice(),
    isActive: () => active
  };
})();
