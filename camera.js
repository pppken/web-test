(() => {
  'use strict';

  const frame = document.getElementById('frame');
  const video = document.getElementById('video');
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const switchBtn = document.getElementById('switchBtn');
  const zoomBtn = document.getElementById('zoomBtn');
  const status = document.getElementById('status');

  const STORAGE_KEY = 'cameraFacingMode';
  const DEFAULT_FACING_MODE = 'environment'; // 既定はリアカメラ ('user' = フロント)

  // ズームボタンで巡回する倍率。実際に使えるのは端末が getCapabilities().zoom で
  // 返した範囲に収まるものだけで、外れたぶんは起動時にふるい落とす。
  // zoom の値は端末によって尺度が違う（1〜8 で返すものもあれば 100〜400 で返すものもある）ので、
  // 絶対値ではなく min（＝等倍）の何倍かで持つ
  const ZOOM_FACTORS = [1, 2, 3, 5];

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

  let zoomTrack = null;  // ズームを適用する映像トラック（= 再生中のもの）
  let zoomLevels = [];   // 実際に設定できる zoom の値（昇順。先頭は min ＝ 等倍）
  let zoomIndex = 0;

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
    // ズームは端末が対応している場合だけ押せる。稼働中の有効・無効は setupZoom() が決める
    if (!running) clearZoom();
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

  // --- ズーム -----------------------------------------------------------

  // 端末が対応しているズームの範囲を読む。
  // ズームは端末差が大きく、iOS Safari や大半の PC では capabilities に zoom 自体が無い。
  // getCapabilities() も未対応のブラウザ（Firefox）があるので、
  // 取れなければ null を返してボタンを '非対応' にする
  function readZoomCapability(track) {
    if (!track || typeof track.getCapabilities !== 'function') return null;

    let capabilities = null;
    try {
      capabilities = track.getCapabilities();
    } catch (err) {
      console.warn('カメラの capabilities を取得できませんでした', err);
      return null;
    }

    const zoom = capabilities && capabilities.zoom;
    if (!zoom || typeof zoom.min !== 'number' || typeof zoom.max !== 'number') return null;
    // min と max が同じ（＝動かせない）端末は非対応と同じ扱いにする
    if (!(zoom.max > zoom.min)) return null;

    return zoom;
  }

  // 端末が受け付ける値に丸める。step を返す端末では min + step * n しか設定できない
  function snapZoom(zoom, value) {
    const step = typeof zoom.step === 'number' && zoom.step > 0 ? zoom.step : 0;
    const stepped = step ? zoom.min + Math.round((value - zoom.min) / step) * step : value;

    return Math.min(Math.max(stepped, zoom.min), zoom.max);
  }

  // ZOOM_FACTORS を、その端末で実際に設定できる値の並びに落とし込む。
  // 範囲を超えたぶんは max に丸められて前の段と重なるので、増える段だけを残す
  // （例: max が 2.5 倍までの端末なら 1x / 2x / 2.5x の 3 段になる）
  function buildZoomLevels(zoom) {
    const levels = [];

    for (const factor of ZOOM_FACTORS) {
      const value = snapZoom(zoom, zoom.min * factor);
      if (levels.length === 0 || value > levels[levels.length - 1]) levels.push(value);
    }

    return levels;
  }

  // いま実際に出ている倍率。applyConstraints のあとに端末側が丸めることがあるので、
  // 要求値ではなく getSettings() の実値を優先する
  function currentZoom() {
    if (zoomTrack && typeof zoomTrack.getSettings === 'function') {
      try {
        const settings = zoomTrack.getSettings();
        if (typeof settings.zoom === 'number') return settings.zoom;
      } catch (err) {
        console.warn('カメラの settings を取得できませんでした', err);
      }
    }

    return zoomLevels[zoomIndex];
  }

  // 「エンジン」ボタンと同じく、ラベルは常にその時の状態を表す。
  // 倍率は min を等倍として表示する（zoom の絶対値は端末ごとに尺度が違う）
  function renderZoomButton() {
    if (zoomLevels.length === 0) {
      zoomBtn.textContent = zoomTrack ? 'ズーム: 非対応' : 'ズーム';
      return;
    }

    zoomBtn.textContent = `ズーム: ${(currentZoom() / zoomLevels[0]).toFixed(1)}x`;
  }

  // 起動直後から等倍以外で始まる端末があるので、いまの倍率に一番近い段から巡回を始める
  function nearestZoomIndex(value) {
    let index = 0;

    zoomLevels.forEach((level, i) => {
      if (Math.abs(level - value) < Math.abs(zoomLevels[index] - value)) index = i;
    });

    return index;
  }

  function setupZoom(track) {
    zoomTrack = track || null;
    zoomIndex = 0;

    const zoom = readZoomCapability(zoomTrack);
    zoomLevels = zoom ? buildZoomLevels(zoom) : [];
    // 段が 1 つしか作れない端末はズームしても何も変わらないので非対応と同じ扱いにする
    if (zoomLevels.length < 2) zoomLevels = [];
    if (zoomLevels.length) zoomIndex = nearestZoomIndex(currentZoom());

    zoomBtn.disabled = zoomLevels.length === 0;
    renderZoomButton();
  }

  function clearZoom() {
    zoomTrack = null;
    zoomLevels = [];
    zoomIndex = 0;
    zoomBtn.disabled = true;
    renderZoomButton();
  }

  // 押すたびに 1.0x -> 2.0x -> ... と巡回し、最大まで行ったら等倍に戻る
  async function zoomNext() {
    if (!zoomTrack || zoomLevels.length === 0) return;

    const previous = zoomIndex;
    zoomIndex = (zoomIndex + 1) % zoomLevels.length;

    zoomBtn.disabled = true;

    try {
      await zoomTrack.applyConstraints({ advanced: [{ zoom: zoomLevels[zoomIndex] }] });
      updateStatus();
    } catch (err) {
      // 設定できなかった場合は選択を戻し、直前の倍率のまま使い続ける
      // （前後切替・エンジン切替と同じ扱い）
      zoomIndex = previous;
      console.warn('ズームを変更できませんでした', err);
      setStatus('ズームを変更できませんでした。');
    } finally {
      // 待っている間にカメラが止まっていれば zoomLevels は空になっている
      zoomBtn.disabled = zoomLevels.length === 0;
      renderZoomButton();
    }
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

      const videoTrack = stream.getVideoTracks()[0];

      setRunning(true);
      updateStatus();
      setupZoom(videoTrack);
      scanner.start();
      photo.start({ facingMode, track: videoTrack });
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
  zoomBtn.addEventListener('click', zoomNext);

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
