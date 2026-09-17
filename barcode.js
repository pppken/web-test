(() => {
  'use strict';

  // 検出は BarcodeDetector（Chrome / Android 等）を優先し、
  // 非対応のブラウザ（iOS Safari / Firefox）だけ ZXing を CDN から読み込む
  const ZXING_SRC = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';

  const SCAN_INTERVAL_MS = 120;      // 1 秒あたり約 8 回スキャンする
  const DUPLICATE_WINDOW_MS = 2000;  // 同じ値を連続で通知しない猶予
  const TOAST_DURATION_MS = 2600;

  const video = document.getElementById('video');
  const scanArea = document.getElementById('scanArea');
  const toast = document.getElementById('toast');

  // 検出領域だけを切り出すための作業用キャンバス。
  // ZXing は getImageData を多用するので willReadFrequently を立てておく
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  let detect = null;      // (canvas) => Promise<string|null> | string|null
  let detectorPromise = null;
  let running = false;
  let timerId = null;
  let toastTimerId = null;
  let lastText = '';
  let lastAt = 0;

  function showToast(message, isError = false) {
    toast.textContent = message;
    toast.classList.toggle('error', isError);
    toast.classList.add('show');

    clearTimeout(toastTimerId);
    toastTimerId = setTimeout(() => toast.classList.remove('show'), TOAST_DURATION_MS);
  }

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

  // BarcodeDetector が CODE39 に対応していればそれを使う
  async function createNativeDetector() {
    if (!('BarcodeDetector' in window)) return null;

    const formats = await window.BarcodeDetector.getSupportedFormats();
    if (!formats.includes('code_39')) return null;

    const detector = new window.BarcodeDetector({ formats: ['code_39'] });

    return async (source) => {
      const results = await detector.detect(source);
      return results.length ? results[0].rawValue : null;
    };
  }

  async function createZXingDetector() {
    await loadScript(ZXING_SRC);

    const ZXing = window.ZXing;
    if (!ZXing) throw new Error('ZXing の初期化に失敗しました。');

    const hints = new Map();
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.CODE_39]);
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);

    // setHints はリーダーを作り直すので、毎フレームではなく最初に一度だけ渡す
    const reader = new ZXing.MultiFormatReader();
    reader.setHints(hints);

    return (source) => {
      // 第 2 引数を true にすると、フレームごとに白黒反転した画像も試してくれる
      const luminance = new ZXing.HTMLCanvasElementLuminanceSource(source, true);
      const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(luminance));

      try {
        return reader.decodeWithState(bitmap).getText();
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

  function handleResult(text) {
    const now = Date.now();

    // 同じバーコードを映し続けている間は通知を繰り返さない
    if (text === lastText && now - lastAt < DUPLICATE_WINDOW_MS) {
      lastAt = now;
      return;
    }

    lastText = text;
    lastAt = now;

    showToast(text);
    if (navigator.vibrate) navigator.vibrate(60);
  }

  async function tick() {
    timerId = null;
    if (!running) return;

    try {
      const source = captureScanArea();
      if (source) {
        const text = await detect(source);
        if (running && text) handleResult(text);
      }
    } catch (err) {
      console.error('バーコードの解析に失敗しました', err);
    }

    // 解析が遅れてもフレームが溜まらないよう、完了してから次を予約する
    if (running) timerId = setTimeout(tick, SCAN_INTERVAL_MS);
  }

  async function start() {
    if (running) return;
    running = true;

    try {
      detect = await getDetector();
    } catch (err) {
      running = false;
      detectorPromise = null; // 次回の起動で読み込みを再試行する
      console.error(err);
      showToast('バーコード読み取りを初期化できませんでした。', true);
      return;
    }

    if (!running) return; // 初期化中に停止された
    lastText = '';
    tick();
  }

  function stop() {
    running = false;
    clearTimeout(timerId);
    timerId = null;
  }

  window.BarcodeScanner = { start, stop };
})();
