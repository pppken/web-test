(() => {
  'use strict';

  // getUserMedia でのカメラ制御。ズームと明るさ（端末が対応している範囲だけ）も持つ。
  //
  // このファイルは DOM を探さない。<video> もコールバックも configure() で受け取り、
  // ボタン・ステータス表示・CSS クラスの付け外しは呼び出し側の責任にしてある
  // （UI を持たないので、そのまま別のページ・別のプロジェクトに持っていける）。
  //
  //   CameraController.configure({
  //     video,                       // 必須。HTMLVideoElement
  //     facingMode,                  // 省略時は保存値、無ければ 'environment'
  //     width, height,               // getUserMedia に渡す ideal 解像度
  //     storageKey,                  // 向きの保存先。null で保存しない
  //     mirrorClass,                 // フロント時に video へ付ける class。null で付けない
  //     zoomFactors,                 // ズームで巡回する倍率（等倍の何倍か）
  //     onStarting({ facingMode }),
  //     onStart({ facingMode, track, mirrored }),
  //     onStop({ silent }),
  //     onResolution({ width, height }),
  //     onZoom(state), onBrightness(state),   // state の中身は getZoomState() / getBrightnessState()
  //     onError({ code, message, error })
  //   });
  //   CameraController.start() / stop() / switchCamera() / watchPermission()
  //
  // onError の code は 'insecure-context' / 'unsupported' / 'denied' / 'blocked' /
  // 'not-found' / 'in-use' / 'unknown' / 'zoom-failed' / 'brightness-failed'。
  // message には既定の日本語も入れてあるので、そのまま出しても文言を自前で
  // 用意してもよい。
  //
  // mirrorClass を使う場合は、呼び出し側の CSS に
  //   #video.mirrored { transform: scaleX(-1); }
  // 相当を用意すること。映像データ自体は反転していないので、撮影側（photo.js）は
  // facingMode を見て別途反転させる。

  const DEFAULT_FACING_MODE = 'environment'; // 既定はリアカメラ ('user' = フロント)
  const DEFAULT_STORAGE_KEY = 'cameraFacingMode';
  const DEFAULT_MIRROR_CLASS = 'mirrored';

  // getUserMedia に渡す解像度。ideal なので、対応していない端末では別の解像度に落ちる
  const DEFAULT_WIDTH = 1920;
  const DEFAULT_HEIGHT = 1080;

  // ズームで巡回する倍率。実際に使えるのは端末が getCapabilities().zoom で
  // 返した範囲に収まるものだけで、外れたぶんは起動時にふるい落とす。
  // zoom の値は端末によって尺度が違う（1〜8 で返すものもあれば 100〜400 で返すものもある）ので、
  // 絶対値ではなく min（＝等倍）の何倍かで持つ
  const ZOOM_FACTORS = [1, 2, 3, 5];

  // 明るさとして使う capabilities のキー。先に見つかったほうを使う。
  // Android Chrome は brightness を持たず exposureCompensation だけを返すことが多く、
  // 逆に PC の UVC カメラは brightness を返す。どちらも尺度も意味も端末任せなので、
  // 値はこちらで換算せず、端末が返した範囲をそのまま呼び出し側に渡す
  const BRIGHTNESS_KEYS = ['brightness', 'exposureCompensation'];

  // step を返さない端末で、刻みを作るための段数
  const BRIGHTNESS_STEPS = 100;

  // onError の既定の文言。呼び出し側は code だけを見て自前の文言を出してもよい
  const MESSAGES = {
    'insecure-context': 'https:// か http://localhost で開いてください。',
    unsupported: 'このブラウザはカメラに対応していません。',
    denied: 'カメラの使用が拒否されました。ブラウザの権限設定を確認してください。',
    blocked: 'カメラがブロックされています。アドレスバーのアイコンから許可してください。',
    'not-found': '指定した向きのカメラが見つかりませんでした。',
    'in-use': 'カメラが他のアプリで使用中の可能性があります。',
    unknown: 'カメラを起動できませんでした。',
    'zoom-failed': 'ズームを変更できませんでした。',
    'brightness-failed': '明るさを変更できませんでした。'
  };

  const config = {
    video: null,
    facingMode: null,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    storageKey: DEFAULT_STORAGE_KEY,
    mirrorClass: DEFAULT_MIRROR_CLASS,
    zoomFactors: ZOOM_FACTORS,
    onStarting: null,
    onStart: null,
    onStop: null,
    onResolution: null,
    onZoom: null,
    onBrightness: null,
    onError: null
  };

  let stream = null;
  let facingMode = DEFAULT_FACING_MODE;
  let configured = false;

  let zoomTrack = null;  // ズームを適用する映像トラック（= 再生中のもの）
  let zoomLevels = [];   // 実際に設定できる zoom の値（昇順。先頭は min ＝ 等倍）
  let zoomIndex = 0;
  let zoomBusy = false;

  let brightnessTrack = null;    // 明るさを適用する映像トラック（= 再生中のもの）
  let brightnessCap = null;      // { key, min, max, step }。非対応なら null
  let brightnessValue = 0;       // 最後に適用できた値
  let brightnessPending = null;  // 適用中に動かされたぶん（最新の 1 つだけ持つ）
  let brightnessApplying = false;

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

  function fail(code, error) {
    emit('onError', { code, message: MESSAGES[code] || MESSAGES.unknown, error: error || null });
  }

  // 前回選択したカメラの向きを復元する。
  // プライベートモードや file:// では localStorage が使えないことがあるので握りつぶす
  function loadFacingMode() {
    if (!config.storageKey) return DEFAULT_FACING_MODE;

    try {
      const saved = localStorage.getItem(config.storageKey);
      if (saved === 'user' || saved === 'environment') return saved;
    } catch (err) {
      console.warn('カメラ設定の読み込みに失敗しました', err);
    }
    return DEFAULT_FACING_MODE;
  }

  function saveFacingMode(mode) {
    if (!config.storageKey) return;

    try {
      localStorage.setItem(config.storageKey, mode);
    } catch (err) {
      console.warn('カメラ設定の保存に失敗しました', err);
    }
  }

  function configure(options = {}) {
    Object.assign(config, options);

    if (!config.video) throw new Error('CameraController.configure: video が必要です。');

    facingMode = options.facingMode || loadFacingMode();
    configured = true;

    // 停止中の状態（いずれも「非対応」）を一度流しておく。
    // 呼び出し側はこれでボタンの初期表示を決められる
    emitZoom();
    emitBrightness();
  }

  function ensureConfigured() {
    if (!configured) throw new Error('CameraController: 先に configure() を呼んでください。');
  }

  function currentTrack() {
    return stream ? stream.getVideoTracks()[0] || null : null;
  }

  // 実際に再生中の解像度を伝える
  function emitResolution() {
    if (!stream) return;

    emit('onResolution', { width: config.video.videoWidth, height: config.video.videoHeight });
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

  // zoomFactors を、その端末で実際に設定できる値の並びに落とし込む。
  // 範囲を超えたぶんは max に丸められて前の段と重なるので、増える段だけを残す
  // （例: max が 2.5 倍までの端末なら 1x / 2x / 2.5x の 3 段になる）
  function buildZoomLevels(zoom) {
    const levels = [];

    for (const factor of config.zoomFactors) {
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

  // 起動直後から等倍以外で始まる端末があるので、いまの倍率に一番近い段から巡回を始める
  function nearestZoomIndex(value) {
    let index = 0;

    zoomLevels.forEach((level, i) => {
      if (Math.abs(level - value) < Math.abs(zoomLevels[index] - value)) index = i;
    });

    return index;
  }

  // 呼び出し側がボタンの表示を決めるのに要るものを全部入れて渡す。
  // factor は min を等倍としたときの倍率（zoom の絶対値は端末ごとに尺度が違う）
  function getZoomState() {
    if (!zoomLevels.length) {
      return { supported: false, running: Boolean(zoomTrack), busy: zoomBusy, levels: [], index: 0, value: null, factor: null };
    }

    const value = currentZoom();

    return {
      supported: true,
      running: true,
      busy: zoomBusy,
      levels: zoomLevels.slice(),
      index: zoomIndex,
      value,
      factor: value / zoomLevels[0]
    };
  }

  function emitZoom() {
    emit('onZoom', getZoomState());
  }

  function setupZoom(track) {
    zoomTrack = track || null;
    zoomIndex = 0;
    zoomBusy = false;

    const zoom = readZoomCapability(zoomTrack);
    zoomLevels = zoom ? buildZoomLevels(zoom) : [];
    // 段が 1 つしか作れない端末はズームしても何も変わらないので非対応と同じ扱いにする
    if (zoomLevels.length < 2) zoomLevels = [];
    if (zoomLevels.length) zoomIndex = nearestZoomIndex(currentZoom());

    emitZoom();
  }

  function clearZoom() {
    zoomTrack = null;
    zoomLevels = [];
    zoomIndex = 0;
    zoomBusy = false;
    emitZoom();
  }

  // 押すたびに 1.0x -> 2.0x -> ... と巡回し、最大まで行ったら等倍に戻る
  async function zoomNext() {
    if (!zoomTrack || zoomLevels.length === 0) return;

    const previous = zoomIndex;
    zoomIndex = (zoomIndex + 1) % zoomLevels.length;

    zoomBusy = true;
    emitZoom();

    try {
      await zoomTrack.applyConstraints({ advanced: [{ zoom: zoomLevels[zoomIndex] }] });
      emitResolution();
    } catch (err) {
      // 設定できなかった場合は選択を戻し、直前の倍率のまま使い続ける
      // （前後切替・エンジン切替と同じ扱い）
      zoomIndex = previous;
      console.warn('ズームを変更できませんでした', err);
      fail('zoom-failed', err);
    } finally {
      // 待っている間にカメラが止まっていれば zoomLevels は空になっている
      zoomBusy = false;
      emitZoom();
    }
  }

  // --- 明るさ -----------------------------------------------------------

  // 端末が調整できる明るさの範囲を読む。ズームと同じで、指定できる値はこちらで決めず、
  // capabilities が返した { min, max, step } をそのまま呼び出し側に渡す
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

  // 端末が受け付ける値に丸める（ズームの snapZoom と同じ）。
  // 以前は <input type="range"> の丸めに任せていたが、UI を持たなくなったので自前で行う
  function snapBrightness(value) {
    if (!brightnessCap) return value;

    const { min, max, step } = brightnessCap;
    const stepped = step > 0 ? min + Math.round((value - min) / step) * step : value;

    return Math.min(Math.max(stepped, min), max);
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

  // 呼び出し側がスライダーを作るのに要るものを全部入れて渡す。
  // 値の尺度は端末ごとに違うので換算はしない（ボタンに出す % 用に ratio だけ添える）。
  //
  // reason は呼び出し側が「スライダーのつまみを書き戻してよい場面か」を見分けるためのもの。
  //   'setup'    起動・前後切替。範囲ごと作り直す
  //   'applied'  適用できた。つまみは既に指の位置にあるので動かさない
  //   'failed'   適用できず直前の値に戻した。つまみも戻す
  //   'idle'     停止中
  // 'applied' でも毎回書き戻すと、適用を待っている間に動かされたぶんを巻き戻して
  // しまい、指を離すまでつまみが引っかかったように見える
  function getBrightnessState(reason = 'idle') {
    if (!brightnessCap) {
      return { supported: false, running: Boolean(brightnessTrack), reason, key: null, min: 0, max: 0, step: 0, value: null, ratio: null };
    }

    const value = currentBrightness();

    return {
      supported: true,
      running: true,
      reason,
      key: brightnessCap.key,
      min: brightnessCap.min,
      max: brightnessCap.max,
      step: brightnessCap.step,
      value,
      ratio: (value - brightnessCap.min) / (brightnessCap.max - brightnessCap.min)
    };
  }

  function emitBrightness(reason) {
    emit('onBrightness', getBrightnessState(reason));
  }

  function setupBrightness(track) {
    brightnessTrack = track || null;
    brightnessCap = readBrightnessCapability(brightnessTrack);
    brightnessPending = null;

    // 起動直後の値から始める（端末が前回の設定を覚えていることがあるので初期化はしない）
    if (brightnessCap) brightnessValue = snapBrightness(currentBrightness(brightnessCap.min));

    emitBrightness('setup');
  }

  function clearBrightness() {
    brightnessTrack = null;
    brightnessCap = null;
    brightnessPending = null;
    emitBrightness('idle');
  }

  // スライダーは動かすたびに値が飛んでくるが、applyConstraints は 1 つずつしか待てない。
  // 適用中に動かされたぶんは最新の 1 つだけ覚えておき、終わってから続けて出す
  async function setBrightness(value) {
    if (!brightnessTrack || !brightnessCap) return;

    const snapped = snapBrightness(Number(value));

    if (brightnessApplying) {
      brightnessPending = snapped;
      return;
    }

    brightnessApplying = true;
    let target = snapped;
    let reason = 'applied';

    try {
      while (target !== null && brightnessCap) {
        const previous = brightnessValue;

        try {
          await brightnessTrack.applyConstraints({ advanced: [{ [brightnessCap.key]: target }] });
          brightnessValue = target;
        } catch (err) {
          brightnessPending = null;
          // 待っている間にカメラが止まっていた場合は、停止を上書きするような通知はしない
          if (!brightnessCap) break;
          // 設定できなかった場合は直前の値に戻す
          // （ズーム・前後切替・エンジン切替と同じ扱い）
          brightnessValue = previous;
          reason = 'failed';
          console.warn('明るさを変更できませんでした', err);
          fail('brightness-failed', err);
          break;
        }

        target = brightnessPending;
        brightnessPending = null;
      }
    } finally {
      brightnessApplying = false;
      // 待っている間にカメラが止まっていれば brightnessCap は null になっている
      emitBrightness(brightnessCap ? reason : 'idle');
    }
  }

  // --- 起動と停止 -------------------------------------------------------

  async function startCamera() {
    ensureConfigured();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      fail('unsupported');
      return;
    }

    stopCamera({ silent: true });
    emit('onStarting', { facingMode });

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: config.width },
          height: { ideal: config.height }
        },
        audio: false
      });

      config.video.srcObject = stream;
      await config.video.play();

      // フロントカメラのときだけ鏡像表示にする（映像データ自体は反転していない）
      if (config.mirrorClass) {
        config.video.classList.toggle(config.mirrorClass, facingMode === 'user');
      }

      // 起動に成功した向きだけを次回用に保存する
      saveFacingMode(facingMode);

      const videoTrack = stream.getVideoTracks()[0];

      setupZoom(videoTrack);
      setupBrightness(videoTrack);

      emit('onStart', { facingMode, track: videoTrack, mirrored: facingMode === 'user' });
      emitResolution();
    } catch (err) {
      handleError(err);
    }
  }

  function stopCamera(options = {}) {
    if (!stream) return;

    stream.getTracks().forEach((track) => track.stop());
    stream = null;
    config.video.srcObject = null;

    clearZoom();
    clearBrightness();

    // silent は「停止した旨をわざわざ知らせるほどではない」という印でしかない
    // （前後切替の途中やページ離脱時）。解放そのものは常に知らせないと、
    // 呼び出し側が読み取りや撮影を止め損ねる
    emit('onStop', { silent: Boolean(options.silent) });
  }

  async function switchCamera() {
    ensureConfigured();

    const previous = facingMode;
    facingMode = facingMode === 'environment' ? 'user' : 'environment';

    await startCamera();

    // 切替に失敗した場合は元の向きに戻す
    if (!stream) facingMode = previous;
  }

  function handleError(err) {
    stream = null;

    switch (err.name) {
      case 'NotAllowedError':
        fail('denied', err);
        break;
      case 'NotFoundError':
      case 'OverconstrainedError':
        fail('not-found', err);
        break;
      case 'NotReadableError':
        fail('in-use', err);
        break;
      default:
        emit('onError', {
          code: 'unknown',
          message: `エラー: ${err.name} - ${err.message}`,
          error: err
        });
    }

    console.error(err);
    // 直前に onError を出しているので、停止そのものは黙って知らせる
    // （呼び出し側がエラーの表示を上書きしないように）
    emit('onStop', { silent: true });
  }

  // --- 権限 -------------------------------------------------------------

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

  // 許可済みなら起動し、あとから許可されたときも起動する。
  // 安全なコンテキストでない場合はここで打ち切る（ブラウザが権限を永続化しないため、
  // 起動できても毎回ダイアログが出る）
  async function watchPermission() {
    ensureConfigured();

    if (!window.isSecureContext) {
      emit('onError', {
        code: 'insecure-context',
        message:
          `${location.protocol}// では権限が保存されません。https:// か http://localhost で開いてください。`,
        error: null
      });
      return;
    }

    const permission = await queryCameraPermission();
    if (!permission) return;

    // 許可済みならダイアログは出ないので、そのまま起動する
    if (permission.state === 'granted') {
      startCamera();
    } else if (permission.state === 'denied') {
      fail('blocked');
    }

    permission.addEventListener('change', () => {
      if (permission.state === 'granted' && !stream) startCamera();
    });
  }

  // 解像度が確定／変化したタイミングで伝える。
  // configure() より前に読み込まれても困らないよう、window 側で受けてから video を見る
  window.addEventListener(
    'loadedmetadata',
    (event) => {
      if (event.target === config.video) emitResolution();
    },
    true
  );

  window.addEventListener(
    'resize',
    (event) => {
      if (event.target === config.video) emitResolution();
    },
    true
  );

  // ページを離れるときにカメラを確実に解放する
  window.addEventListener('pagehide', () => stopCamera({ silent: true }));

  window.CameraController = {
    configure,
    start: startCamera,
    stop: stopCamera,
    switchCamera,
    watchPermission,
    zoomNext,
    setBrightness,
    getZoomState,
    getBrightnessState,
    isRunning: () => Boolean(stream),
    getFacingMode: () => facingMode,
    getTrack: currentTrack
  };
})();
