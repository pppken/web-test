(() => {
  'use strict';

  // 検出は BarcodeDetector（Chrome / Android 等）を優先し、
  // 非対応のブラウザ（iOS Safari / Firefox / デスクトップ Chrome）では同梱の ZXing を使う。
  // ZXing-C++ と Quagga2 は自動では選ばれず、「エンジン」ボタンで明示的に選んだときだけ使う。
  // どのライブラリも、初回に必要になったときだけ読み込む
  // （ZXing 約 330KB / ZXing-C++ 約 36KB + wasm 約 930KB / Quagga2 約 150KB）
  const ZXING_SRC = 'vendor/zxing-0.21.3.min.js';
  const QUAGGA_SRC = 'vendor/quagga2-1.12.1.min.js';
  const LIB_TIMEOUT_MS = 10000;

  // ZXing-C++（zxing-wasm の reader ビルド）。js と wasm の 2 つで 1 組なので、
  // 版を上げるときは両方を差し替える。wasm の場所は locateFile で指定するため、
  // ファイル名は vendor の流儀（バージョン入り）に揃えてある
  const ZXING_CPP_SRC = 'vendor/zxing-wasm-reader-3.1.4.min.js';
  const ZXING_CPP_WASM = 'vendor/zxing-wasm-reader-3.1.4.wasm';

  // ZXing-C++ の初期化を打ち切るまでの時間。js（約 36KB）の読み込みだけでなく
  // wasm（約 930KB）の取得とコンパイルまで待つので、他のライブラリ
  // （LIB_TIMEOUT_MS = 10 秒）と同じ尺では回線の細い実機で足りない
  const WASM_INIT_TIMEOUT_MS = 30000;

  // ZXing-C++ の解析オプション。formats は FORMATS から入れるのでここには書かない。
  //   maxNumberOfSymbols  1 件見つかった時点で打ち切る（枠内に複数は想定していない）
  //   tryInvert           白黒反転した画像は試さない。ZXing 経路で
  //                       HTMLCanvasElementLuminanceSource の第 2 引数を false に
  //                       しているのと同じ理由で、通常のバーコードの実効回数が落ちる
  // tryHarder / tryRotate / tryDownscale は既定（いずれも true）のまま。
  // 特に tryRotate が効くので、この経路ではこちら側で 90 度回転させない
  // （needsRotation() が false）。速度が足りないときは #engine の N/s を見ながら外す
  const ZXING_CPP_OPTIONS = {
    maxNumberOfSymbols: 1,
    tryInvert: false
  };

  // 既定の locateFile は wasm を jsDelivr から取りに行くので、同梱したものを指すように
  // 差し替える。prepareZXingModule は overrides の中身が前回と同じなら作った Module を
  // 使い回すため、呼ぶたびに新しい関数を渡さないよう 1 つだけ持つ
  const ZXING_CPP_OVERRIDES = {
    locateFile: (path, prefix) => (path.endsWith('.wasm') ? ZXING_CPP_WASM : prefix + path)
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
  const LABEL_RESET_MS = 1500;

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

  // 読み取る対象のフォーマット。現状は CODE39 のみ。
  // BarcodeDetector / ZXing / ZXing-C++ / Quagga2 で表記が違うので 4 つとも持つ。大半は
  // 大文字小文字と区切りの差でしかないが、PDF417 だけ 'pdf417' / 'PDF_417' と規則が
  // 揃わないため機械的な変換はせず、増やすときは 4 つとも書くこと。
  // Quagga2 はリーダー名で指定する（対応表は同梱ライブラリの Readers を参照）。
  // ZXing-C++ の表記は zxing-wasm の README にある一覧を参照。
  // 結果の format は全経路で zxing の表記（CODE_39）に揃えてから返す
  const FORMATS = [
    { native: 'code_39', zxing: 'CODE_39', zxingCpp: 'Code39', quagga: 'code_39_reader' }
  ];

  const video = document.getElementById('video');
  const scanArea = document.getElementById('scanArea');
  const engineLabel = document.getElementById('engine');

  const dialog = document.getElementById('result');
  const dialogTitle = document.getElementById('resultTitle');
  const dialogFormat = document.getElementById('resultFormat');
  const dialogValue = document.getElementById('resultValue');
  const copyBtn = document.getElementById('resultCopyBtn');
  const closeBtn = document.getElementById('resultCloseBtn');

  const engineBtn = document.getElementById('engineBtn');

  const previewBtn = document.getElementById('scanPreviewBtn');
  const previewDialog = document.getElementById('scanPreview');
  const previewImage = document.getElementById('scanPreviewImage');
  const previewInfo = document.getElementById('scanPreviewInfo');
  const previewCloseBtn = document.getElementById('scanPreviewCloseBtn');

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
  // 映像を丸ごと複製する版では 1 回あたり約 200 万画素（1080p 縦持ち）を読むことになり、
  // 実機で検出領域に物体を入れたとき（バーコードを掲げたときに顕著）に
  // プレビューが一瞬ズレる症状が出た。枠のぶんだけに絞ると出なくなる。
  // 実際に要るのも全体の 1/3 ほどしかない。映像に触る量は少ないほどよい。
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

  let active = false;        // カメラ稼働中か（camera.js が制御する）
  let paused = false;        // 撮影中など、一時的に解析を止めているか
  let timerId = null;
  let labelTimerId = null;
  let rotateNext = false;
  let runToken = 0;          // ループを畳むたびに進める。tick の世代を見分ける

  // 解析中の件数。0 でないあいだはプレビューのコピーを行わない。
  // 真偽値ではなく数で持つのは、ループを畳んだ直後に古い tick の解析が
  // まだ返っていないことがあるため（それぞれが自分のぶんだけ戻す）
  let pendingDetects = 0;

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

  // --- エンジン表示（動作確認用）-----------------------------------------

  let engineName = '';
  let scanCount = 0;
  let scanRate = null;
  let rateTimerId = null;

  function renderEngine() {
    if (!engineName) {
      engineLabel.textContent = '';
      return;
    }
    engineLabel.textContent = scanRate === null ? engineName : `${engineName} · ${scanRate}/s`;
  }

  function setEngine(name) {
    engineName = name;
    renderEngine();
  }

  // 1 秒ごとに実際の解析回数を集計する。0/s ならループが回っていない
  function startRateMeter() {
    stopRateMeter();
    rateTimerId = setInterval(() => {
      scanRate = scanCount;
      scanCount = 0;
      renderEngine();
    }, 1000);
  }

  function stopRateMeter() {
    clearInterval(rateTimerId);
    rateTimerId = null;
    scanCount = 0;
    scanRate = null;
  }

  // --- エンジンの選択 ---------------------------------------------------

  // 同じバーコードを同じ端末で読み比べられるように、使うエンジンを選べるようにしてある。
  // '自動' は従来どおり BarcodeDetector → ZXing。Android 実機では BarcodeDetector が
  // 常に勝つので、'自動' のままだと ZXing / ZXing-C++ / Quagga2 の実力を実機で見られない
  const ENGINE_KEY = 'barcodeEngine';
  const ENGINE_CHOICES = [
    { value: 'auto', label: '自動' },
    { value: 'zxing', label: 'ZXing' },
    { value: 'zxing-cpp', label: 'ZXing-C++' },
    { value: 'quagga', label: 'Quagga2' }
  ];

  // camera.js の向き設定と同じ理由で、localStorage は読み書きとも握りつぶす
  function loadEngineChoice() {
    try {
      const saved = localStorage.getItem(ENGINE_KEY);
      if (ENGINE_CHOICES.some((choice) => choice.value === saved)) return saved;
    } catch (err) {
      console.warn('エンジン設定の読み込みに失敗しました', err);
    }
    return ENGINE_CHOICES[0].value;
  }

  function saveEngineChoice(value) {
    try {
      localStorage.setItem(ENGINE_KEY, value);
    } catch (err) {
      console.warn('エンジン設定の保存に失敗しました', err);
    }
  }

  let engineChoice = loadEngineChoice();

  function renderEngineButton() {
    const choice = ENGINE_CHOICES.find((item) => item.value === engineChoice);
    engineBtn.textContent = `エンジン: ${choice.label}`;
  }

  // 押すたびに 自動 -> ZXing -> ZXing-C++ -> Quagga2 と巡回する。
  // 動作中ならカメラは止めずに、検出器だけその場で差し替える
  async function switchEngine() {
    const previous = engineChoice;
    const previousLabel = engineName;
    const index = ENGINE_CHOICES.findIndex((choice) => choice.value === previous);

    engineChoice = ENGINE_CHOICES[(index + 1) % ENGINE_CHOICES.length].value;
    saveEngineChoice(engineChoice);
    renderEngineButton();

    // 停止中は選択を覚えるだけ。次の start() がこの選択で初期化する
    if (!active) return;

    engineBtn.disabled = true;
    setEngine('準備中…');

    try {
      await applyEngine(getDetector());
    } catch (err) {
      // 切り替えに失敗しても直前のエンジンはそのまま動いているので、
      // 選択だけ戻して読み取りは続ける（camera.js の前後切替と同じ扱い）
      detectorCache.delete(engineChoice);
      engineChoice = previous;
      saveEngineChoice(previous);
      renderEngineButton();
      setEngine(previousLabel);
      console.error(err);
      showError(`エンジンを切り替えられませんでした。\n${err.message}`);
    } finally {
      engineBtn.disabled = false;
    }
  }

  engineBtn.addEventListener('click', switchEngine);
  renderEngineButton();

  // --- ダイアログ -------------------------------------------------------

  // 結果と検出画像のどちらかを開いている間は解析を止める。
  // 解析を続けるとモーダルが重なってしまう
  function anyDialogOpen() {
    return dialog.open || previewDialog.open;
  }

  // ボタンのラベルを一時的に差し替える（原文は dataset.label に退避する）
  function setLabel(button, text) {
    const original = button.dataset.label || button.textContent;
    button.dataset.label = original;
    button.textContent = text;

    clearTimeout(labelTimerId);
    labelTimerId = setTimeout(() => {
      button.textContent = original;
    }, LABEL_RESET_MS);
  }

  function openDialog() {
    if (dialog.open) return;

    // <dialog> 非対応ブラウザでも最低限は表示されるようにしておく
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function showResult(result) {
    dialog.classList.remove('error');
    dialogTitle.textContent = 'バーコードを検出しました';
    dialogFormat.textContent = result.format || '';
    dialogValue.textContent = result.text;
    // クリップボードは安全なコンテキストでしか使えない
    copyBtn.hidden = !(navigator.clipboard && navigator.clipboard.writeText);
    openDialog();
  }

  function showError(message) {
    dialog.classList.add('error');
    dialogTitle.textContent = 'バーコードを読み取れません';
    dialogFormat.textContent = '';
    dialogValue.textContent = message;
    copyBtn.hidden = true;
    openDialog();
  }

  async function copyValue() {
    try {
      await navigator.clipboard.writeText(dialogValue.textContent);
      setLabel(copyBtn, 'コピーしました');
    } catch (err) {
      console.warn('クリップボードへのコピーに失敗しました', err);
      setLabel(copyBtn, 'コピーできません');
    }
  }

  copyBtn.addEventListener('click', copyValue);
  closeBtn.addEventListener('click', () => dialog.close());

  // Esc でもボタンでも、閉じたらスキャンを再開する。
  // 同じバーコードが枠内に残っていれば、そのまますぐ読み直す
  dialog.addEventListener('close', () => {
    clearTimeout(labelTimerId);
    copyBtn.textContent = copyBtn.dataset.label || copyBtn.textContent;

    restartLoop();
  });

  // --- 検出画像のプレビュー（動作確認用）---------------------------------

  // 解析に渡しているのと同じ画像を、そのままダイアログに出す。
  // 枠のズレや余白の付き方、縮小後にバーが潰れていないかをその場で確認する
  function showPreview() {
    // 解析中はバッファを書き換えない（＝いま解析に渡している画像がそのまま出る）
    copyPreviewFrame();

    // 回転経路は 1 フレームおきなので、見比べやすいよう常に正立で切り出す
    const source = captureScanArea(false);
    if (!source) {
      setLabel(previewBtn, '取得できません');
      return;
    }

    const pad = needsQuietZone() ? SCAN_PAD_X : 0;
    previewInfo.textContent = pad
      ? `${source.width} × ${source.height}（うち左右 ${pad}px は白の余白）`
      : `${source.width} × ${source.height}`;
    // 解析に渡すのと同じ画素をそのまま見たいので、非可逆な形式にはしない
    previewImage.src = source.toDataURL('image/png');

    // <dialog> 非対応ブラウザでも最低限は表示されるようにしておく
    if (typeof previewDialog.showModal === 'function') previewDialog.showModal();
    else previewDialog.setAttribute('open', '');
  }

  previewBtn.addEventListener('click', showPreview);
  previewCloseBtn.addEventListener('click', () => previewDialog.close());

  previewDialog.addEventListener('close', () => {
    // data URL を抱えたままにしない
    previewImage.removeAttribute('src');

    restartLoop();
  });

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
    const formats = FORMATS.map((format) => format.native).filter((name) =>
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

    // 他の js と同じ理由でキャッシュ対策を付ける（AGENTS.md の読み込み順を参照）
    const worker = new Worker(`${ZXING_WORKER_SRC}?v=${Date.now()}`);
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
        reject(new Error(`Worker の初期化がタイムアウトしました: ${ZXING_WORKER_SRC}`));
      }, spec.timeout);

      // 初期化前なら初期化の失敗として、初期化後なら解析中の失敗として伝える
      // （解決済みの Promise への reject は無視される）
      function fail(err) {
        clearTimeout(timer);
        reject(err);

        if (pending) {
          pending.reject(err);
          pending = null;
        }
      }

      worker.onerror = (event) => {
        fail(new Error(event.message || `Worker を読み込めませんでした: ${ZXING_WORKER_SRC}`));
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
          fail(new Error(message.message));
          return;
        }

        // stop() などをまたいだ古い応答は捨てる
        if (!pending || pending.id !== message.id) return;

        const current = pending;
        pending = null;

        if (message.error) current.reject(new Error(message.error));
        else current.resolve(message.result);
      };

      worker.postMessage({ type: 'init', formats: FORMATS, ...spec.init });
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
        src: new URL(ZXING_SRC, location.href).href
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
        src: new URL(ZXING_CPP_SRC, location.href).href,
        wasm: new URL(ZXING_CPP_WASM, location.href).href,
        options: ZXING_CPP_OPTIONS
      }
    });
  }

  // Worker を使えない環境向けの経路。解析のあいだメインスレッドが止まる
  async function createZXingMainDetector() {
    await loadScript(ZXING_SRC);

    const ZXing = window.ZXing;
    if (!ZXing) throw new Error('ZXing の初期化に失敗しました。');

    // POSSIBLE_FORMATS を渡さないと、MultiFormatReader は 1D 系・QR・DataMatrix・
    // Aztec・PDF417 のリーダーをすべて用意し、しかも未検出のフレームでは
    // 毎回その全部を走らせる（未検出が大半なので、これが 1 回の解析の主な中身になる）。
    // CODE39 だけに絞ると Code39Reader 1 本で済む。
    //
    // TRY_HARDER は付けない。全フォーマット有効だと 1 回の解析が 10 倍（約 31ms -> 311ms）になり、
    // 実効スキャン数が 3 回/秒まで落ちてしまう。TRY_HARDER の主な利点である
    // 縦向きバーコードの走査は、こちらでフレームごとに 90 度回転させて代替する。
    // （フォーマットを絞った今なら TRY_HARDER でも間に合うかもしれないが、
    //   入れるなら #engine の N/s で実測してから）
    const hints = new Map();
    hints.set(
      ZXing.DecodeHintType.POSSIBLE_FORMATS,
      FORMATS.map((format) => ZXing.BarcodeFormat[format.zxing])
    );

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
    const known = FORMATS.find(
      (format) => format.zxingCpp.toLowerCase() === name.toLowerCase()
    );
    return known ? known.zxing : name.toUpperCase();
  }

  // Worker を使えない環境向けの ZXing-C++ 経路。解析のあいだメインスレッドが止まる
  async function createZXingCppMainDetector() {
    await loadScript(ZXING_CPP_SRC);

    const ZXingWASM = window.ZXingWASM;
    if (!ZXingWASM) throw new Error('ZXing-C++ の初期化に失敗しました。');

    const options = {
      ...ZXING_CPP_OPTIONS,
      formats: FORMATS.map((format) => format.zxingCpp)
    };

    // fireImmediately で、wasm の取得とコンパイルまでここで終わらせる
    // （待たずに返すと、最初の数フレームの解析がまとめて待たされる）
    await withTimeout(
      ZXingWASM.prepareZXingModule({
        overrides: ZXING_CPP_OVERRIDES,
        fireImmediately: true
      }),
      WASM_INIT_TIMEOUT_MS,
      `wasm の読み込みがタイムアウトしました: ${ZXING_CPP_WASM}`
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

  // Quagga2 の経路。自動では選ばれず、「エンジン」ボタンで選んだときだけ使う。
  //
  // 公開 API の decodeSingle は画像を URL でしか受け取れないので、切り出した canvas を
  // 毎フレーム data URL にしてから渡している（ZXing のように ImageData を直接渡す口が
  // 無く、PNG のエンコードとデコードが 1 フレームぶん余計に乗る）。
  // 同梱の UMD は読み込み時に window を直接参照するので Worker にも移せず、
  // 解析のあいだメインスレッドが止まる。読み比べ用の経路と割り切って、
  // この重さはそのままにしてある（実際に何回回っているかは #engine の N/s を見る）
  async function createQuaggaDetector() {
    await loadScript(QUAGGA_SRC);

    const Quagga = window.Quagga;
    if (!Quagga) throw new Error('Quagga2 の初期化に失敗しました。');

    const readers = FORMATS.map((format) => format.quagga);

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
    setEngine('ZXing 読み込み中…');

    return createZXingWorkerDetector().catch((err) => {
      // Worker が駄目でも読み取り自体は続けられるようにする。
      // どちらで動いているかは #engine のバッジで分かる
      console.warn('ZXing を Worker で動かせないため、メインスレッドで実行します', err);
      return createZXingMainDetector();
    });
  }

  // ZXing-C++ の経路。ZXing と同じく、Worker を作れない環境ではメインスレッド実行に落ちる
  function useZXingCpp() {
    setEngine('ZXing-C++ 読み込み中…');

    return createZXingCppWorkerDetector().catch((err) => {
      console.warn('ZXing-C++ を Worker で動かせないため、メインスレッドで実行します', err);
      return createZXingCppMainDetector();
    });
  }

  // 「自動」。BarcodeDetector が使えなければ ZXing に落ちる（従来どおりの順序）
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
        setEngine('Quagga2 読み込み中…');
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
    setEngine(engine.name);
  }

  // --- スキャンループ ---------------------------------------------------

  // 画面上の検出枠を、映像の実ピクセル座標に変換する
  function measureScanArea() {
    const videoRect = video.getBoundingClientRect();
    const areaRect = scanArea.getBoundingClientRect();
    if (!videoRect.width || !videoRect.height || !areaRect.width) return null;

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

  function handleResult(result) {
    if (navigator.vibrate) navigator.vibrate(60);
    showResult(result);
  }

  // 予約済みの次回ぶんを取り消し、世代を進める。
  // 解析の途中（await 中）の tick は、完了時に世代のずれを見て自分で畳む
  function cancelLoop() {
    runToken += 1;
    clearTimeout(timerId);
    timerId = null;
  }

  // 停止・一時停止・ダイアログを閉じたあとにループを回し直す。
  // 走りっぱなしの tick があっても、世代が変わるので二重には回らない
  function restartLoop() {
    cancelLoop();
    if (active && !paused && !anyDialogOpen()) tick();
  }

  // BarcodeDetector は端末側のモジュール未取得などで例外を返すことがあり、
  // Worker も動き出したあとで落ちることがある。どちらも黙って止まらず、
  // ひとつ下の経路（ネイティブ -> ZXing、Worker -> メインスレッド）に切り替える。
  // メインスレッド実行の ZXing / ZXing-C++ と、明示的に選ばれた Quagga2 には
  // 落ちる先が無いので、そのまま投げ返して #engine にエラーを出す
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

  async function tick() {
    timerId = null;
    // 解析を待っている間にループが畳まれたかどうかを、あとで見分けるための世代番号
    const token = runToken;
    // ダイアログを開いている間は解析を止める
    if (!active || paused || anyDialogOpen()) return;

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
          if (active && !anyDialogOpen() && result) handleResult(result);
        } finally {
          // 解析が終わるまではコピーを止めておきたいので、必ずここで戻す
          pendingDetects -= 1;
        }
      }
    } catch (err) {
      console.error('バーコードの解析に失敗しました', err);
      setEngine('解析エラー（コンソール参照）');
    }

    // 解析を待っている間にループが畳まれて回し直されていたら、この呼び出しは
    // 古い世代なのでここで終わる。放っておくとループが二重に回り、
    // ZXing の Worker には解析要求が重なって届く
    if (token !== runToken) return;

    // 解析が遅れてもフレームが溜まらないよう、完了してから次を予約する
    if (active && !paused && !anyDialogOpen()) timerId = setTimeout(tick, SCAN_INTERVAL_MS);
  }

  async function start() {
    if (active) return;
    active = true;
    previewBtn.disabled = false;
    setEngine('準備中…');

    try {
      await applyEngine(getDetector());
    } catch (err) {
      active = false;
      previewBtn.disabled = true;
      detectorCache.delete(engineChoice); // 次回の起動で読み込みを再試行する
      stopRateMeter();
      setEngine('');
      console.error(err);
      showError(`バーコード読み取りを初期化できませんでした。\n${err.message}`);
      return;
    }

    if (!active) return; // 初期化中に停止された
    startRateMeter();
    tick();
  }

  // 撮影プレビューを開いている間など、カメラは動かしたまま解析だけ止める
  function pause() {
    paused = true;
    cancelLoop();
  }

  function resume() {
    paused = false;
    restartLoop();
  }

  function stop() {
    active = false;
    paused = false;
    cancelLoop();
    releasePreviewFrame();
    previewBtn.disabled = true;
    if (previewDialog.open) previewDialog.close();
    stopRateMeter();
    setEngine('');
  }

  window.BarcodeScanner = { start, stop, pause, resume };
})();
