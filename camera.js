(() => {
  'use strict';

  const frame = document.getElementById('frame');
  const video = document.getElementById('video');
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const switchBtn = document.getElementById('switchBtn');
  const zoomBtn = document.getElementById('zoomBtn');
  const brightnessBtn = document.getElementById('brightnessBtn');
  const brightnessPanel = document.getElementById('brightnessPanel');
  const brightnessRange = document.getElementById('brightnessRange');
  const brightnessValueLabel = document.getElementById('brightnessValue');
  const status = document.getElementById('status');

  const STORAGE_KEY = 'cameraFacingMode';
  const DEFAULT_FACING_MODE = 'environment'; // 既定はリアカメラ ('user' = フロント)

  // ズームボタンで巡回する倍率。実際に使えるのは端末が getCapabilities().zoom で
  // 返した範囲に収まるものだけで、外れたぶんは起動時にふるい落とす。
  // zoom の値は端末によって尺度が違う（1〜8 で返すものもあれば 100〜400 で返すものもある）ので、
  // 絶対値ではなく min（＝等倍）の何倍かで持つ
  const ZOOM_FACTORS = [1, 2, 3, 5];

  // 明るさとして使う capabilities のキー。先に見つかったほうを使う。
  // Android Chrome は brightness を持たず exposureCompensation だけを返すことが多く、
  // 逆に PC の UVC カメラは brightness を返す。どちらも尺度も意味も端末任せなので、
  // 値はこちらで換算せず、端末が返した範囲をそのままスライダーに渡す
  const BRIGHTNESS_KEYS = ['brightness', 'exposureCompensation'];

  // step を返さない端末で、スライダーの刻みを作るための段数
  const BRIGHTNESS_STEPS = 100;

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

  let brightnessTrack = null;    // 明るさを適用する映像トラック（= 再生中のもの）
  let brightnessCap = null;      // { key, min, max, step }。非対応なら null
  let brightnessValue = 0;       // 最後に適用できた値
  let brightnessPending = null;  // 適用中に動かされたぶん（最新の 1 つだけ持つ）
  let brightnessApplying = false;

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
    // ズームと明るさは端末が対応している場合だけ押せる。
    // 稼働中の有効・無効は setupZoom() / setupBrightness() が決める
    if (!running) {
      clearZoom();
      clearBrightness();
    }
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

  // --- トラックの能力 ---------------------------------------------------

  // getCapabilities() は未対応のブラウザ（Firefox）があり、端末によっては例外も投げる。
  // 取れなければ null を返し、呼び出し側はその機能を '非対応' として扱う
  function readCapabilities(track) {
    if (!track || typeof track.getCapabilities !== 'function') return null;

    try {
      return track.getCapabilities();
    } catch (err) {
      console.warn('カメラの capabilities を取得できませんでした', err);
      return null;
    }
  }

  // applyConstraints のあとに端末側が値を丸めることがあるので、
  // 表示は要求値ではなくこちらの実値から出す
  function readSettings(track) {
    if (!track || typeof track.getSettings !== 'function') return null;

    try {
      return track.getSettings();
    } catch (err) {
      console.warn('カメラの settings を取得できませんでした', err);
      return null;
    }
  }

  // --- ズーム -----------------------------------------------------------

  // 端末が対応しているズームの範囲を読む。
  // ズームは端末差が大きく、iOS Safari や大半の PC では capabilities に zoom 自体が無い
  function readZoomCapability(track) {
    const capabilities = readCapabilities(track);
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

  // いま実際に出ている倍率。端末側で丸められることがあるので、
  // 要求値ではなく getSettings() の実値を優先する
  function currentZoom() {
    const settings = readSettings(zoomTrack);
    if (settings && typeof settings.zoom === 'number') return settings.zoom;

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

  // --- 明るさ -----------------------------------------------------------

  // 端末が調整できる明るさの範囲を読む。ズームと同じで、指定できる値はこちらで決めず、
  // capabilities が返した { min, max, step } をそのままスライダーに渡す
  function readBrightnessCapability(track) {
    const capabilities = readCapabilities(track);
    if (!capabilities) return null;

    for (const key of BRIGHTNESS_KEYS) {
      const range = capabilities[key];
      if (!range || typeof range.min !== 'number' || typeof range.max !== 'number') continue;
      // min と max が同じ（＝動かせない）端末は非対応と同じ扱いにする
      if (!(range.max > range.min)) continue;

      // step を返さない端末向けの保険。範囲が BRIGHTNESS_STEPS より広ければ 1 刻み
      // （0〜255 のような整数の尺度で半端な値を送らないため）、狭ければ等分する
      const span = range.max - range.min;
      const step = typeof range.step === 'number' && range.step > 0
        ? range.step
        : (span >= BRIGHTNESS_STEPS ? 1 : span / BRIGHTNESS_STEPS);

      return { key, min: range.min, max: range.max, step };
    }

    return null;
  }

  // いま実際に出ている値。ズームの currentZoom() と同じで実値を優先する。
  // settings に出てこない端末（設定はできるが読めない）向けに既定値を渡せるようにしてある
  function currentBrightness(fallback = brightnessValue) {
    const settings = readSettings(brightnessTrack);
    if (brightnessCap && settings && typeof settings[brightnessCap.key] === 'number') {
      return settings[brightnessCap.key];
    }

    return fallback;
  }

  // 尺度が端末ごとに違う（0〜255 の brightness もあれば -3〜+3 の exposureCompensation もある）ので、
  // 小数を出すかどうかは step から決める
  function formatBrightness(value) {
    return value.toFixed(brightnessCap && brightnessCap.step < 1 ? 2 : 0);
  }

  // ラベルは「ズーム」ボタンと同じく常にその時の状態を表す。
  // 値そのものは端末ごとに意味が違うので、ボタンには範囲の何 % かを出す（実値はスライダー側）
  function renderBrightnessButton() {
    if (!brightnessCap) {
      brightnessBtn.textContent = brightnessTrack ? '明るさ: 非対応' : '明るさ';
      return;
    }

    const ratio = (currentBrightness() - brightnessCap.min) / (brightnessCap.max - brightnessCap.min);
    brightnessBtn.textContent = `明るさ: ${Math.round(ratio * 100)}%`;
  }

  // スライダー脇の読み値。どのキーで調整しているかも出す（端末差の確認用）
  function renderBrightnessValue(value = currentBrightness()) {
    brightnessValueLabel.textContent = brightnessCap ? `${brightnessCap.key} ${formatBrightness(value)}` : '';
  }

  function showBrightnessPanel(open) {
    brightnessPanel.hidden = !open;
    brightnessBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function setupBrightness(track) {
    brightnessTrack = track || null;
    brightnessCap = readBrightnessCapability(brightnessTrack);
    brightnessPending = null;

    if (brightnessCap) {
      brightnessRange.min = String(brightnessCap.min);
      brightnessRange.max = String(brightnessCap.max);
      brightnessRange.step = String(brightnessCap.step);
      // 起動直後の値から始める（端末が前回の設定を覚えていることがあるので初期化はしない）。
      // step に乗らない値は <input type="range"> 側が丸めるので、丸めた結果を控える
      brightnessRange.value = String(currentBrightness(brightnessCap.min));
      brightnessValue = Number(brightnessRange.value);
    }

    brightnessBtn.disabled = !brightnessCap;
    // カメラを入れ替えると範囲も変わるので、開きっぱなしのスライダーは一度畳む
    showBrightnessPanel(false);
    renderBrightnessButton();
    renderBrightnessValue();
  }

  function clearBrightness() {
    brightnessTrack = null;
    brightnessCap = null;
    brightnessPending = null;
    brightnessBtn.disabled = true;
    showBrightnessPanel(false);
    renderBrightnessButton();
    renderBrightnessValue();
  }

  // スライダーは動かすたびに input が飛んでくるが、applyConstraints は 1 つずつしか待てない。
  // 適用中に動かされたぶんは最新の 1 つだけ覚えておき、終わってから続けて出す
  async function applyBrightness(value) {
    if (!brightnessTrack || !brightnessCap) return;

    if (brightnessApplying) {
      brightnessPending = value;
      return;
    }

    brightnessApplying = true;
    let target = value;

    try {
      while (target !== null && brightnessCap) {
        const previous = brightnessValue;

        try {
          await brightnessTrack.applyConstraints({ advanced: [{ [brightnessCap.key]: target }] });
          brightnessValue = target;
        } catch (err) {
          brightnessPending = null;
          // 待っている間にカメラが止まっていた場合は、停止のメッセージを消さない
          if (!brightnessCap) break;
          // 設定できなかった場合は直前の値に戻す
          // （ズーム・前後切替・エンジン切替と同じ扱い）
          brightnessValue = previous;
          brightnessRange.value = String(previous);
          console.warn('明るさを変更できませんでした', err);
          setStatus('明るさを変更できませんでした。');
          break;
        }

        target = brightnessPending;
        brightnessPending = null;
      }
    } finally {
      brightnessApplying = false;
      // 待っている間にカメラが止まっていれば brightnessCap は null になっている
      renderBrightnessButton();
      renderBrightnessValue();
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
      setupBrightness(videoTrack);
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

  // 押すたびにスライダーを開閉する（非対応ならボタン自体が無効）
  brightnessBtn.addEventListener('click', () => showBrightnessPanel(brightnessPanel.hidden));

  brightnessRange.addEventListener('input', () => {
    const value = Number(brightnessRange.value);
    // 反映を待たずに読み値を出す（端末が丸めたぶんは適用後に実値で上書きされる）
    renderBrightnessValue(value);
    applyBrightness(value);
  });

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
