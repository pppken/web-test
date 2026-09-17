(() => {
  'use strict';

  // 静止画撮影。端末の静止画撮影（ImageCapture.takePhoto）を優先する。
  // プレビュー用のストリームより高い解像度で撮れるが、iOS Safari / Firefox は未対応で、
  // 対応端末でも撮影モードに入れずに失敗することがある。
  // その場合は <video> の現在フレームを canvas に写す方式へ自動的に切り替える。
  //
  // このファイルは DOM を探さない。<video> は configure() で受け取り、
  // 出来上がった画像は Blob と File で呼び出し側に返すだけ。
  // シャッターボタン・フラッシュ・プレビューのダイアログ・保存と共有はすべて
  // 呼び出し側の責任にしてある。
  //
  //   PhotoCapture.configure({
  //     video,                 // 必須。HTMLVideoElement
  //     quality,               // JPEG の品質（既定 0.92）
  //     fileNamePrefix,        // ファイル名の頭（既定 'photo'）
  //     onCaptureStart(),      // シャッターを切った直後。フラッシュや振動はここで
  //     onPhoto({ blob, file, name, type, size, method }),
  //     onError({ code, message, error })
  //   });
  //   PhotoCapture.attach({ facingMode, track })  // カメラ起動時
  //   PhotoCapture.detach()                       // カメラ停止時
  //   PhotoCapture.capture()                      // Promise<photo | null>
  //
  // method は 'still'（ImageCapture.takePhoto）か 'frame'（<video> のフレーム取得）。
  // どちらを通ったかは端末依存なので、実機で両方を確認すること。
  //
  // 返す Blob と File の寿命は呼び出し側が持つ。objectURL を作った場合は
  // 使い終わったら必ず revoke すること（このファイルは objectURL を作らない）。
  //
  // フロントカメラ（facingMode === 'user'）では画像を左右反転して返す。
  // プレビュー側を CSS で反転している前提に合わせるためで、
  // フレーム取得経路は canvas 描画時に、takePhoto 経路は再エンコードして反転する。

  const DEFAULT_QUALITY = 0.92;
  const DEFAULT_PREFIX = 'photo';

  // onError の既定の文言。呼び出し側は code だけを見て自前の文言を出してもよい
  const MESSAGES = {
    'capture-failed': '撮影に失敗しました。'
  };

  const config = {
    video: null,
    quality: DEFAULT_QUALITY,
    fileNamePrefix: DEFAULT_PREFIX,
    onCaptureStart: null,
    onPhoto: null,
    onError: null
  };

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  let configured = false;
  let active = false;       // カメラ稼働中か（attach / detach で切り替わる）
  let mirrored = false;     // フロントカメラか
  let track = null;         // 撮影に使う映像トラック
  let imageCapture = null;  // 使えない・失敗した場合は null（= フレーム取得にフォールバック）
  let busy = false;

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

  function ensureConfigured() {
    if (!configured) throw new Error('PhotoCapture: 先に configure() を呼んでください。');
  }

  // --- 画像の生成 -------------------------------------------------------

  // 例: photo-20260917-142530.jpg
  function buildFileName(type) {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    // takePhoto が返す形式は端末任せなので、拡張子は実際の MIME に合わせる
    const ext = type === 'image/jpeg' ? 'jpg' : (type || '').split('/')[1] || 'jpg';

    return `${config.fileNamePrefix}-${date}-${time}.${ext}`;
  }

  function toBlob() {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('画像の生成に失敗しました。'))),
        'image/jpeg',
        config.quality
      );
    });
  }

  function drawSource(source, width, height, flip) {
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    ctx.save();
    if (flip) {
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(source, 0, 0, width, height);
    ctx.restore();
  }

  // 左右反転した画像を作り直す。再エンコードになるので必要なときだけ通す
  async function mirrorBlob(blob) {
    const bitmap = await createImageBitmap(blob);

    try {
      drawSource(bitmap, bitmap.width, bitmap.height, true);
    } finally {
      bitmap.close();
    }

    return toBlob();
  }

  // 端末の静止画撮影。使えない場合は null を返して呼び出し元に任せる
  async function takeStill() {
    if (!imageCapture || !track || track.readyState !== 'live') return null;

    try {
      const blob = await imageCapture.takePhoto();

      // takePhoto はセンサーの向きで返るので、プレビューを左右反転している
      // フロントカメラでは、見たままの向きに揃える
      return mirrored ? await mirrorBlob(blob) : blob;
    } catch (err) {
      // 撮影モードに入れない端末・タイミングがある。以後はフレーム取得に任せる
      console.warn('takePhoto に失敗したため、プレビューのフレームを使います', err);
      imageCapture = null;
      return null;
    }
  }

  // プレビューの現在フレームを切り出す（ImageCapture が使えないときの経路）
  async function grabFrame() {
    const video = config.video;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return null;

    // フロントカメラはプレビューを CSS で左右反転しているので、画像側も反転させる
    drawSource(video, width, height, mirrored);

    return toBlob();
  }

  // --- 撮影 -------------------------------------------------------------

  // 出来上がった画像を返す。呼び出し側は onPhoto でも戻り値でも受け取れる。
  // 二重に走らせない（busy）のと、カメラが止まっているときに何もしないのはこちらの責任
  async function capture() {
    ensureConfigured();
    if (busy || !active) return null;

    busy = true;

    // takePhoto は完了までに時間がかかることがあるので、先に反応を返しておく
    // （フラッシュや振動は呼び出し側がここで行う）
    emit('onCaptureStart', {});

    try {
      let method = 'still';
      let blob = await takeStill();

      if (!blob) {
        method = 'frame';
        blob = await grabFrame();
      }

      if (!blob) return null;

      const name = buildFileName(blob.type);
      const photo = {
        blob,
        file: new File([blob], name, { type: blob.type }),
        name,
        type: blob.type,
        size: blob.size,
        method
      };

      emit('onPhoto', photo);
      return photo;
    } catch (err) {
      console.error('撮影に失敗しました', err);
      emit('onError', { code: 'capture-failed', message: MESSAGES['capture-failed'], error: err });
      return null;
    } finally {
      busy = false;
    }
  }

  // --- ライフサイクル ---------------------------------------------------

  function createImageCapture(videoTrack) {
    if (!('ImageCapture' in window) || !videoTrack) return null;

    try {
      return new window.ImageCapture(videoTrack);
    } catch (err) {
      console.warn('ImageCapture を利用できません', err);
      return null;
    }
  }

  function configure(options = {}) {
    Object.assign(config, options);

    if (!config.video) throw new Error('PhotoCapture.configure: video が必要です。');

    configured = true;
  }

  // カメラが起動したら呼ぶ。track はズーム・明るさと同じものを使うので、
  // 撮影結果にもそれらの設定がそのまま効く
  function attach(options = {}) {
    ensureConfigured();

    active = true;
    mirrored = options.facingMode === 'user';
    track = options.track || null;
    imageCapture = createImageCapture(track);
  }

  function detach() {
    active = false;
    track = null;
    imageCapture = null;
  }

  window.PhotoCapture = {
    configure,
    attach,
    detach,
    capture,
    isActive: () => active,
    isBusy: () => busy
  };
})();
