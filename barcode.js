(() => {
  'use strict';

  // 検出は BarcodeDetector（Chrome / Android 等）を優先し、
  // 非対応のブラウザ（iOS Safari / Firefox / デスクトップ Chrome）では同梱の ZXing を使う。
  // 初回に必要になったときだけ読み込む（約 330KB）
  const ZXING_SRC = 'vendor/zxing-0.21.3.min.js';
  const ZXING_TIMEOUT_MS = 10000;

  const SCAN_INTERVAL_MS = 120;      // 1 秒あたり約 8 回スキャンする
  const COPY_LABEL_RESET_MS = 1500;

  // 解析に回す画像の最大辺。1080p の枠内をそのまま渡すと 1 回の解析が重く、
  // 実質のスキャン回数が落ちるため縮小する（バーの太さは十分残る）
  const MAX_SCAN_SIDE = 900;

  const video = document.getElementById('video');
  const scanArea = document.getElementById('scanArea');
  const engineLabel = document.getElementById('engine');

  const dialog = document.getElementById('result');
  const dialogTitle = document.getElementById('resultTitle');
  const dialogFormat = document.getElementById('resultFormat');
  const dialogValue = document.getElementById('resultValue');
  const copyBtn = document.getElementById('resultCopyBtn');
  const closeBtn = document.getElementById('resultCloseBtn');

  // 検出領域だけを切り出すための作業用キャンバス。
  // ZXing は getImageData を多用するので willReadFrequently を立てておく
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  let detect = null;         // (canvas) => { text, format } | null （Promise でも可）
  let detectorPromise = null;
  let usingNative = false;   // BarcodeDetector で動いているか
  let active = false;        // カメラ稼働中か（camera.js が制御する）
  let timerId = null;
  let copyTimerId = null;
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

  // --- 結果ダイアログ ---------------------------------------------------

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
      copyBtn.textContent = 'コピーしました';
    } catch (err) {
      console.warn('クリップボードへのコピーに失敗しました', err);
      copyBtn.textContent = 'コピーできません';
    }

    clearTimeout(copyTimerId);
    copyTimerId = setTimeout(() => {
      copyBtn.textContent = 'コピー';
    }, COPY_LABEL_RESET_MS);
  }

  copyBtn.addEventListener('click', copyValue);
  closeBtn.addEventListener('click', () => dialog.close());

  // Esc でもボタンでも、閉じたらスキャンを再開する。
  // 同じバーコードが枠内に残っていれば、そのまますぐ読み直す
  dialog.addEventListener('close', () => {
    clearTimeout(copyTimerId);
    copyBtn.textContent = 'コピー';

    if (active && timerId === null) tick();
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

  // BarcodeDetector が対応しているフォーマットをすべて有効にする
  async function createNativeDetector() {
    if (!('BarcodeDetector' in window)) return null;

    const formats = (await window.BarcodeDetector.getSupportedFormats()).filter(
      (format) => format !== 'unknown'
    );
    // API はあってもプラットフォーム側が未対応だと空配列が返る
    if (!formats.length) return null;

    const detector = new window.BarcodeDetector({ formats });

    return async (source) => {
      const results = await detector.detect(source);
      if (!results.length) return null;

      // ZXing 側と表記を揃える（code_39 -> CODE_39）
      return { text: results[0].rawValue, format: String(results[0].format).toUpperCase() };
    };
  }

  async function createZXingDetector() {
    await loadScript(ZXING_SRC);

    const ZXing = window.ZXing;
    if (!ZXing) throw new Error('ZXing の初期化に失敗しました。');

    // POSSIBLE_FORMATS を渡さないと、MultiFormatReader は
    // 1D 系・QR・DataMatrix・Aztec・PDF417 のリーダーをすべて使う。
    //
    // TRY_HARDER は付けない。全フォーマット有効だと 1 回の解析が 10 倍（約 31ms -> 311ms）になり、
    // 実効スキャン数が 3 回/秒まで落ちてしまう。TRY_HARDER の主な利点である
    // 縦向きバーコードの走査は、こちらでフレームごとに 90 度回転させて代替する
    const reader = new ZXing.MultiFormatReader();
    reader.setHints(new Map());

    return (source) => {
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
    };
  }

  function useZXing() {
    setEngine('ZXing 読み込み中…');
    usingNative = false;

    detectorPromise = createZXingDetector().then((fn) => {
      setEngine('ZXing');
      return fn;
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
        setEngine('BarcodeDetector');
        return native;
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

    const cw = rotate ? dh : dw;
    const chh = rotate ? dw : dh;
    if (canvas.width !== cw || canvas.height !== chh) {
      canvas.width = cw;
      canvas.height = chh;
    }

    ctx.save();
    if (rotate) {
      ctx.translate(cw, 0);
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

  // BarcodeDetector は端末側のモジュール未取得などで例外を返すことがある。
  // その場合は黙って止まらず ZXing に切り替える
  async function runDetect(source) {
    try {
      return await detect(source);
    } catch (err) {
      if (!usingNative) throw err;

      console.warn('BarcodeDetector が失敗したため ZXing に切り替えます', err);
      detect = await useZXing();
      return null;
    }
  }

  async function tick() {
    timerId = null;
    // ダイアログを開いている間は解析を止める
    if (!active || dialog.open) return;

    try {
      // ZXing 経路だけ、縦向きバーコード用に 1 フレームおきで 90 度回転させる。
      // BarcodeDetector は向きを自前で処理するので常に正立のまま渡す
      rotateNext = !usingNative && !rotateNext;

      const source = captureScanArea(rotateNext);
      if (source) {
        scanCount += 1;
        const result = await runDetect(source);
        if (active && !dialog.open && result) handleResult(result);
      }
    } catch (err) {
      console.error('バーコードの解析に失敗しました', err);
      setEngine('解析エラー（コンソール参照）');
    }

    // 解析が遅れてもフレームが溜まらないよう、完了してから次を予約する
    if (active && !dialog.open) timerId = setTimeout(tick, SCAN_INTERVAL_MS);
  }

  async function start() {
    if (active) return;
    active = true;
    setEngine('準備中…');

    try {
      detect = await getDetector();
    } catch (err) {
      active = false;
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

  function stop() {
    active = false;
    clearTimeout(timerId);
    timerId = null;
    stopRateMeter();
    setEngine('');
  }

  window.BarcodeScanner = { start, stop };
})();
