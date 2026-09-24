// Quagga2 での検出処理。barcode-worker.js の Quagga2 版で、barcode.js からしか使わない
// （エンジンに 'quagga' を選んだときだけ barcode.js が読み込む）。
//
// Quagga2 だけ Worker に乗せられないので、このファイルに分けてある。
//   - 同梱の UMD は読み込み時に window を直接参照するので、Worker では読み込めない
//   - 公開 API の decodeSingle は画像を URL（<img> 経由）でしか受け取れない
// そのため解析のあいだメインスレッドが止まり、しかも切り出した canvas を毎フレーム
// PNG の data URL にするぶん（エンコードとデコード）が丸ごと乗る。読み比べ用の経路と
// 割り切ってそのままにしてある（実際に何回回っているかは onEngineChange の rate を見る）。
//
// barcode-worker.js の decoder と同じ形にしてある:
//   BarcodeQuagga2.createDecoder({ formats, src }, load) → Promise<decode>
//   decode({ canvas }) → Promise<{ text, format } | null>
// Worker に渡さないので、画素ではなく切り出した canvas をそのまま受け取る。
(() => {
  'use strict';

  // 1 フレームぶんの解析を打ち切るまでの時間。
  // decodeSingle は画像の読み込みに失敗すると Promise が解決も棄却もされないまま残る。
  // そうなると呼び出し元（barcode.js → camera.js のスキャンループ）が二度と進まなくなる
  // （0/s のまま無反応になる）ので、必ず打ち切れるようにしておく
  const QUAGGA_DECODE_TIMEOUT_MS = 3000;

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

  // src は barcode.js が QUAGGA_SRC から作った絶対 URL。load は barcode.js の loadScript
  async function createDecoder(message, load) {
    if (!window.Quagga) await load(message.src);

    const Quagga = window.Quagga;
    if (!Quagga) throw new Error('Quagga2 の初期化に失敗しました。');

    const readers = message.formats.map((format) => format.quagga);

    return async (request) => {
      const source = request.canvas;
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
        // 縮小は barcode.js の MAX_SCAN_SIDE で済ませてあるので、locator の halfSample は
        // decodeSingle の既定（false）のまま。ここで更に半分にするとバーが潰れる。
        // バーコードの位置と傾きは locator が探すので、ZXing のように
        // 90 度回転させて渡す必要は無い
        locate: true
      });

      const result = await withTimeout(
        decoding,
        QUAGGA_DECODE_TIMEOUT_MS,
        'Quagga2 の解析がタイムアウトしました。'
      );

      const code = result && result.codeResult;
      if (!code || !code.code) return null;

      // 他のエンジンと表記を揃える（code_128 -> CODE_128）
      return { text: code.code, format: String(code.format).toUpperCase() };
    };
  }

  window.BarcodeQuagga2 = { createDecoder };
})();
