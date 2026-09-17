(() => {
  'use strict';

  // 検出は BarcodeDetector（Chrome / Android 等）を優先し、
  // 非対応のブラウザ（iOS Safari / Firefox）だけ ZXing を CDN から読み込む
  const ZXING_SRC = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';

  const SCAN_INTERVAL_MS = 120;      // 1 秒あたり約 8 回スキャンする
  const DUPLICATE_WINDOW_MS = 2000;  // 同じ値を続けて読み直さない猶予
  const COPY_LABEL_RESET_MS = 1500;

  const video = document.getElementById('video');
  const scanArea = document.getElementById('scanArea');

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

  let detect = null;      // (canvas) => { text, format } | null （Promise でも可）
  let detectorPromise = null;
  let active = false;     // カメラ稼働中か（camera.js が制御する）
  let timerId = null;
  let copyTimerId = null;
  let lastText = '';
  let lastAt = 0;

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

  // Esc でもボタンでも、閉じたらスキャンを再開する
  dialog.addEventListener('close', () => {
    clearTimeout(copyTimerId);
    copyBtn.textContent = 'コピー';

    // 同じバーコードが写ったままでもすぐには開き直さないよう、
    // 重複判定の起点を閉じた時刻にずらす
    lastAt = Date.now();
    if (active && timerId === null) tick();
  });

  // --- 検出エンジン -----------------------------------------------------

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.crossOrigin = 'anonymous';
      script.onload = resolve;
      script.onerror = () => reject(new Error(`スクリプトの読み込みに失敗しました: ${src}`));
      document.head.appendChild(script);
    });
  }

  // BarcodeDetector が対応しているフォーマットをすべて有効にする
  async function createNativeDetector() {
    if (!('BarcodeDetector' in window)) return null;

    const formats = (await window.BarcodeDetector.getSupportedFormats()).filter(
      (format) => format !== 'unknown'
    );
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
    // 1D 系・QR・DataMatrix・Aztec・PDF417 のリーダーをすべて使う
    const hints = new Map();
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);

    // setHints はリーダーを作り直すので、毎フレームではなく最初に一度だけ渡す
    const reader = new ZXing.MultiFormatReader();
    reader.setHints(hints);

    return (source) => {
      // 第 2 引数を true にすると、フレームごとに白黒反転した画像も試してくれる
      const luminance = new ZXing.HTMLCanvasElementLuminanceSource(source, true);
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

  function getDetector() {
    if (!detectorPromise) {
      detectorPromise = createNativeDetector()
        .catch((err) => {
          console.warn('BarcodeDetector を利用できません', err);
          return null;
        })
        .then((native) => native || createZXingDetector());
    }
    return detectorPromise;
  }

  // --- スキャンループ ---------------------------------------------------

  // 画面上の検出枠を、映像の実ピクセル座標に変換して切り出す
  function captureScanArea() {
    if (!video.videoWidth || !video.videoHeight) return null;

    const videoRect = video.getBoundingClientRect();
    const areaRect = scanArea.getBoundingClientRect();
    if (!videoRect.width || !videoRect.height) return null;

    const scaleX = video.videoWidth / videoRect.width;
    const scaleY = video.videoHeight / videoRect.height;

    // フロントカメラは CSS で左右反転しているだけなので、
    // 中央基準の枠の座標は反転の有無に関わらず同じになる
    const sx = Math.max(0, Math.round((areaRect.left - videoRect.left) * scaleX));
    const sy = Math.max(0, Math.round((areaRect.top - videoRect.top) * scaleY));
    const sw = Math.min(video.videoWidth - sx, Math.round(areaRect.width * scaleX));
    const sh = Math.min(video.videoHeight - sy, Math.round(areaRect.height * scaleY));
    if (sw <= 0 || sh <= 0) return null;

    if (canvas.width !== sw || canvas.height !== sh) {
      canvas.width = sw;
      canvas.height = sh;
    }

    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
    return canvas;
  }

  function handleResult(result) {
    const now = Date.now();

    // 同じバーコードを映し続けている間は繰り返し開かない
    if (result.text === lastText && now - lastAt < DUPLICATE_WINDOW_MS) {
      lastAt = now;
      return;
    }

    lastText = result.text;
    lastAt = now;

    if (navigator.vibrate) navigator.vibrate(60);
    showResult(result);
  }

  async function tick() {
    timerId = null;
    // ダイアログを開いている間は解析を止める
    if (!active || dialog.open) return;

    try {
      const source = captureScanArea();
      if (source) {
        const result = await detect(source);
        if (active && !dialog.open && result) handleResult(result);
      }
    } catch (err) {
      console.error('バーコードの解析に失敗しました', err);
    }

    // 解析が遅れてもフレームが溜まらないよう、完了してから次を予約する
    if (active && !dialog.open) timerId = setTimeout(tick, SCAN_INTERVAL_MS);
  }

  async function start() {
    if (active) return;
    active = true;

    try {
      detect = await getDetector();
    } catch (err) {
      active = false;
      detectorPromise = null; // 次回の起動で読み込みを再試行する
      console.error(err);
      showError('バーコード読み取りを初期化できませんでした。通信環境を確認してください。');
      return;
    }

    if (!active) return; // 初期化中に停止された
    lastText = '';
    tick();
  }

  function stop() {
    active = false;
    clearTimeout(timerId);
    timerId = null;
  }

  window.BarcodeScanner = { start, stop };
})();
