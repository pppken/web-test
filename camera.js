(() => {
  'use strict';

  const frame = document.getElementById('frame');
  const video = document.getElementById('video');
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const switchBtn = document.getElementById('switchBtn');
  const status = document.getElementById('status');

  const STORAGE_KEY = 'cameraFacingMode';
  const DEFAULT_FACING_MODE = 'environment'; // 既定はリアカメラ ('user' = フロント)

  // 前回選択したカメラの向きを復元する。
  // プライベートモードや file:// では localStorage が使えないことがあるので握りつぶす
  function loadFacingMode() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'user' || saved === 'environment') return saved;
    } catch (err) {
      console.warn('カメラ設定の読み込みに失敗しました', err);
    }
    return DEFAULT_FACING_MODE;
  }

  function saveFacingMode(mode) {
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch (err) {
      console.warn('カメラ設定の保存に失敗しました', err);
    }
  }

  let stream = null;
  let facingMode = loadFacingMode();

  // barcode.js / photo.js が読み込めなかった場合でもカメラ単体で動くようにしておく
  const scanner = window.BarcodeScanner || { start() {}, stop() {} };
  const photo = window.PhotoCapture || { start() {}, stop() {} };

  function setStatus(message) {
    status.textContent = message;
  }

  function setRunning(running) {
    startBtn.disabled = running;
    stopBtn.disabled = !running;
    switchBtn.disabled = !running;
    // 停止中は枠を画面いっぱいに広げ、ボタンが潰れないようにする
    frame.classList.toggle('idle', !running);
  }

  // 実際に再生中の解像度をプレビュー上に表示する
  function updateStatus() {
    if (!stream) return;

    const label = facingMode === 'environment' ? 'リアカメラ' : 'フロントカメラ';
    const width = video.videoWidth;
    const height = video.videoHeight;

    setStatus(width ? `${label}  ${width} × ${height}` : label);
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('このブラウザはカメラに対応していません。');
      return;
    }

    stopCamera({ silent: true });
    setStatus('カメラを起動中...');

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      });

      video.srcObject = stream;
      await video.play();

      // フロントカメラのときだけ鏡像表示にする
      video.classList.toggle('mirrored', facingMode === 'user');

      // 起動に成功した向きだけを次回用に保存する
      saveFacingMode(facingMode);

      setRunning(true);
      updateStatus();
      scanner.start();
      photo.start({ facingMode });
    } catch (err) {
      handleError(err);
    }
  }

  function stopCamera(options = {}) {
    if (!stream) return;

    scanner.stop();
    photo.stop();
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
    video.srcObject = null;

    setRunning(false);
    setStatus(options.silent ? '' : 'カメラを停止しました。');
  }

  async function switchCamera() {
    const previous = facingMode;
    facingMode = facingMode === 'environment' ? 'user' : 'environment';

    switchBtn.disabled = true;
    await startCamera();

    // 切替に失敗した場合は元の向きに戻す
    if (!stream) facingMode = previous;
  }

  function handleError(err) {
    setRunning(false);

    switch (err.name) {
      case 'NotAllowedError':
        setStatus('カメラの使用が拒否されました。ブラウザの権限設定を確認してください。');
        break;
      case 'NotFoundError':
      case 'OverconstrainedError':
        setStatus('指定した向きのカメラが見つかりませんでした。');
        break;
      case 'NotReadableError':
        setStatus('カメラが他のアプリで使用中の可能性があります。');
        break;
      default:
        setStatus(`エラー: ${err.name} - ${err.message}`);
    }

    console.error(err);
  }

  // 権限が既に許可済みかを調べる。
  // Permissions API の 'camera' は未対応のブラウザ（Firefox / 一部の Safari）があるため、
  // 失敗しても致命的に扱わない
  async function queryCameraPermission() {
    if (!navigator.permissions || !navigator.permissions.query) return null;

    try {
      return await navigator.permissions.query({ name: 'camera' });
    } catch (err) {
      return null;
    }
  }

  startBtn.addEventListener('click', startCamera);
  stopBtn.addEventListener('click', () => stopCamera());
  switchBtn.addEventListener('click', switchCamera);

  // 解像度が確定／変化したタイミングで表示を更新する
  video.addEventListener('loadedmetadata', updateStatus);
  video.addEventListener('resize', updateStatus);

  // ページを離れるときにカメラを確実に解放する
  window.addEventListener('pagehide', () => stopCamera({ silent: true }));

  async function init() {
    setRunning(false);

    // 安全なコンテキスト (https:// か localhost) でないと、
    // ブラウザは権限を永続化しないため毎回ダイアログが出る
    if (!window.isSecureContext) {
      setStatus(
        `${location.protocol}// では権限が保存されません。https:// か http://localhost で開いてください。`
      );
      return;
    }

    const permission = await queryCameraPermission();
    if (!permission) return;

    // 許可済みならダイアログは出ないので、そのまま起動する
    if (permission.state === 'granted') {
      startCamera();
    } else if (permission.state === 'denied') {
      setStatus('カメラがブロックされています。アドレスバーのアイコンから許可してください。');
    }

    permission.addEventListener('change', () => {
      if (permission.state === 'granted' && !stream) startCamera();
    });
  }

  init();
})();
