(() => {
  'use strict';

  // このページ固有の配線。DOM を探すのはこのファイルだけで、
  // js/ のライブラリは要素もコールバックも configure() で受け取る。
  //
  // ここにあるもの:
  //   - 要素の取得と、ボタンのイベント
  //   - ステータス・エンジンバッジ・各ボタンのラベル（日本語の文言は全部ここ）
  //   - 3 つのダイアログ（結果 / 撮影 / 検出画像）と、その開閉に合わせた解析の停止と再開
  //   - #frame.idle の付け外し
  //
  // ライブラリはそれぞれ独立していて、互いを参照しない。
  // 組み合わせるのはこのファイルの役目（カメラのフレームを barcode.js の detect に渡す、
  // カメラが起動したら読み取りと撮影の準備をする、など）。

  const LABEL_RESET_MS = 1500;

  // エンジンの選択値 -> ボタンに出す表示。barcode.js は値だけを扱い、表示はこちらが持つ
  const ENGINE_LABELS = {
    auto: '自動',
    zxing: 'ZXing',
    'zxing-cpp': 'ZXing-C++',
    quagga: 'Quagga2'
  };

  // 撮影がどちらの経路を通ったか（photo.js の method）
  const PHOTO_METHOD_LABELS = {
    still: '静止画撮影',
    frame: 'フレーム取得'
  };

  const CAMERA_LABELS = {
    environment: 'リアカメラ',
    user: 'フロントカメラ'
  };

  const $ = (id) => document.getElementById(id);

  const frame = $('frame');
  const video = $('video');
  const scanArea = $('scanArea');
  const flash = $('flash');
  const status = $('status');
  const engineLabel = $('engine');

  const startBtn = $('startBtn');
  const stopBtn = $('stopBtn');
  const switchBtn = $('switchBtn');
  const shutterBtn = $('shutterBtn');
  const engineBtn = $('engineBtn');
  const zoomBtn = $('zoomBtn');
  const brightnessBtn = $('brightnessBtn');
  const brightnessPanel = $('brightnessPanel');
  const brightnessRange = $('brightnessRange');
  const brightnessValueLabel = $('brightnessValue');
  const previewBtn = $('scanPreviewBtn');

  const resultDialog = $('result');
  const resultTitle = $('resultTitle');
  const resultFormat = $('resultFormat');
  const resultValue = $('resultValue');
  const resultCopyBtn = $('resultCopyBtn');
  const resultCloseBtn = $('resultCloseBtn');

  const photoDialog = $('photo');
  const photoImage = $('photoImage');
  const photoInfo = $('photoInfo');
  const photoSaveBtn = $('photoSaveBtn');
  const photoShareBtn = $('photoShareBtn');
  const photoCloseBtn = $('photoCloseBtn');

  const previewDialog = $('scanPreview');
  const previewImage = $('scanPreviewImage');
  const previewInfo = $('scanPreviewInfo');
  const previewCloseBtn = $('scanPreviewCloseBtn');

  // どれかの js の読み込みに失敗しても、残りは動き続けるようにする。
  // 従来からある方針で、意図的なもの（片方が欠けてもカメラ単体・撮影単体は使える）
  const camera = window.CameraController || {
    configure() {}, start() {}, stop() {}, switchCamera() {}, watchPermission() {},
    zoomNext() {}, setBrightness() {}, pauseScan() {}, resumeScan() {},
    isScanPaused: () => false, isRunning: () => false, getFacingMode: () => 'environment', getTrack: () => null
  };

  const scanner = window.BarcodeScanner || {
    configure() {}, start() {}, stop() {}, detect: () => Promise.resolve(null),
    setEngine() {}, nextEngine() {}, capturePreview: () => Promise.resolve(null),
    getEngineState: () => ({ status: 'idle' }), getEngineChoices: () => [], isActive: () => false
  };

  const photo = window.PhotoCapture || {
    configure() {}, attach() {}, detach() {}, capture: () => Promise.resolve(null),
    isActive: () => false, isBusy: () => false
  };

  let facingMode = 'environment';
  let resolution = null;
  let brightnessKey = '';
  let brightnessStep = 1;
  let photoUrl = null;   // 撮影結果の objectURL。photo.js は作らないのでこちらで持つ
  let photoFile = null;

  // --- 表示の細ごと -----------------------------------------------------

  function setStatus(message) {
    status.textContent = message;
  }

  // ボタンのラベルを一時的に差し替える（原文は dataset.label に退避する）。
  // タイマーはボタンごとに持つ（別のボタンを押したときに巻き戻らないように）
  const labelTimers = new Map();

  function setLabel(button, text) {
    const original = button.dataset.label || button.textContent;
    button.dataset.label = original;
    button.textContent = text;

    clearTimeout(labelTimers.get(button));
    labelTimers.set(
      button,
      setTimeout(() => {
        button.textContent = original;
        labelTimers.delete(button);
      }, LABEL_RESET_MS)
    );
  }

  function resetLabel(button) {
    clearTimeout(labelTimers.get(button));
    labelTimers.delete(button);
    button.textContent = button.dataset.label || button.textContent;
  }

  // <dialog> 非対応ブラウザでも最低限は表示されるようにしておく
  function openDialog(dialog) {
    if (dialog.open) return;

    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');

    syncScanning();
  }

  // 結果・撮影・検出画像のどれかを開いている間は解析を止める。
  // 解析を続けるとモーダルが重なってしまう（barcode.js 側はこの判断をしない）
  function anyDialogOpen() {
    return resultDialog.open || photoDialog.open || previewDialog.open;
  }

  function syncScanning() {
    if (anyDialogOpen()) camera.pauseScan();
    else camera.resumeScan();
  }

  function setRunning(running) {
    startBtn.disabled = running;
    stopBtn.disabled = !running;
    switchBtn.disabled = !running;
    // 停止中は枠を画面いっぱいに広げ、ボタンが潰れないようにする
    frame.classList.toggle('idle', !running);
  }

  function renderStatus() {
    const label = CAMERA_LABELS[facingMode] || '';
    if (!resolution || !resolution.width) {
      setStatus(label);
      return;
    }

    setStatus(`${label}  ${resolution.width} × ${resolution.height}`);
  }

  function renderShutter() {
    shutterBtn.disabled = !photo.isActive() || photo.isBusy() || photoDialog.open;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  // --- エンジン ---------------------------------------------------------

  // 右上のバッジ。'エンジン名 · N/s' を出す動作確認用の表示で、
  // 0/s ならループが回っていない（デバッグの第一手）
  function renderEngineBadge(state) {
    if (state.status === 'idle') {
      engineLabel.textContent = '';
      return;
    }

    if (state.status === 'error') {
      engineLabel.textContent = '解析エラー（コンソール参照）';
      return;
    }

    if (state.status === 'loading') {
      engineLabel.textContent = state.name ? `${state.name} 読み込み中…` : '準備中…';
      return;
    }

    const rate = state.rate === null ? state.name : `${state.name} · ${state.rate}/s`;
    // 前処理の A/B 比較中だけ、検出率の途中経過を足す
    engineLabel.textContent = isBenchmarking() ? `${rate} · ${formatStats()}` : rate;
  }

  // 「エンジン」ボタンのラベルは常にその時の選択を表すので、setLabel() は通さない。
  // HTML 側の文字列は app.js が読めなかったときの見た目でしかない
  function renderEngineButton(state) {
    engineBtn.textContent = `エンジン: ${ENGINE_LABELS[state.choice] || state.choice}`;
    engineBtn.disabled = state.busy;
  }

  function handleEngineChange(state) {
    renderEngineBadge(state);
    renderEngineButton(state);
    previewBtn.disabled = !state.active;
  }

  // --- ズーム -----------------------------------------------------------

  // ラベルは常にその時の状態を表す。倍率は等倍（min）の何倍かで出す
  // （zoom の絶対値は端末ごとに尺度が違うため）
  function handleZoomChange(state) {
    if (!state.supported) {
      zoomBtn.textContent = state.running ? 'ズーム: 非対応' : 'ズーム';
      zoomBtn.disabled = true;
      return;
    }

    zoomBtn.textContent = `ズーム: ${state.factor.toFixed(1)}x`;
    zoomBtn.disabled = state.busy;
  }

  // --- 明るさ -----------------------------------------------------------

  // 尺度が端末ごとに違う（0〜255 の brightness もあれば -3〜+3 の exposureCompensation も
  // ある）ので、小数を出すかどうかは step から決める
  function formatBrightness(value) {
    return value.toFixed(brightnessStep < 1 ? 2 : 0);
  }

  // スライダー脇の読み値。どのキーで調整しているかも出す（端末差の確認用）
  function renderBrightnessValue(value) {
    brightnessValueLabel.textContent =
      brightnessKey && value !== null ? `${brightnessKey} ${formatBrightness(value)}` : '';
  }

  function showBrightnessPanel(open) {
    brightnessPanel.hidden = !open;
    brightnessBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    // 前処理のパネルと同じ場所（ボタンの上の行）に出るので、開くときは向こうを畳む
    if (open && preprocessEnabled) showPreprocessPanel(false);
  }

  function handleBrightnessChange(state) {
    brightnessKey = state.key || '';
    brightnessStep = state.step || 1;

    if (!state.supported) {
      brightnessBtn.textContent = state.running ? '明るさ: 非対応' : '明るさ';
      brightnessBtn.disabled = true;
      showBrightnessPanel(false);
      renderBrightnessValue(null);
      return;
    }

    // ボタンには範囲の何 % かを出す（実値の尺度は端末ごとに違って倍率のようには読めない）
    brightnessBtn.textContent = `明るさ: ${Math.round(state.ratio * 100)}%`;
    brightnessBtn.disabled = false;

    // つまみを書き戻すのは、範囲ごと作り直したときと、適用に失敗して戻したときだけ。
    // 適用できたぶんまで毎回書き戻すと、待っている間に動かされたぶんを巻き戻してしまう
    if (state.reason === 'setup') {
      brightnessRange.min = String(state.min);
      brightnessRange.max = String(state.max);
      brightnessRange.step = String(state.step);
      brightnessRange.value = String(state.value);
      // カメラを入れ替えると範囲も変わるので、開きっぱなしのスライダーは一度畳む
      showBrightnessPanel(false);
    } else if (state.reason === 'failed') {
      brightnessRange.value = String(state.value);
      setStatus('明るさを変更できませんでした。');
    }

    renderBrightnessValue(state.value);
  }

  // --- 結果のダイアログ -------------------------------------------------

  function showResult(result) {
    resultDialog.classList.remove('error');
    resultTitle.textContent = 'バーコードを検出しました';
    resultFormat.textContent = result.format || '';
    resultValue.textContent = result.text;
    // クリップボードは安全なコンテキストでしか使えない
    resultCopyBtn.hidden = !(navigator.clipboard && navigator.clipboard.writeText);
    openDialog(resultDialog);
  }

  function showError(message) {
    resultDialog.classList.add('error');
    resultTitle.textContent = 'バーコードを読み取れません';
    resultFormat.textContent = '';
    resultValue.textContent = message;
    resultCopyBtn.hidden = true;
    openDialog(resultDialog);
  }

  async function copyValue() {
    try {
      await navigator.clipboard.writeText(resultValue.textContent);
      setLabel(resultCopyBtn, 'コピーしました');
    } catch (err) {
      console.warn('クリップボードへのコピーに失敗しました', err);
      setLabel(resultCopyBtn, 'コピーできません');
    }
  }

  resultCopyBtn.addEventListener('click', copyValue);
  resultCloseBtn.addEventListener('click', () => resultDialog.close());

  // Esc でもボタンでも、閉じたらスキャンを再開する。
  // 同じバーコードが枠内に残っていれば、そのまますぐ読み直す
  resultDialog.addEventListener('close', () => {
    resetLabel(resultCopyBtn);
    syncScanning();
  });

  // --- 検出画像のダイアログ（動作確認用）--------------------------------

  // 解析に渡しているのと同じ画像を、そのままダイアログに出す。
  // 枠のズレや余白の付き方、縮小後にバーが潰れていないかをその場で確認する
  async function showPreview() {
    // 前処理の出力は capturePreview() より先に取る（あちらが前処理の画像を作り直すため）
    const output = preprocessOutput();
    const preview = await scanner.capturePreview();
    if (!preview) {
      setLabel(previewBtn, '取得できません');
      return;
    }

    // 前処理が作った画像なら、余白の幅は前処理側の検証用データに入っている
    const debug = preprocessDebug();
    const pad = preview.filtered && debug && debug.steps.pad ? debug.steps.pad.padX : 0;

    previewInfo.textContent =
      `${preview.width} × ${preview.height}` +
      (preview.filtered ? '（前処理の出力）' : '') +
      (pad ? `（うち左右 ${pad}px は白の余白）` : '');
    // 解析に渡すのと同じ画素をそのまま見たいので、非可逆な形式にはしない
    previewImage.src = preview.canvas.toDataURL('image/png');

    renderPreprocessOutput(output);
    renderPreprocessDebug(debug);

    openDialog(previewDialog);
  }

  previewBtn.addEventListener('click', showPreview);
  previewCloseBtn.addEventListener('click', () => previewDialog.close());

  previewDialog.addEventListener('close', () => {
    // data URL を抱えたままにしない
    previewImage.removeAttribute('src');
    previewOutputImage.removeAttribute('src');
    syncScanning();
  });

  // --- 前処理（js/barcode-preprocess.js。検討中）--------------------------
  //
  // 前処理にまつわるページ側の配線はこの節にまとめてある。有効にするのは
  // 「組み立て」の setupPreprocess() の 1 行で、それを消せば前処理は一切動かない
  // （ボタンも出ない）。完全に外すときは、この節と setupPreprocess() の行、
  // showBrightnessPanel() の中の showPreprocessPanel() の呼び出し、
  // index.html の #preprocessBtn / #preprocessPanel / #scanOutput / #scanWave / #scanWaveInfo / #scanLocate と
  // ローダの 1 行、js/barcode-preprocess.js を消す。
  //
  // 前処理は段を並べたパイプラインで、「前処理」ボタンで開くパネルのチェックボックスで
  // 段ごとに有効・無効を切り替える（全部外すと前処理なし）。
  // A/B 比較は前処理ありと無しを 1 フレームおきに交互に回して検出率を比べる計測用で、
  // このときだけ結果ダイアログを出さない（止まると数が溜まらない）

  // 段 -> パネルに出す名前
  const PREPROCESS_STAGE_LABELS = {
    locate: '領域検出',
    contrast: 'コントラスト調整',
    aggregate: '縦集約',
    pad: '余白'
  };

  // 段 -> ボタンのラベルに並べる短い名前
  const PREPROCESS_STAGE_SHORT = {
    locate: '領域',
    contrast: 'コントラスト',
    aggregate: '集約',
    pad: '余白'
  };

  // 段の方式 -> 表示
  const PREPROCESS_METHOD_LABELS = {
    stretch: 'stretch',
    clahe: 'CLAHE',
    median: '中央値',
    mean: '平均',
    trimmed: 'トリム平均'
  };

  // パイプラインの入力 -> 表示
  const PREPROCESS_INPUT_LABELS = {
    plain: '素通しの画像',
    rows: '縦に潰した取り込み',
    locate: '領域検出の切り出し'
  };

  const preprocessBtn = $('preprocessBtn');
  const preprocessPanel = $('preprocessPanel');
  const preprocessStages = $('preprocessStages');
  const previewOutput = $('scanOutput');
  const previewOutputImage = $('scanOutputImage');
  const previewOutputInfo = $('scanOutputInfo');
  const previewWave = $('scanWave');
  const previewWaveInfo = $('scanWaveInfo');
  const previewLocate = $('scanLocate');

  const preprocess = window.BarcodePreprocess || {
    configure() {}, filter: null, setStage() {}, setMethod() {}, setCompare() {},
    getState: () => ({ stages: [], active: false, compare: false, debug: null, stats: null }),
    getStages: () => [], getMethods: () => [], getLastOutput: () => null
  };

  let preprocessEnabled = false;

  // パネルの入力欄。段 -> { checkbox, select }（select は方式を選べる段だけ）
  const preprocessInputs = new Map();
  let preprocessCompareInput = null;

  function setupPreprocess() {
    if (!window.BarcodePreprocess) return;
    preprocessEnabled = true;

    // 表示の onChange より先にパネルを作っておく（configure() が初期状態を流してくる）
    buildPreprocessPanel();

    preprocess.configure({
      onChange: (state) => {
        renderPreprocess(state);
        // A/B 比較の間は結果ダイアログを出さない。1 枚読めたところで止まってしまうと
        // 検出率が溜まらないため、autoPause ごと切る
        camera.configure({ autoPause: !state.compare });
        renderEngineBadge(scanner.getEngineState());
      }
    });

    // barcode.js への差し込みはここだけ
    scanner.configure({ frameFilter: preprocess.filter });

    preprocessBtn.hidden = false;
    // 押すたびにパネルを開閉する。エンジンと同じくカメラの状態に依らず押せる
    preprocessBtn.addEventListener('click', () => showPreprocessPanel(preprocessPanel.hidden));
  }

  function createCheckboxRow(text) {
    const row = document.createElement('div');
    row.className = 'preprocess-row';

    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    label.append(checkbox, text);
    row.append(label);

    return { row, checkbox };
  }

  // 段ごとのチェックボックス（と方式の選択）を、前処理が返す段の並び（＝掛ける順）で作る
  function buildPreprocessPanel() {
    for (const stage of preprocess.getStages()) {
      const text = PREPROCESS_STAGE_LABELS[stage] || stage;
      const { row, checkbox } = createCheckboxRow(text);
      checkbox.addEventListener('change', () => preprocess.setStage(stage, checkbox.checked));

      let select = null;
      const methods = preprocess.getMethods(stage);
      if (methods.length) {
        select = document.createElement('select');
        select.setAttribute('aria-label', `${text}の方式`);
        for (const method of methods) {
          const option = document.createElement('option');
          option.value = method;
          option.textContent = PREPROCESS_METHOD_LABELS[method] || method;
          select.append(option);
        }
        select.addEventListener('change', () => preprocess.setMethod(stage, select.value));
        row.append(select);
      }

      preprocessStages.append(row);
      preprocessInputs.set(stage, { checkbox, select });
    }

    const { row, checkbox } = createCheckboxRow('A/B 比較（素通しと 1 フレームおきに交互）');
    row.classList.add('compare');
    checkbox.addEventListener('change', () => preprocess.setCompare(checkbox.checked));
    preprocessStages.append(row);
    preprocessCompareInput = checkbox;
  }

  // パネルの入力欄と「前処理」ボタンのラベルを、いまの選択に合わせる。
  // ボタンのラベルは常にその時の選択を表す（エンジンと同じく setLabel() は通さない）
  function renderPreprocess(state) {
    for (const [stage, { checkbox, select }] of preprocessInputs) {
      checkbox.checked = state.stages.includes(stage);
      if (select) select.value = state[stage];
    }
    if (preprocessCompareInput) preprocessCompareInput.checked = state.compare;

    const names = state.stages.map((stage) => PREPROCESS_STAGE_SHORT[stage] || stage);
    preprocessBtn.textContent =
      `前処理: ${names.length ? names.join('+') : 'なし'}${state.compare ? '（A/B）' : ''}`;
  }

  // 明るさのスライダーと同じ場所（ボタンの上の行）に出るので、開くときは向こうを畳む
  function showPreprocessPanel(open) {
    preprocessPanel.hidden = !open;
    preprocessBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) showBrightnessPanel(false);
  }

  function isBenchmarking() {
    return preprocessEnabled && preprocess.getState().compare;
  }

  function preprocessDebug() {
    if (!preprocessEnabled) return null;
    const state = preprocess.getState();
    return state.active ? state.debug : null;
  }

  // 前処理が最後に解析へ渡した画像（の写し）。barcode.js を通さず前処理から直接もらう。
  // 検出画像のボタンを押したときに解析の途中だと、capturePreview() は前処理に回さず
  // 素通しの画像を返すので、そちらだけでは前処理の出力が見られないことがある
  function preprocessOutput() {
    if (!preprocessEnabled || !preprocess.getState().active) return null;
    return preprocess.getLastOutput();
  }

  function stageNames(stages) {
    return stages.map((stage) => PREPROCESS_STAGE_LABELS[stage] || stage).join(' → ');
  }

  function renderPreprocessOutput(output) {
    if (!output) {
      previewOutput.hidden = true;
      previewOutputImage.removeAttribute('src');
      previewOutputInfo.textContent = '';
      return;
    }

    previewOutput.hidden = false;
    // 解析に渡したのと同じ画素を見たいので、非可逆な形式にはしない
    previewOutputImage.src = output.canvas.toDataURL('image/png');

    const age = ((performance.now() - output.time) / 1000).toFixed(1);
    const what = output.preview ? '前回の表示用に作った画像' : '解析へ渡した画像';
    previewOutputInfo.textContent =
      `前処理の出力（${stageNames(output.stages)}・${age} 秒前に${what}）` +
      `　${output.width} × ${output.height}` +
      (output.pad ? `（うち左右 ${output.pad}px は白の余白）` : '（余白なし）') +
      '　等倍表示。はみ出すときは横にスクロールできます';
  }

  // A/B 比較の途中経過。前処理あり／なしそれぞれの「解析した回数のうち読めた割合」
  function formatStats() {
    const stats = preprocess.getState().stats;
    if (!stats) return '';
    const pct = (bucket) =>
      bucket && bucket.tries ? `${Math.round((bucket.hits / bucket.tries) * 100)}%` : '–';
    return `前 ${pct(stats.pre)} / 素 ${pct(stats.plain)}`;
  }

  // 前処理の検証用データを、検出画像ダイアログに出す。
  // 領域検出の重ね描き・縦集約の波形（それぞれの段を通ったときだけ）と、段ごとの結果を 1 行ずつ
  function renderPreprocessDebug(debug) {
    renderLocate(debug && debug.locate);
    renderWave(debug && debug.wave);
    previewWaveInfo.textContent = debug ? describePipeline(debug) : '';
  }

  // 縦集約した 1 次元波形の表示（前処理の検証用）。
  // X 座標・輝度・しきい値・黒白の判定を 1 枚に重ねて出す。
  // 縦集約が実際にどう効いているかは、この波形を見るのが一番早い
  function renderWave(wave) {
    if (!wave || !wave.profile) {
      previewWave.hidden = true;
      return;
    }

    previewWave.hidden = false;

    const profile = wave.profile;
    const width = profile.length;
    const height = 140;
    if (previewWave.width !== width || previewWave.height !== height) {
      previewWave.width = width;
      previewWave.height = height;
    }

    const ctx = previewWave.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);

    const at = (i) => (typeof wave.threshold === 'number' ? wave.threshold : wave.threshold[i]);
    const y = (v) => height - 1 - (v / 255) * (height - 1);

    // 黒と判定された区間を先に塗る（波形の下敷きにする）
    ctx.fillStyle = 'rgba(45, 127, 249, 0.18)';
    for (let i = 0; i < width; i++) {
      if (profile[i] <= at(i)) ctx.fillRect(i, 0, 1, height);
    }

    // しきい値
    ctx.strokeStyle = '#d33';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < width; i++) {
      const py = y(at(i));
      if (i === 0) ctx.moveTo(i, py);
      else ctx.lineTo(i, py);
    }
    ctx.stroke();

    // 輝度
    ctx.strokeStyle = '#111';
    ctx.beginPath();
    for (let i = 0; i < width; i++) {
      const py = y(profile[i]);
      if (i === 0) ctx.moveTo(i, py);
      else ctx.lineTo(i, py);
    }
    ctx.stroke();
  }

  // 領域検出の段の結果。検出枠を取り込んだ画像の上に、
  // バーコードらしいとして拾った区画（青）と、最終的に切り出した矩形（赤）を重ねる。
  // 左右を詰める前の探索範囲は黄色の破線で出す
  function renderLocate(locate) {
    if (!locate || !locate.view) {
      previewLocate.hidden = true;
      return;
    }

    previewLocate.hidden = false;
    if (previewLocate.width !== locate.width || previewLocate.height !== locate.height) {
      previewLocate.width = locate.width;
      previewLocate.height = locate.height;
    }

    const ctx = previewLocate.getContext('2d');
    ctx.drawImage(locate.view, 0, 0);

    ctx.fillStyle = 'rgba(45, 127, 249, 0.28)';
    for (const cell of locate.cells || []) {
      ctx.fillRect(cell.x, cell.y, locate.cellSize, locate.cellSize);
    }

    const polygon = (points) => {
      ctx.beginPath();
      points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
    };

    const line = Math.max(2, Math.round(locate.width / 200));
    ctx.lineWidth = line;
    if (locate.searchBox) {
      ctx.strokeStyle = 'rgba(255, 200, 0, 0.9)';
      ctx.setLineDash([line * 3, line * 2]);
      polygon(locate.searchBox);
      ctx.setLineDash([]);
    }
    if (locate.box) {
      ctx.strokeStyle = '#e33';
      polygon(locate.box);
    }
  }

  const LOCATE_REASONS = {
    none: 'バーコードらしい区画がありません',
    small: 'バーコードらしい区画の塊が小さすぎます',
    edges: '切り出した範囲にバーのエッジが足りません'
  };

  // 段ごとの結果を 1 行ずつ。有効にした段は、見送ったものも含めて全部出す
  function describePipeline(debug) {
    const lines = [];

    if (debug.input) {
      lines.push(
        `入力: ${PREPROCESS_INPUT_LABELS[debug.input.kind] || debug.input.kind}` +
        `（${debug.input.width} × ${debug.input.height}）`
      );
    }

    for (const stage of debug.stages) {
      const step = debug.steps[stage];
      const name = PREPROCESS_STAGE_LABELS[stage] || stage;
      lines.push(`${name}: ${step ? describeStep(stage, step) : '通らず'}`);
    }

    if (debug.locate) lines.push('青: 拾った区画　黄: 探索範囲　赤: 切り出した範囲');

    return lines.join('\n');
  }

  function describeStep(stage, step) {
    if (stage === 'locate') return describeLocate(step);
    if (stage === 'contrast') return describeContrast(step);
    if (stage === 'aggregate') return describeAggregate(step);
    if (stage === 'pad') {
      return `左右 ${step.padX}px・上下 ${step.padY}px → ${step.out.width} × ${step.out.height}`;
    }
    return step.applied ? '適用' : '見送り';
  }

  function describeLocate(step) {
    if (!step.applied) {
      return `見つからず（${LOCATE_REASONS[step.reason] || step.reason}` +
        (step.edges !== undefined ? `・エッジ ${step.edges} 本` : '') +
        '）。素通しの画像を入力にしました';
    }

    return [
      `傾き ${step.angle.toFixed(1)}°`,
      `エッジ ${step.edges} 本（間隔の中央値 ${step.gap}px）`,
      `切り出し ${step.cut.width} × ${step.cut.height}（横 ${step.srcScale.toFixed(2)}x）`
    ].join('・');
  }

  // コントラスト調整で何をしたか
  function describeContrast(step) {
    if (step.mode === 'stretch') {
      return step.applied
        ? `stretch（${step.lo}〜${step.hi} → 0〜255）`
        : `stretch（${step.lo}〜${step.hi}。幅が足りず見送り）`;
    }
    return `CLAHE（${step.tilesX} × ${step.tilesY} 区画・クリップ ${step.clip}）`;
  }

  // 最細バー／最細スペースは、実際の module width が何 px あるかの答えそのもの。
  // 集約画像の尺と、元映像の尺（srcScale で割り戻したもの）と、解析に渡す出力画像の尺
  // （scale を掛けたもの。出力を縮めているときはここが一番細い）を出す
  function describeAggregate(step) {
    const method = PREPROCESS_METHOD_LABELS[step.method] || step.method;
    if (!step.applied) {
      return `${method}。波形の振幅が足りないので見送りました` +
        `（${Math.round(step.contrast.range)}/255。枠内にバーコードが無いか、バーが横向き）`;
    }

    const parts = [`${method}（${step.width} × ${step.height} 段）`];

    if (step.runs) {
      const other = (px) =>
        (step.srcScale ? ` / 元映像 ${(px / step.srcScale).toFixed(1)}px` : '') +
        ` / 出力 ${(px * step.scale).toFixed(1)}px`;
      parts.push(`最細バー: ${step.runs.minBar}px${other(step.runs.minBar)}`);
      parts.push(`最細スペース: ${step.runs.minSpace}px${other(step.runs.minSpace)}`);
      parts.push(`本数: ${step.runs.bars}`);
    }

    parts.push(`傾き補正: ${step.shear}px`);
    parts.push(`振幅: ${Math.round(step.contrast.range)}/255`);
    // 'none' のときは二値化せずに渡しているので、波形の黒白は実測用の目安でしかない
    parts.push(
      step.thresholdMode === 'none'
        ? `しきい値: ${step.thresholdMode}（波形の黒白は実測用の目安）`
        : `しきい値: ${step.thresholdMode}`
    );
    parts.push(`横の倍率: ${step.scale.toFixed(2)}x → ${step.out.width} × ${step.out.height}`);

    return parts.join('　');
  }

  // --- 撮影のダイアログ -------------------------------------------------

  // photo.js は objectURL を作らないので、寿命はこちらで面倒を見る
  function releasePhoto() {
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = null;
    photoFile = null;
  }

  function showPhoto(result) {
    releasePhoto();

    photoUrl = URL.createObjectURL(result.blob);
    photoFile = result.file;

    const method = PHOTO_METHOD_LABELS[result.method] || result.method;

    // 解像度は画像を読み込むまで分からないので、まず分かる情報だけ出す
    photoInfo.textContent = `${formatBytes(result.size)}  ${method}`;
    photoImage.addEventListener(
      'load',
      () => {
        photoInfo.textContent =
          `${photoImage.naturalWidth} × ${photoImage.naturalHeight}  ${formatBytes(result.size)}  ${method}`;
      },
      { once: true }
    );

    photoImage.src = photoUrl;
    photoSaveBtn.download = result.name;
    photoSaveBtn.href = photoUrl;
    // 共有シートはモバイル中心。ファイル共有に未対応なら保存だけを見せる
    photoShareBtn.hidden = !(navigator.canShare && navigator.canShare({ files: [photoFile] }));

    openDialog(photoDialog);
    renderShutter();
  }

  // 一度付けた class を外してから付け直さないと、連写でアニメーションが再生されない
  function playFlash() {
    flash.classList.remove('on');
    void flash.offsetWidth; // リフローを強制して再生位置をリセットする
    flash.classList.add('on');
  }

  async function sharePhoto() {
    if (!photoFile) return;

    try {
      await navigator.share({ files: [photoFile] });
    } catch (err) {
      // ユーザーがシートを閉じただけなら何も出さない
      if (err.name === 'AbortError') return;

      console.warn('共有に失敗しました', err);
      setLabel(photoShareBtn, '共有できません');
    }
  }

  shutterBtn.addEventListener('click', async () => {
    if (photoDialog.open) return;

    await photo.capture();
    renderShutter();
  });

  photoShareBtn.addEventListener('click', sharePhoto);
  photoCloseBtn.addEventListener('click', () => photoDialog.close());

  photoDialog.addEventListener('close', () => {
    resetLabel(photoShareBtn);

    // 画像を手放してから URL を解放する（表示中に revoke すると消えてしまう）
    photoImage.removeAttribute('src');
    photoSaveBtn.removeAttribute('href');
    releasePhoto();

    renderShutter();
    syncScanning();
  });

  // --- ボタン -----------------------------------------------------------

  startBtn.addEventListener('click', () => camera.start());
  stopBtn.addEventListener('click', () => camera.stop());

  switchBtn.addEventListener('click', async () => {
    switchBtn.disabled = true;
    await camera.switchCamera();
  });

  zoomBtn.addEventListener('click', () => camera.zoomNext());
  engineBtn.addEventListener('click', () => scanner.nextEngine());

  // 押すたびにスライダーを開閉する（非対応ならボタン自体が無効）
  brightnessBtn.addEventListener('click', () => showBrightnessPanel(brightnessPanel.hidden));

  brightnessRange.addEventListener('input', () => {
    const value = Number(brightnessRange.value);
    // 反映を待たずに読み値を出す（端末が丸めたぶんは適用後に実値で上書きされる）
    renderBrightnessValue(value);
    camera.setBrightness(value);
  });

  // --- 組み立て ---------------------------------------------------------

  scanner.configure({
    scanArea,
    // ライブラリは js/ に、同梱ライブラリは vendor/ に置いてある。
    // barcode.js の既定は自分と同じ場所の vendor/（= js/vendor/）なので、
    // このページの置き方に合わせてここで指す
    vendorPath: new URL('vendor/', document.baseURI).href,
    onEngineChange: handleEngineChange,
    onError: ({ code, message }) => {
      // 解析エラーは 1 フレームごとに起きうる（Quagga2 のタイムアウトなど）ので
      // ダイアログにはしない。バッジ側に「解析エラー」と出るのでそちらで気付く
      if (code === 'detect-failed') return;

      showError(message);
    }
  });

  photo.configure({
    video,
    onCaptureStart: () => {
      // takePhoto は完了までに時間がかかることがあるので、先に反応を返す
      playFlash();
      if (navigator.vibrate) navigator.vibrate(30);
      renderShutter();
    },
    onPhoto: showPhoto,
    onError: () => setLabel(shutterBtn, '撮影できません')
  });

  camera.configure({
    video,

    // フレームを受け取って検出するのは barcode.js。結果は onDetect で返ってくる
    detector: scanner.detect,

    onDetect: (result) => {
      // 前処理の A/B 比較の間は数えるだけ（バッジに途中経過が出る）
      if (isBenchmarking()) return;

      if (navigator.vibrate) navigator.vibrate(60);
      showResult(result);
    },

    onStarting: ({ facingMode: mode }) => {
      facingMode = mode;
      resolution = null;
      setStatus('カメラを起動中...');
    },

    // カメラが起動したら検出と撮影の準備をする。フレームは camera.js が detector に渡してくる
    onStart: ({ facingMode: mode, track }) => {
      facingMode = mode;
      setRunning(true);
      renderStatus();

      scanner.start();
      photo.attach({ facingMode: mode, track });
      renderShutter();
    },

    onStop: ({ silent }) => {
      setRunning(false);
      scanner.stop();
      photo.detach();
      renderShutter();

      if (!silent) setStatus('カメラを停止しました。');
    },

    onResolution: (size) => {
      resolution = size;
      renderStatus();
    },

    onZoom: handleZoomChange,
    onBrightness: handleBrightnessChange,
    onError: ({ message }) => setStatus(message)
  });

  // 前処理（検討中）。外すときはこの 1 行を消す。
  // autoPause を camera.js に入れ直すので、camera.configure() より後に置くこと
  setupPreprocess();

  setRunning(false);
  renderShutter();

  // 許可済みなら自動で起動し、あとから許可されたときも起動する
  camera.watchPermission();
})();
