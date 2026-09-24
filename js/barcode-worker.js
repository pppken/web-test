// バーコードの検出処理そのもの。barcode.js が切り出した画像を受け取り、選ばれた
// エンジンで解析して結果を返す。エンジンは 3 つ。
//   'native'     BarcodeDetector（Chrome / Android 等。Worker からも使える）
//   'zxing'      同梱の zxing-js
//   'zxing-cpp'  同梱の ZXing-C++（wasm）
// Quagga2 だけは Worker で動かないので barcode-quagga2.js に分けてある。
//
// **このファイルは 2 通りに読み込まれる。**
//   1. Worker として（既定）。どのエンジンも解析のあいだ呼び出したスレッドを止めるので、
//      メインスレッドから追い出す。メインスレッドに残るのは切り出しと転送だけになる。
//   2. <script> として（Worker を作れない・動き出した Worker が落ちたとき）。
//      window.BarcodeWorkerCore を生やすだけで、検出コードは 1 と同じものを通る。
// どちらも barcode.js からしか使わない。
//
// やり取りは 1 エンジンにつき 1 つの decoder で、どちらの読み込み方でも同じ形:
//   init   { engine, formats, src?, wasm?, options? }
//   解析   { width, height, buffer }（zxing / zxing-cpp。RGBA）
//          { bitmap }（native。ImageBitmap。使い終わったらこちらで close する）
//   結果   { text, format } | null
(() => {
  'use strict';

  const IS_WORKER =
    typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;

  // --- BarcodeDetector --------------------------------------------------

  async function createNative(message) {
    const Detector = self.BarcodeDetector;
    if (typeof Detector !== 'function') {
      throw new Error('BarcodeDetector に対応していません。');
    }

    // API はあってもプラットフォーム側が未対応だと空配列が返る。
    // 読みたいフォーマットが 1 つも無い場合も同じく使えないものとして扱う
    // （barcode.js が ZXing に落とす）。
    // 無関係なフォーマットを渡さないぶん、1 回の検出も軽くなる
    const supported = await Detector.getSupportedFormats();
    const formats = message.formats
      .map((format) => format.native)
      .filter((name) => supported.includes(name));
    if (!formats.length) throw new Error('BarcodeDetector が対象のフォーマットに対応していません。');

    const detector = new Detector({ formats });

    return async (request) => {
      try {
        const results = await detector.detect(request.bitmap);
        if (!results.length) return null;

        // 他のエンジンと表記を揃える（code_128 -> CODE_128）
        return { text: results[0].rawValue, format: String(results[0].format).toUpperCase() };
      } finally {
        request.bitmap.close();
      }
    };
  }

  // --- ZXing（zxing-js）--------------------------------------------------

  // RGBA から輝度へ。canvas を持たない（Worker には無い）ので
  // HTMLCanvasElementLuminanceSource は使わず、同じ係数で自前に変換する
  // （本家と 1 バイトも違わないことを確認済み）。透明なピクセルを白として扱うところも同じ
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

  async function createZXing(message, load) {
    // src は barcode.js が ZXING_SRC から作った絶対 URL。
    // vendor の版を変えるときは barcode.js の ZXING_SRC だけを直せばよい
    if (!self.ZXing) await load(message.src);

    const ZXing = self.ZXing;
    if (!ZXing) throw new Error('ZXing の初期化に失敗しました。');

    // POSSIBLE_FORMATS を渡さないと、MultiFormatReader は 1D 系・QR・DataMatrix・
    // Aztec・PDF417 のリーダーをすべて用意し、しかも未検出のフレームでは
    // 毎回その全部を走らせる（未検出が大半なので、これが 1 回の解析の主な中身になる）。
    // CODE128 と JAN と CODE39 に絞ると Code128Reader と MultiFormatUPCEANReader
    // （EAN13Reader / EAN8Reader を束ねたもの）と Code39Reader の 3 本で済む。
    //
    // TRY_HARDER を付けると、doDecode が高さ方向に見る行が 15 行から画像の高さぶん
    // 全部に増える（行ステップも h>>5 から h>>8 になる）。
    // 全フォーマット有効だった頃は 1 回の解析が 10 倍（約 31ms -> 311ms）になり
    // 実効 3 回/秒まで落ちたが、POSSIBLE_FORMATS を絞った今はこの 3 本ぶんの
    // 増加で済む。**重くなったらまずここを外す。**
    // 判断は onEngineChange の rate を実機で見て行うこと
    // （CODE39 1 本だった頃より重いので、フォーマットを増やしたら測り直すこと）。
    //
    // setHints は TRY_HARDER をキーの有無で見る（値が false でも「あり」扱い）。
    // 外すときは false を入れるのではなく set ごと消すこと
    const hints = new Map();
    hints.set(
      ZXing.DecodeHintType.POSSIBLE_FORMATS,
      message.formats.map((format) => ZXing.BarcodeFormat[format.zxing])
    );
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);

    const reader = new ZXing.MultiFormatReader();
    reader.setHints(hints);

    return (request) => {
      const gray = toGrayscale(
        new Uint8ClampedArray(request.buffer),
        request.width,
        request.height
      );

      // RGBLuminanceSource は isRotateSupported() が false なので、TRY_HARDER を
      // 付けても ZXing 側の 90 度回転リトライは走らない。縦向きバーコードは
      // barcode.js 側の rotateNext（1 フレームおきに 90 度回して渡す）で拾う
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

  // ZXing-C++ は 'EAN13' という独自の表記で返してくるので、他のエンジンと同じ
  // 大文字表記（EAN_13）に直す。対応は FORMATS が持っているのでそれを引く。
  //
  // symbology と format の 2 つがあり、symbology のほうが粗い。EAN13 / EAN8 は
  // どちらも symbology が 'EANUPC'（EAN/UPC 系をまとめた親）になり、13 桁と 8 桁の
  // 区別が付かない（3.1.4 で確認）。**先に format を見て、駄目なら symbology** の順で
  // FORMATS を引く。symbology 側にしか無い括り（Code39Ext をまとめた Code39 など）も
  // これで拾える
  function zxingCppFormat(result, formats) {
    const names = [result.format, result.symbology]
      .map((name) => String(name || ''))
      .filter(Boolean);

    for (const name of names) {
      const known = formats.find(
        (format) => format.zxingCpp.toLowerCase() === name.toLowerCase()
      );
      if (known) return known.zxing;
    }

    return (names[0] || '').toUpperCase();
  }

  // prepareZXingModule は overrides の中身が前回と同じかどうかで Module を使い回すので、
  // 呼ぶたびに新しい関数を作らないよう wasm の URL ごとに 1 つだけ持つ
  const zxingCppOverrides = new Map();

  async function createZXingCpp(message, load) {
    // この IIFE 版は window を参照しないので Worker でもそのまま動く（Quagga2 との違い）
    if (!self.ZXingWASM) await load(message.src);

    const ZXingWASM = self.ZXingWASM;
    if (!ZXingWASM) throw new Error('ZXing-C++ の初期化に失敗しました。');

    // 解析オプションの中身と理由は barcode.js の ZXING_CPP_OPTIONS を参照
    const options = {
      ...message.options,
      formats: message.formats.map((format) => format.zxingCpp)
    };

    if (!zxingCppOverrides.has(message.wasm)) {
      // 既定の locateFile は jsDelivr の URL を返す。同梱した wasm を指すように差し替える
      // （barcode.js が ZXING_CPP_WASM から作った絶対 URL）
      zxingCppOverrides.set(message.wasm, {
        locateFile: (path, prefix) => (path.endsWith('.wasm') ? message.wasm : prefix + path)
      });
    }

    // fireImmediately で、wasm の取得とコンパイルまでこの init のあいだに終わらせる。
    // ここを待たずに返すと、最初の数フレームの解析がまとめて待たされる
    await ZXingWASM.prepareZXingModule({
      overrides: zxingCppOverrides.get(message.wasm),
      fireImmediately: true
    });

    return async (request) => {
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

  // エンジンを 1 つ用意して、解析の関数を返す。
  // load(src) は同梱ライブラリの読み込み方（Worker なら importScripts、
  // メインスレッドなら barcode.js の loadScript）
  function createDecoder(message, load) {
    if (message.engine === 'native') return createNative(message);
    if (message.engine === 'zxing-cpp') return createZXingCpp(message, load);
    if (message.engine === 'zxing') return createZXing(message, load);
    return Promise.reject(new Error(`不明なエンジンです: ${message.engine}`));
  }

  if (!IS_WORKER) {
    // メインスレッドで読み込まれた（フォールバック）。受け口を生やすだけ
    window.BarcodeWorkerCore = { createDecoder };
    return;
  }

  function messageOf(err) {
    return (err && err.message) || String(err);
  }

  let decode = null;

  self.onmessage = async (event) => {
    const message = event.data;

    if (message.type === 'init') {
      try {
        decode = await createDecoder(message, async (src) => importScripts(src));
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
})();
