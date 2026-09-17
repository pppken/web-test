(() => {
  'use strict';

  // 検出は BarcodeDetector（Chrome / Android 等）を優先し、
  // 非対応のブラウザ（iOS Safari / Firefox / デスクトップ Chrome）では同梱の ZXing を使う。
  // 初回に必要になったときだけ読み込む（約 330KB）
  const ZXING_SRC = 'vendor/zxing-0.21.3.min.js';
  const ZXING_TIMEOUT_MS = 10000;

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

  // ZXing に渡す画像の左右に足す白い余白の幅（px）。
  // 検出枠いっぱいにバーコードが写っていると、CODE39 の開始/終了記号の外側に
  // 必要な静止領域（クワイエットゾーン）まで切り落とされて読めないことがあるので、
  // 切り出した画像の左右を白で埋めて補う。
  // 回転経路でもバーが並ぶ向きは canvas の横方向なので、足す位置は同じ
  const SCAN_PAD_X = 50;

  // 読み取る対象のフォーマット。現状は CODE39 のみ。
  // BarcodeDetector と ZXing で表記が違うので両方を持つ。大半は大文字小文字の
  // 差でしかないが、PDF417 だけ 'pdf417' / 'PDF_417' と規則が揃わないため
  // 機械的な変換はせず、増やすときは 2 つとも書くこと
  const FORMATS = [
    { native: 'code_39', zxing: 'CODE_39' }
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

  let detect = null;         // (canvas) => { text, format } | null （Promise でも可）
  let detectorPromise = null;
  let usingNative = false;   // BarcodeDetector で動いているか
  let usingWorker = false;   // ZXing を Worker で動かしているか
  let active = false;        // カメラ稼働中か（camera.js が制御する）
  let paused = false;        // 撮影中など、一時的に解析を止めているか
  let timerId = null;
  let labelTimerId = null;
  let rotateNext = false;

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

    if (active && !paused && timerId === null) tick();
  });

  // --- 検出画像のプレビュー（動作確認用）---------------------------------

  // 解析に渡しているのと同じ画像を、そのままダイアログに出す。
  // 枠のズレや余白の付き方、縮小後にバーが潰れていないかをその場で確認する
  function showPreview() {
    // 回転経路は 1 フレームおきなので、見比べやすいよう常に正立で切り出す
    const source = captureScanArea(false);
    if (!source) {
      setLabel(previewBtn, '取得できません');
      return;
    }

    const pad = usingNative ? 0 : SCAN_PAD_X;
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

    if (active && !paused && timerId === null) tick();
  });

  // --- 検出エンジン -----------------------------------------------------

  // 読み込みが返らないまま固まるのを避けるため、必ずタイムアウトさせる
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');

      const timer = setTimeout(() => {
        script.remove();
        reject(new Error(`スクリプトの読み込みがタイムアウトしました: ${src}`));
      }, ZXING_TIMEOUT_MS);

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
      name: 'BarcodeDetector',
      detect: async (source) => {
        const results = await detector.detect(source);
        if (!results.length) return null;

        // ZXing 側と表記を揃える（code_39 -> CODE_39）
        return { text: results[0].rawValue, format: String(results[0].format).toUpperCase() };
      }
    };
  }

  // ZXing の解析を Worker に投げる経路。メインスレッドに残るのは drawImage と
  // getImageData だけになるので、解析中もプレビューや UI が固まらない
  function createZXingWorkerDetector() {
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
      }, ZXING_TIMEOUT_MS);

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
          resolve({ name: 'ZXing (Worker)', detect });
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

      worker.postMessage({
        type: 'init',
        // Worker 内は相対パスの基準が変わるので、絶対 URL にしてから渡す
        src: new URL(ZXING_SRC, location.href).href,
        formats: FORMATS.map((format) => format.zxing)
      });
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

  // メインスレッドで ZXing を動かす経路。Worker を作れない環境と、
  // 動き出した Worker が途中で落ちた場合の受け皿
  function useZXingMain() {
    usingNative = false;
    usingWorker = false;

    return createZXingMainDetector().then((engine) => {
      setEngine(engine.name);
      return engine.detect;
    });
  }

  function useZXing() {
    setEngine('ZXing 読み込み中…');
    usingNative = false;
    usingWorker = true;

    detectorPromise = createZXingWorkerDetector()
      .then((engine) => {
        setEngine(engine.name);
        return engine.detect;
      })
      .catch((err) => {
        // Worker が駄目でも読み取り自体は続けられるようにする。
        // どちらで動いているかは #engine のバッジで分かる
        console.warn('ZXing を Worker で動かせないため、メインスレッドで実行します', err);
        return useZXingMain();
      });

    return detectorPromise;
  }

  function getDetector() {
    if (detectorPromise) return detectorPromise;

    detectorPromise = createNativeDetector()
      .catch((err) => {
        console.warn('BarcodeDetector を利用できません', err);
        return null;
      })
      .then((native) => {
        if (!native) return useZXing();

        usingNative = true;
        setEngine(native.name);
        return native.detect;
      });

    return detectorPromise;
  }

  // --- スキャンループ ---------------------------------------------------

  // 画面上の検出枠を、映像の実ピクセル座標に変換して切り出す。
  // rotate=true なら 90 度回転して描画する（縦向きバーコード用）
  function captureScanArea(rotate) {
    if (!video.videoWidth || !video.videoHeight) return null;

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

    // 大きすぎる場合は縮小して描画する
    const ratio = Math.min(1, MAX_SCAN_SIDE / Math.max(sw, sh));
    const dw = Math.max(1, Math.round(sw * ratio));
    const dh = Math.max(1, Math.round(sh * ratio));

    const { canvas, ctx } = scanCanvases[rotate ? 1 : 0];

    // 余白を足すのは ZXing 経路だけ。BarcodeDetector は向きも含めて端末側の実装に
    // 任せるので、余分な画素を渡して 1 回の検出を重くしない
    const pad = usingNative ? 0 : SCAN_PAD_X;

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
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh);
    ctx.restore();

    return canvas;
  }

  function handleResult(result) {
    if (navigator.vibrate) navigator.vibrate(60);
    showResult(result);
  }

  // BarcodeDetector は端末側のモジュール未取得などで例外を返すことがあり、
  // Worker も動き出したあとで落ちることがある。どちらも黙って止まらず、
  // ひとつ下の経路（ネイティブ -> ZXing、Worker -> メインスレッド）に切り替える
  async function runDetect(source) {
    try {
      return await detect(source);
    } catch (err) {
      if (usingNative) {
        console.warn('BarcodeDetector が失敗したため ZXing に切り替えます', err);
        detect = await useZXing();
        return null;
      }

      if (usingWorker) {
        console.warn('Worker での解析が失敗したため、メインスレッドに切り替えます', err);
        detectorPromise = useZXingMain();
        detect = await detectorPromise;
        return null;
      }

      throw err;
    }
  }

  async function tick() {
    timerId = null;
    // ダイアログを開いている間は解析を止める
    if (!active || paused || anyDialogOpen()) return;

    try {
      // ZXing 経路だけ、縦向きバーコード用に 1 フレームおきで 90 度回転させる。
      // BarcodeDetector は向きを自前で処理するので常に正立のまま渡す
      rotateNext = !usingNative && !rotateNext;

      const source = captureScanArea(rotateNext);
      if (source) {
        scanCount += 1;
        const result = await runDetect(source);
        if (active && !anyDialogOpen() && result) handleResult(result);
      }
    } catch (err) {
      console.error('バーコードの解析に失敗しました', err);
      setEngine('解析エラー（コンソール参照）');
    }

    // 解析が遅れてもフレームが溜まらないよう、完了してから次を予約する
    if (active && !paused && !anyDialogOpen()) timerId = setTimeout(tick, SCAN_INTERVAL_MS);
  }

  async function start() {
    if (active) return;
    active = true;
    previewBtn.disabled = false;
    setEngine('準備中…');

    try {
      detect = await getDetector();
    } catch (err) {
      active = false;
      previewBtn.disabled = true;
      detectorPromise = null; // 次回の起動で読み込みを再試行する
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
    clearTimeout(timerId);
    timerId = null;
  }

  function resume() {
    paused = false;
    if (active && !anyDialogOpen() && timerId === null) tick();
  }

  function stop() {
    active = false;
    paused = false;
    clearTimeout(timerId);
    timerId = null;
    previewBtn.disabled = true;
    if (previewDialog.open) previewDialog.close();
    stopRateMeter();
    setEngine('');
  }

  window.BarcodeScanner = { start, stop, pause, resume };
})();
