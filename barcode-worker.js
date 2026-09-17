// ZXing の解析をメインスレッドから追い出すための Worker。
//
// ZXing は同期処理なので、メインスレッドで回すと 1 フレームあたり数 ms〜数十 ms
// 画面が固まる（プレビューやフラッシュのアニメーションがカクつく）。こちらに移すと
// メインスレッドの負担は drawImage と getImageData だけになる。
// ZXing-C++（wasm）も解析のあいだ呼び出したスレッドを止めるので、同じ理由でこちらに乗せる。
//
// init の engine で、zxing-js（'zxing'）と ZXing-C++ + wasm（'zxing-cpp'）を切り替える。
// barcode.js からしか使わない。Worker を作れない・ライブラリを読めない環境では、
// barcode.js 側がメインスレッド実行にフォールバックする。
'use strict';

// (message) => { text, format } | null （Promise でも可）。init が据える
let decode = null;

// --- ZXing（zxing-js）--------------------------------------------------

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

function initZXing(message) {
  // src は barcode.js が ZXING_SRC から作った絶対 URL。
  // vendor の版を変えるときは barcode.js の ZXING_SRC だけを直せばよい
  importScripts(message.src);

  const ZXing = self.ZXing;
  if (!ZXing) throw new Error('ZXing の初期化に失敗しました。');

  // フォーマットを絞る理由は barcode.js の FORMATS のコメントを参照
  const hints = new Map();
  hints.set(
    ZXing.DecodeHintType.POSSIBLE_FORMATS,
    message.formats.map((format) => ZXing.BarcodeFormat[format.zxing])
  );

  const reader = new ZXing.MultiFormatReader();
  reader.setHints(hints);

  decode = (request) => {
    const gray = toGrayscale(
      new Uint8ClampedArray(request.buffer),
      request.width,
      request.height
    );

    // RGBLuminanceSource は isRotateSupported() が false だが、
    // 回転が要るのは TRY_HARDER を付けたときだけなので今は影響しない。
    // TRY_HARDER を入れる場合はここも見直すこと
    const source = new ZXing.RGBLuminanceSource(gray, request.width, request.height);
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
  };
}

// --- ZXing-C++（wasm）-------------------------------------------------

// ZXing-C++ は 'Code39' という独自の表記で返してくるので、他のエンジンと同じ
// 大文字表記（CODE_39）に直す。対応は FORMATS が持っているのでそれを引く。
// メインスレッド経路（barcode.js）にも同じものがある
function zxingCppFormat(result, formats) {
  // symbology は変種（Code39Ext など）を束ねた親を返すので、あればそちらを見る
  const name = String(result.symbology || result.format || '');
  const known = formats.find(
    (format) => format.zxingCpp.toLowerCase() === name.toLowerCase()
  );
  return known ? known.zxing : name.toUpperCase();
}

async function initZXingCpp(message) {
  // この IIFE 版は window を参照しないので Worker でもそのまま動く（Quagga2 との違い）
  importScripts(message.src);

  const ZXingWASM = self.ZXingWASM;
  if (!ZXingWASM) throw new Error('ZXing-C++ の初期化に失敗しました。');

  const options = {
    ...message.options,
    formats: message.formats.map((format) => format.zxingCpp)
  };

  // 既定の locateFile は jsDelivr の URL を返す。同梱した wasm を指すように差し替える
  // （barcode.js が ZXING_CPP_WASM から作った絶対 URL）。
  // fireImmediately で、wasm の取得とコンパイルまでこの init のあいだに終わらせる。
  // ここを待たずに ready を返すと、最初の数フレームの解析がまとめて待たされる
  await ZXingWASM.prepareZXingModule({
    overrides: {
      locateFile: (path, prefix) => (path.endsWith('.wasm') ? message.wasm : prefix + path)
    },
    fireImmediately: true
  });

  decode = async (request) => {
    // readBarcodes は { data, width, height } を ImageData として受け取る。
    // RGBA から輝度への変換は係数も含めて ZXing 経路と同じものが中で走る
    const results = await ZXingWASM.readBarcodes(
      {
        data: new Uint8ClampedArray(request.buffer),
        width: request.width,
        height: request.height
      },
      options
    );

    if (!results.length) return null;
    return { text: results[0].text, format: zxingCppFormat(results[0], message.formats) };
  };
}

// --- 受け口 -----------------------------------------------------------

function init(message) {
  if (message.engine === 'zxing-cpp') return initZXingCpp(message);
  return initZXing(message);
}

function messageOf(err) {
  return (err && err.message) || String(err);
}

self.onmessage = async (event) => {
  const message = event.data;

  if (message.type === 'init') {
    try {
      await init(message);
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', message: messageOf(err) });
    }
    return;
  }

  // 解析要求。id はメインスレッド側で古い応答を捨てるために返す
  try {
    self.postMessage({ type: 'result', id: message.id, result: await decode(message) });
  } catch (err) {
    self.postMessage({ type: 'result', id: message.id, error: messageOf(err) });
  }
};
