(() => {
  'use strict';

  // 撮影は <video> の現在フレームを canvas に写して JPEG 化する方式。
  // ImageCapture.takePhoto() ならセンサー解像度で撮れるが、iOS Safari / Firefox が
  // 未対応で、端末によってはプレビューが一瞬止まる。ここでは全ブラウザで同じ結果に
  // なることを優先し、プレビューと同じ映像（最大 1080p）をそのまま保存する
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

  let active = false;    // カメラ稼働中か（camera.js が制御する）
  let mirrored = false;  // フロントカメラか
  let objectUrl = null;
  let photoFile = null;
  let labelTimerId = null;
  let busy = false;

  // --- 撮影 -------------------------------------------------------------

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  // 例: photo-20260917-142530.jpg
  function buildFileName() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    return `photo-${date}-${time}.jpg`;
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

  function drawFrame() {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return false;

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    ctx.save();
    // フロントカメラはプレビューを CSS で左右反転しているので、
    // 見たままの向きで保存されるよう画像側も反転させる
    if (mirrored) {
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, width, height);
    ctx.restore();

    return true;
  }

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

  async function takePhoto() {
    if (busy || !active || dialog.open) return;

    busy = true;
    shutterBtn.disabled = true;

    try {
      if (!drawFrame()) return;

      playFlash();
      if (navigator.vibrate) navigator.vibrate(30);

      const blob = await toBlob();
      const name = buildFileName();

      releasePhoto();
      objectUrl = URL.createObjectURL(blob);
      photoFile = new File([blob], name, { type: blob.type });

      image.src = objectUrl;
      image.alt = `撮影した写真 ${canvas.width} × ${canvas.height}`;
      info.textContent = `${canvas.width} × ${canvas.height}  ${formatBytes(blob.size)}`;
      saveBtn.download = name;
      saveBtn.href = objectUrl;
      // 共有シートはモバイル中心。ファイル共有に未対応なら保存だけを見せる
      shareBtn.hidden = !(navigator.canShare && navigator.canShare({ files: [photoFile] }));

      openDialog();
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

  shutterBtn.addEventListener('click', takePhoto);
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

  function start(options = {}) {
    active = true;
    mirrored = options.facingMode === 'user';
    shutterBtn.disabled = false;
  }

  function stop() {
    active = false;
    shutterBtn.disabled = true;
    if (dialog.open) dialog.close();
  }

  window.PhotoCapture = { start, stop };
})();
