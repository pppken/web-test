(() => {
  'use strict';

  // 撮影は端末の静止画撮影（ImageCapture.takePhoto）を優先する。
  // プレビュー用のストリームより高い解像度で撮れるが、iOS Safari / Firefox は未対応で、
  // 対応端末でも撮影モードに入れずに失敗することがある。
  // その場合は <video> の現在フレームを canvas に写す方式へ自動的に切り替える
  const JPEG_QUALITY = 0.92;
  const LABEL_RESET_MS = 1500;

  const video = document.getElementById('video');
  const flash = document.getElementById('flash');
  const shutterBtn = document.getElementById('shutterBtn');

  const dialog = document.getElementById('photo');
  const image = document.getElementById('photoImage');
  const info = document.getElementById('photoInfo');
  const saveBtn = document.getElementById('photoSaveBtn');
  const shareBtn = document.getElementById('photoShareBtn');
  const closeBtn = document.getElementById('photoCloseBtn');

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  // barcode.js が読み込めなかった場合でも撮影だけは動くようにしておく
  const scanner = window.BarcodeScanner || { pause() {}, resume() {} };

  let active = false;       // カメラ稼働中か（camera.js が制御する）
  let mirrored = false;     // フロントカメラか
  let track = null;         // 撮影に使う映像トラック
  let imageCapture = null;  // 使えない・失敗した場合は null（= フレーム取得にフォールバック）
  let objectUrl = null;
  let photoFile = null;
  let labelTimerId = null;
  let busy = false;

  // --- 画像の生成 -------------------------------------------------------

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  // 例: photo-20260917-142530.jpg
  function buildFileName(type) {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    // takePhoto が返す形式は端末任せなので、拡張子は実際の MIME に合わせる
    const ext = type === 'image/jpeg' ? 'jpg' : (type || '').split('/')[1] || 'jpg';

    return `photo-${date}-${time}.${ext}`;
  }

  function toBlob() {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('画像の生成に失敗しました。'))),
        'image/jpeg',
        JPEG_QUALITY
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
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return null;

    // フロントカメラはプレビューを CSS で左右反転しているので、画像側も反転させる
    drawSource(video, width, height, mirrored);

    return toBlob();
  }

  // --- 撮影 -------------------------------------------------------------

  // 一度付けた class を外してから付け直さないと、連写でアニメーションが再生されない
  function playFlash() {
    flash.classList.remove('on');
    void flash.offsetWidth; // リフローを強制して再生位置をリセットする
    flash.classList.add('on');
  }

  function releasePhoto() {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    photoFile = null;
  }

  function showPhoto(blob, source) {
    releasePhoto();

    const name = buildFileName(blob.type);
    objectUrl = URL.createObjectURL(blob);
    photoFile = new File([blob], name, { type: blob.type });

    // 解像度は画像を読み込むまで分からないので、まず分かる情報だけ出す
    info.textContent = `${formatBytes(blob.size)}  ${source}`;
    image.addEventListener(
      'load',
      () => {
        info.textContent =
          `${image.naturalWidth} × ${image.naturalHeight}  ${formatBytes(blob.size)}  ${source}`;
      },
      { once: true }
    );

    image.src = objectUrl;
    saveBtn.download = name;
    saveBtn.href = objectUrl;
    // 共有シートはモバイル中心。ファイル共有に未対応なら保存だけを見せる
    shareBtn.hidden = !(navigator.canShare && navigator.canShare({ files: [photoFile] }));

    openDialog();
  }

  async function capture() {
    if (busy || !active || dialog.open) return;

    busy = true;
    shutterBtn.disabled = true;

    // takePhoto は完了までに時間がかかることがあるので、先に反応を返しておく
    playFlash();
    if (navigator.vibrate) navigator.vibrate(30);

    try {
      let source = '静止画撮影';
      let blob = await takeStill();

      if (!blob) {
        source = 'フレーム取得';
        blob = await grabFrame();
      }

      if (blob) showPhoto(blob, source);
    } catch (err) {
      console.error('撮影に失敗しました', err);
      setLabel(shutterBtn, '撮影できません');
    } finally {
      busy = false;
      // ダイアログを開いた場合は、閉じたときに戻す
      if (!dialog.open) shutterBtn.disabled = !active;
    }
  }

  // --- プレビューのダイアログ -------------------------------------------

  function openDialog() {
    // 撮影中はバーコードの解析を止める（結果ダイアログが重なるのを防ぐ）
    scanner.pause();

    // <dialog> 非対応ブラウザでも最低限は表示されるようにしておく
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function setLabel(button, text) {
    const original = button.dataset.label || button.textContent;
    button.dataset.label = original;
    button.textContent = text;

    clearTimeout(labelTimerId);
    labelTimerId = setTimeout(() => {
      button.textContent = original;
    }, LABEL_RESET_MS);
  }

  async function sharePhoto() {
    if (!photoFile) return;

    try {
      await navigator.share({ files: [photoFile] });
    } catch (err) {
      // ユーザーがシートを閉じただけなら何も出さない
      if (err.name === 'AbortError') return;

      console.warn('共有に失敗しました', err);
      setLabel(shareBtn, '共有できません');
    }
  }

  shutterBtn.addEventListener('click', capture);
  shareBtn.addEventListener('click', sharePhoto);
  closeBtn.addEventListener('click', () => dialog.close());

  dialog.addEventListener('close', () => {
    clearTimeout(labelTimerId);
    shareBtn.textContent = shareBtn.dataset.label || shareBtn.textContent;

    // 画像を手放してから URL を解放する（表示中に revoke すると消えてしまう）
    image.removeAttribute('src');
    saveBtn.removeAttribute('href');
    releasePhoto();

    shutterBtn.disabled = !active;
    scanner.resume();
  });

  // --- camera.js から呼ばれる -------------------------------------------

  function createImageCapture(videoTrack) {
    if (!('ImageCapture' in window) || !videoTrack) return null;

    try {
      return new window.ImageCapture(videoTrack);
    } catch (err) {
      console.warn('ImageCapture を利用できません', err);
      return null;
    }
  }

  function start(options = {}) {
    active = true;
    mirrored = options.facingMode === 'user';
    track = options.track || null;
    imageCapture = createImageCapture(track);
    shutterBtn.disabled = false;
  }

  function stop() {
    active = false;
    track = null;
    imageCapture = null;
    shutterBtn.disabled = true;
    if (dialog.open) dialog.close();
  }

  window.PhotoCapture = { start, stop };
})();
