// ZXing の解析をメインスレッドから追い出すための Worker。
//
// ZXing は同期処理なので、メインスレッドで回すと 1 フレームあたり数 ms〜数十 ms
// 画面が固まる（プレビューやフラッシュのアニメーションがカクつく）。こちらに移すと
// メインスレッドの負担は drawImage と getImageData だけになる。
//
// barcode.js からしか使わない。Worker を作れない・ZXing を読めない環境では、
// barcode.js 側がメインスレッド実行にフォールバックする。
'use strict';

let ZXing = null;
let reader = null;

function init(message) {
  // src は barcode.js が ZXING_SRC から作った絶対 URL。
  // vendor の版を変えるときは barcode.js の ZXING_SRC だけを直せばよい
  importScripts(message.src);

  ZXing = self.ZXing;
  if (!ZXing) throw new Error('ZXing の初期化に失敗しました。');

  // フォーマットを絞る理由は barcode.js の FORMATS のコメントを参照
  const hints = new Map();
  hints.set(
    ZXing.DecodeHintType.POSSIBLE_FORMATS,
    message.formats.map((name) => ZXing.BarcodeFormat[name])
  );

  reader = new ZXing.MultiFormatReader();
  reader.setHints(hints);
}

// RGBA から輝度へ。Worker には canvas が無いので
// HTMLCanvasElementLuminanceSource は使えず、同じ係数で自前に変換する
// （メインスレッド経路と同じ輝度値になるようにしてある）。
// 透明なピクセルを白として扱うところも本家と同じ
function toGrayscale(rgba, width, height) {
  const gray = new Uint8ClampedArray(width * height);

  for (let i = 0, j = 0; j < gray.length; i += 4, j++) {
    gray[j] =
      rgba[i + 3] === 0
        ? 255
        : (306 * rgba[i] + 601 * rgba[i + 1] + 117 * rgba[i + 2] + 512) >> 10;
  }

  return gray;
}

function decode(message) {
  const gray = toGrayscale(
    new Uint8ClampedArray(message.buffer),
    message.width,
    message.height
  );

  // RGBLuminanceSource は isRotateSupported() が false だが、
  // 回転が要るのは TRY_HARDER を付けたときだけなので今は影響しない。
  // TRY_HARDER を入れる場合はここも見直すこと
  const source = new ZXing.RGBLuminanceSource(gray, message.width, message.height);
  const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(source));

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

function messageOf(err) {
  return (err && err.message) || String(err);
}

self.onmessage = (event) => {
  const message = event.data;

  if (message.type === 'init') {
    try {
      init(message);
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', message: messageOf(err) });
    }
    return;
  }

  // 解析要求。id はメインスレッド側で古い応答を捨てるために返す
  try {
    self.postMessage({ type: 'result', id: message.id, result: decode(message) });
  } catch (err) {
    self.postMessage({ type: 'result', id: message.id, error: messageOf(err) });
  }
};
