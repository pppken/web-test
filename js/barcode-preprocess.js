(() => {
  'use strict';

  // バーコードの前処理（縦方向の集約）。**検討中の機能**なので barcode.js から切り出してある。
  // barcode.js 側にあるのは frameFilter という差し込み口 1 つだけで、そこに
  // BarcodePreprocess.filter を渡したときだけ動く。渡さなければ（またはこのファイルを
  // 読み込まなければ）barcode.js は従来どおり素通しの画像を解析する。
  //
  //   BarcodePreprocess.configure({
  //     mode,          // 'off' | 'mean' | 'median' | 'trimmed' | 'ab'（既定は保存値。無ければ 'median'）
  //     binarize,      // 集約の前に段ごとに二値化する（既定 false）。true のときの集約は常に平均
  //     threshold,     // 集約後の二値化。'none'（既定）| 'otsu' | 'adaptive'
  //     smooth,        // 集約後に 3 タップの平滑化を掛ける（既定 false）
  //     shear,         // 傾き（シアー）の補正を入れる（既定 true）
  //     debug,         // 波形などの検証用データを残す（既定 true。本番は false）
  //     storageKey,    // 選択の保存先。null で保存しない
  //     onChange(state)
  //   });
  //   BarcodeScanner.configure({ frameFilter: BarcodePreprocess.filter });  // 有効にするのはこの 1 行
  //   BarcodePreprocess.setMode(choice) / nextMode() / getState() / getStats() / resetStats()
  //   BarcodePreprocess.getLastOutput()   // 最後に作った出力画像の写し（検証用。debug のときだけ）
  //
  // frameFilter の約束ごと（受け取る frame の中身）は barcode.js の「差し込みの前処理」を参照。
  // このファイルも DOM を探さない。映像と切り出し範囲はフレームごとに barcode.js から受け取る。
  // barcode.js を直接は参照しない（結び付けるのは呼び出し側）。

  // --- 定数 -------------------------------------------------------------
  //
  // ラベルプリンタの印字は、バーの縁が 1px 単位でがたつく・かすれる・滲む。
  // 1D デコーダは 1 本のスキャンラインの run length（黒白の連続長）だけを見るので、
  // この 1px のがたつきがそのまま run length の誤差になる。
  // ZXing-C++ の Code128 は 1 要素あたり ±0.7 モジュールまでしか許さない
  // （ODCode128Reader.cpp の MAX_INDIVIDUAL_VARIANCE = 0.7）ので、
  // モジュールが 2px しかない画像では ±1.4px ＝ 実質 1px ぶんの余裕しかない。
  //
  // バーコードは高さ方向には同じ模様が続くので、複数ラインを集約すれば
  // この誤差はラインの本数ぶん小さくなる。集約すると縁は「なめらかな傾斜」になり、
  // エッジの位置がサブピクセルで分かるようになるが、**そのまま出しても
  // run length は整数に丸められて元の木阿弥**なので、線形補間（縮めるときは面積の平均）で
  // 出力の幅に合わせ、エッジの位置を画素の濃さとして残してから渡す（resample()）。
  const PRE_MAX_WIDTH = 1280;     // 前処理経路で横に残す最大幅。barcode.js の MAX_SCAN_SIDE より広く取る。
                                  // 細バーの太さは横の解像度でしか決まらないのでここは削らない。
                                  // 縦は PRE_ROWS 段まで潰すので画素数はむしろ減る
                                  // （1280x32 = 4 万画素 < 640x267 = 17 万画素）
  const PRE_ROWS = 32;            // 集約の材料にする段数。<video> から縦だけ縮めて作るので、
                                  // 1 段が既に元の十数ライン分の平均になっている
  const PRE_OUT_WIDTH = 600;      // 出力画像の横幅（左右の余白 PRE_PAD_X があればそれ込み）。波形はこの幅に
                                  // 合わせて伸び縮みする（resample()）。以前は常に 2 倍へ
                                  // 引き伸ばしていた（1280px 幅の枠なら 2640px）が、幅を抑えるため固定幅にした。
                                  // **ROI が広いと縮めることになり、そのぶん最細バーが細る**
                                  // （860px 幅の ROI なら約 0.7 倍）。検出画像ダイアログの
                                  // 「最細バー」の出力側の値が 2px を切るようなら、ここを広げる
  const PRE_OUT_ROWS = 100;       // 出力画像の行数（全行が同じ内容）。
                                  // 以前は ZXing-C++ に合わせた最小の 2 行にしていたが、
                                  // 実機の ZXing-C++ で検出しなかったため、高さ不足を疑って 100 に上げて検証中。
                                  // 2 行にしていた理由は次のとおりで、戻すかどうかはこれを踏まえて決める:
                                  //   - ZXing-C++ の minLineCount は既定 2。1 行では
                                  //     デコードできても最後に捨てられる（ODReader.cpp）
                                  //   - tryDownscale が true だと、3 行以上で LumImagePyramid が縮小層を作り
                                  //     （min(w,h) >= downscaleFactor=3）、細バーを潰した層まで走査する
                                  //     （いまの ZXING_CPP_OPTIONS は false なので効かない）
                                  //   - 2 行なら tryRotate の走査も width<3 で即座に打ち切られる。
                                  //     100 行だと回転側でも走査するぶん、1 回の解析が重くなる
  const PRE_PAD_X = 0;            // 出力画像の左右に足す白の幅（出力側の px）。以前は 40。
                                  // いまは足さない（検証中）。クワイエットゾーンは ROI に写っている
                                  // ラベルの余白だけが頼りになるので、枠いっぱいにバーコードを
                                  // 写すと読めない
  const PRE_MAX_SHEAR = 24;       // 傾き補正で許す上下のずれ（入力側の px）。
                                  // ROI の高さが 500px なら約 2.7 度ぶん
  const PRE_TRIM = 0.25;          // trimmed mean で上下から捨てる割合
  const PRE_ADAPTIVE_WINDOW = 48; // adaptive しきい値の窓幅（集約後・伸び縮み前の px）
  const PRE_BIN_WINDOW = 48;      // 集約前の二値化（binarize）で、しきい値を決める窓の幅（入力側の px）。
                                  // 太いバー（4 モジュール）が収まり、かつラベルの縁の灰色が
                                  // バーの暗さに引きずられない程度の幅
  const PRE_BIN_MIN_RATIO = 0.25; // 集約前の二値化で、窓の中の明暗差がその段全体の明暗差の
                                  // この割合に満たなければ、黒白を割らずに白とみなす
                                  // （無地の場所のノイズを黒に拾わないため）
  const PRE_MIN_CONTRAST = 16;    // 集約した波形の振幅がこれ未満なら前処理を諦めて
                                  // 素通しの経路に落ちる（枠内にバーコードが無い・
                                  // バーが横向きで縦集約に耐えない、のいずれか）

  // 集約の仕方。'off' は前処理なし、'ab' は 1 フレームおきに off と
  // AB_MODE を入れ替えて検出率を比べる計測用。
  //
  // **mean ではなく median を既定にしてある。** 荒れた印字を合成して測ったところ
  // （module 3px・傾き 1.2 度・縁のゆらぎ ±1px・ドット抜けあり、ZXing-C++ で n=90）、
  //
  //   前処理なし        0%
  //   縦 mean           3〜5%
  //   縦 median        36〜44%
  //   縦 trimmed mean  42〜45%
  //
  // と、mean だけがほとんど効かなかった。縁が 1px 単位でゆらいでいるとき、
  // mean はそのゆらぎの累積分布そのもの（＝数 px かけてなだらかに変わる傾斜）を作る。
  // ZXing-C++ 側は 1 行のヒストグラムでしきい値を決めるので、その傾斜のどこで切るかが
  // 黒白の面積比に引きずられ、run length が systematic にずれる。
  // median は「エッジ位置の中央値」に段を立て直すので、縁の鋭さが戻る。
  // trimmed mean はほぼ median と同じ（差は測定誤差の範囲）
  const CHOICES = ['off', 'mean', 'median', 'trimmed', 'ab'];
  const DEFAULT_CHOICE = 'median';
  const AB_MODE = 'median';
  const DEFAULT_STORAGE_KEY = 'barcodePreprocess';

  // 伸び縮みさせたあとの二値化。**既定は 'none'（＝ 生の輝度をそのまま渡す）。**
  // ZXing-C++ 側は 1 行ごとにヒストグラムでしきい値を決め、さらに
  // (-p[-1] + 4*p[0] - p[1]) / 2 という鋭化を掛けてから run length を取る
  // （GlobalHistogramBinarizer.cpp の ThresholdSharpened）。この鋭化は
  // 直線的な傾斜を素通しするので、こちらで二値化せずに傾斜のまま渡したほうが
  // サブピクセルのエッジ位置が残る。
  //
  // 実測でも 'none' 44% に対して 'adaptive' 38% / 'otsu' 36% と、足しても良くならない。
  // **'otsu' は荒れていないラベルでも 0% になることがある**（ROI に台紙や背景が
  // 写り込むと、山を 2 つに割る位置が「白 vs 灰」になってクワイエットゾーンごと
  // 黒に倒れる）。読み比べ用に残してあるだけで、既定にはしないこと
  const THRESHOLD_MODES = ['none', 'otsu', 'adaptive'];

  const config = {
    mode: null,
    binarize: false,
    threshold: 'none',
    smooth: false,
    shear: true,
    debug: true,
    storageKey: DEFAULT_STORAGE_KEY,
    onChange: null
  };

  let configured = false;

  // 検出枠のぶんを、横は実寸のまま・縦だけ PRE_ROWS 段に潰して取り込む先。
  // barcode.js の frameBuffer とは別に持つ（寸法がまるで違うので、共用すると
  // 'ab' のときに 1 フレームおきに canvas の再確保が走る）
  const frameBuffer = {
    canvas: document.createElement('canvas'),
    ctx: null,
    width: 0,
    height: 0,
    scaleX: 1,
    crop: null
  };
  // 縦に大きく縮めるので、素直に平均されるよう平滑化を効かせておく
  // （ここが最近傍になると、集約の材料が「数ラインおきの生ライン」になってしまう）
  frameBuffer.ctx = frameBuffer.canvas.getContext('2d');
  frameBuffer.ctx.imageSmoothingEnabled = true;
  frameBuffer.ctx.imageSmoothingQuality = 'high';

  // 集約した波形から作る、解析に渡す画像。こちらは getImageData される側
  const output = {
    canvas: document.createElement('canvas'),
    ctx: null
  };
  output.ctx = output.canvas.getContext('2d', { willReadFrequently: true });

  let choice = null;       // 選択値。初めて要るときに保存値から復元する
  let useNext = true;      // 'ab' のとき、次のフレームで前処理を使うか
  let debugInfo = null;    // 検証用（波形・しきい値・最細バーの実測）
  let lastOutput = null;   // 検証用。output.canvas にいま入っている画像の素性（getLastOutput）

  // 前処理あり／なしの検出率。'ab' のときに突き合わせる
  const stats = {
    plain: { tries: 0, hits: 0 },
    pre: { tries: 0, hits: 0 }
  };

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

  // --- 選択 -------------------------------------------------------------

  // camera.js / barcode.js と同じ理由で、localStorage は読み書きとも握りつぶす
  function loadChoice() {
    if (!config.storageKey) return DEFAULT_CHOICE;

    try {
      const saved = localStorage.getItem(config.storageKey);
      if (CHOICES.includes(saved)) return saved;
    } catch (err) {
      console.warn('前処理設定の読み込みに失敗しました', err);
    }
    return DEFAULT_CHOICE;
  }

  function saveChoice(value) {
    if (!config.storageKey) return;

    try {
      localStorage.setItem(config.storageKey, value);
    } catch (err) {
      console.warn('前処理設定の保存に失敗しました', err);
    }
  }

  function currentChoice() {
    if (choice === null) choice = loadChoice();
    return choice;
  }

  // このフレームを前処理経路で解析するか。'ab' は 1 フレームおきに入れ替える
  function modeForFrame() {
    const current = currentChoice();
    if (current === 'off') return null;
    if (current !== 'ab') return current;
    return useNext ? AB_MODE : null;
  }

  // 停止中でも切り替えられる。次のフレームから効く
  function setMode(value) {
    if (!CHOICES.includes(value) || value === currentChoice()) return;

    choice = value;
    saveChoice(value);
    useNext = true;
    debugInfo = null;
    lastOutput = null;
    resetStats();   // 中で onChange を出す
  }

  function nextMode() {
    const index = CHOICES.indexOf(currentChoice());
    setMode(CHOICES[(index + 1) % CHOICES.length]);
  }

  function getState() {
    const current = currentChoice();
    return {
      choice: current,
      mode: current === 'ab' ? AB_MODE : current,
      binarize: !!config.binarize,
      threshold: config.threshold,
      smooth: !!config.smooth,
      shear: !!config.shear,
      debug: debugInfo,
      stats: getStats()
    };
  }

  // 前処理が最後に作った出力画像（＝解析に渡した画像）の写しを返す（検証用）。
  // 写しを作るのは呼ばれたときだけで、毎フレームは何もしない。
  //
  // barcode.js の capturePreview() は、解析の途中に呼ばれると前処理に回さず素通しの
  // 画像を返すうえ、前処理に回ったときは output.canvas を作り直してしまう。
  // 最後に解析へ渡した画像を見たいなら、**capturePreview() より先に**呼ぶこと。
  //
  // 返すのは { canvas, width, height, pad, mode, time, preview } | null。
  // preview が true なら、前回の検出画像の表示用に作ったもので、解析には渡していない。
  // time は performance.now() の時刻。前処理を見送ったフレーム（振幅不足）では
  // 作り直さないので、古い画像のことがある（time で見分ける）
  function getLastOutput() {
    if (!config.debug || !lastOutput) return null;

    const source = output.canvas;
    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    canvas.getContext('2d').drawImage(source, 0, 0);

    return { canvas, ...lastOutput };
  }

  // --- 検出率の集計 -----------------------------------------------------
  //
  // 'ab' のときだけ意味がある。同じラベルを同じ端末・同じ持ち方で写しながら、
  // 前処理ありと無しを 1 フレームおきに交互に走らせて当たった割合を比べる。
  // 別々に試すと持ち方や明るさが変わってしまうので、必ず交互に回す

  function recordAttempt(usedPre, hit) {
    const bucket = usedPre ? stats.pre : stats.plain;
    bucket.tries += 1;
    if (hit) bucket.hits += 1;
  }

  function resetStats() {
    stats.plain.tries = 0;
    stats.plain.hits = 0;
    stats.pre.tries = 0;
    stats.pre.hits = 0;
    emit('onChange', getState());
  }

  function getStats() {
    const rate = (b) => (b.tries ? b.hits / b.tries : null);
    return {
      plain: { ...stats.plain, rate: rate(stats.plain) },
      pre: { ...stats.pre, rate: rate(stats.pre) }
    };
  }

  // --- 画像づくり -------------------------------------------------------
  //
  // barcode.js の素通しの経路が「映像をそのまま切り出す」のに対し、こちらは
  // バーコードの高さ方向を 1 本の波形に潰してから、その波形だけで画像を作り直す。
  //
  //   元画像                    集約後
  //   █ █▓█ █  ██
  //   █ ███ █░ ██      →      ████    ██████    ███    █████
  //   █ ██▓ █  ██
  //
  // 印字のかすれ・黒点・縁のがたつきは高さ方向に相関が無いので、段を重ねて
  // 平均（または中央値）を取ると消える。残るのはバーの位置だけになる。
  //
  // 縦に潰すので、**バーが縦に並んでいること**が前提になる。振幅が出ない
  // （PRE_MIN_CONTRAST 未満）ときは前処理を諦めて素通しの経路に落ちる。

  // 検出枠のぶんを、横は実寸のまま・縦だけ PRE_ROWS 段に潰して取り込む。
  // 縦の縮小は drawImage（＝ブラウザ側のフィルタ）に任せる。1 段が元の
  // 十数ライン分の平均になるので、この時点で既に印字ムラはかなり均されている
  function copyFrame(video, crop) {
    const { sx, sy, sw, sh } = crop;

    const dw = Math.max(3, Math.min(sw, PRE_MAX_WIDTH));
    const dh = Math.max(2, Math.min(sh, PRE_ROWS));

    const { canvas, ctx } = frameBuffer;
    if (canvas.width !== dw || canvas.height !== dh) {
      canvas.width = dw;
      canvas.height = dh;
      // width/height への代入で 2d コンテキストの状態は戻るので、入れ直す
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
    }

    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh);
    frameBuffer.width = dw;
    frameBuffer.height = dh;
    // 元映像の何分の一の幅で見ているか。最細バーの実測値を元の尺に戻すのに使う
    frameBuffer.scaleX = dw / sw;
    frameBuffer.crop = crop;
  }

  // RGBA から輝度へ。係数は barcode-worker.js（と ZXing 本体）と同じ
  function toGray(rgba, count) {
    const gray = new Uint8Array(count);

    for (let i = 0, j = 0; j < count; i += 4, j++) {
      gray[j] = (306 * rgba[i] + 601 * rgba[i + 1] + 117 * rgba[i + 2] + 512) >> 10;
    }

    return gray;
  }

  // 上側の帯と下側の帯の平均波形を突き合わせて、上下で何 px ずれているかを測る。
  //
  // バーコードがわずかに傾いていると、高さ方向にそのまま平均を取るだけでは
  // 縁が「ずれた位置の平均」になって太った edge になり、集約の意味が無くなる
  // （ROI の高さが 500px あれば 2 度の傾きで 17px ずれる。細バーは完全に潰れる）。
  // 2 次元の回転は掛けず、段ごとに横へずらしながら集約することで済ませる。
  //
  // **この補正は必須で、外すと前処理そのものが成立しない。** 実測では
  // 傾き 1.2 度のとき、補正ありで 44%・補正なしで 0%（荒れていないラベルでも 0%）
  function estimateShear(gray, width, height) {
    const band = Math.max(1, height >> 2);
    const top = new Float32Array(width);
    const bottom = new Float32Array(width);

    for (let y = 0; y < band; y++) {
      const t = y * width;
      const b = (height - 1 - y) * width;
      for (let x = 0; x < width; x++) {
        top[x] += gray[t + x];
        bottom[x] += gray[b + x];
      }
    }
    for (let x = 0; x < width; x++) {
      top[x] /= band;
      bottom[x] /= band;
    }

    const limit = Math.min(PRE_MAX_SHEAR, width >> 3);
    let best = 0;
    let bestScore = Infinity;
    let zeroScore = Infinity;

    for (let s = -limit; s <= limit; s++) {
      const from = Math.max(0, -s);
      const to = Math.min(width, width - s);
      let sum = 0;
      for (let x = from; x < to; x++) {
        const d = top[x] - bottom[x + s];
        sum += d * d;
      }
      // ずらすと重なりが狭くなるので、1px あたりに直してから比べる
      const score = sum / (to - from);
      if (s === 0) zeroScore = score;
      if (score < bestScore) {
        bestScore = score;
        best = s;
      }
    }

    // 誤差の範囲で動いただけのときに動かさない。はっきり良くなったときだけ採用する
    if (bestScore > zeroScore * 0.8) return 0;
    return best;
  }

  // 集約の前に、段ごとに黒（0）と白（255）へ割る（binarize が true のとき）。
  //
  // 灰色のまま集約して normalize() で伸ばすと、ラベルの縁や台紙の灰色が中途半端な
  // 暗さのまま残り、ZXing-C++ の行ごとのヒストグラム（GlobalHistogramBinarizer）が
  // 「黒・灰・白」の 3 つの山のどこで割るか次第で、灰色ごと黒に倒れることがある。
  // そうなるとクワイエットゾーンが消えて読めない。こちらで先に割っておけば、
  // しきい値の決め方をライブラリ任せにしなくて済む。
  //
  // しきい値は x ごとに、前後 PRE_BIN_WINDOW の窓の中の最小と最大の中点
  // （平均ではない。黒白の面積比が模様によって偏るため）。窓の中の明暗差が小さい
  // 場所（無地の余白・台紙の真ん中）は割らずに白とみなす。
  //
  // 割ったあとの集約は**平均でなければならない**（capture() が mode に依らず平均にする）。
  // 0/255 の中央値は多数決になって、エッジの位置が 1px 単位に丸められる。
  // 平均なら「その x で何割の段が黒か」になり、縁のがたつきがそのまま
  // サブピクセルのエッジ位置として残る（resample() で残せるのはこの情報）
  function binarizeRows(gray, width, height) {
    const out = new Uint8Array(width * height);
    const lo = new Uint8Array(width);
    const hi = new Uint8Array(width);
    const queue = new Int32Array(width);
    const half = PRE_BIN_WINDOW >> 1;

    for (let y = 0; y < height; y++) {
      const row = y * width;

      let rowMin = 255;
      let rowMax = 0;
      for (let x = 0; x < width; x++) {
        const v = gray[row + x];
        if (v < rowMin) rowMin = v;
        if (v > rowMax) rowMax = v;
      }
      const floor = Math.max(PRE_MIN_CONTRAST, (rowMax - rowMin) * PRE_BIN_MIN_RATIO);

      slidingExtreme(gray, row, width, half, lo, queue, false);
      slidingExtreme(gray, row, width, half, hi, queue, true);

      for (let x = 0; x < width; x++) {
        const v = gray[row + x];
        const black = hi[x] - lo[x] >= floor && v * 2 < lo[x] + hi[x];
        out[row + x] = black ? 0 : 255;
      }
    }

    return out;
  }

  // 1 段ぶんの、窓 [x - half, x + half] の最小（max が true なら最大）。
  // 単調キューで 1 段あたり O(width)。窓幅ぶん素直に回すと 1 フレームで
  // 32 段 x 1280 x 49 回になるので、こちらにしてある
  function slidingExtreme(src, offset, width, half, out, queue, max) {
    let head = 0;
    let tail = 0;
    let next = 0;

    for (let x = 0; x < width; x++) {
      const right = Math.min(width - 1, x + half);
      while (next <= right) {
        const v = src[offset + next];
        while (tail > head) {
          const last = src[offset + queue[tail - 1]];
          if (max ? last > v : last < v) break;
          tail--;
        }
        queue[tail++] = next++;
      }
      while (queue[head] < x - half) head++;
      out[x] = src[offset + queue[head]];
    }
  }

  // 各 x について、高さ方向の輝度を 1 つにまとめる。
  // shear が 0 でなければ、段ごとに横へずらしながら拾う
  function aggregate(gray, width, height, mode, shear) {
    const profile = new Float32Array(width);
    const column = new Uint8Array(height);
    // 上端の段を基準に、下端が shear px ずれているものとして按分する
    const span = height > 1 ? height - 1 : 1;
    const offsets = new Int32Array(height);
    for (let y = 0; y < height; y++) {
      offsets[y] = Math.round((shear * y) / span);
    }

    const trim = mode === 'trimmed' ? Math.floor(height * PRE_TRIM) : 0;
    const mid = height >> 1;

    for (let x = 0; x < width; x++) {
      if (mode === 'mean') {
        let sum = 0;
        for (let y = 0; y < height; y++) {
          let sx = x + offsets[y];
          if (sx < 0) sx = 0;
          else if (sx >= width) sx = width - 1;
          sum += gray[y * width + sx];
        }
        profile[x] = sum / height;
        continue;
      }

      // median / trimmed。段数は PRE_ROWS（32）しかないので挿入ソートで足りる
      for (let y = 0; y < height; y++) {
        let sx = x + offsets[y];
        if (sx < 0) sx = 0;
        else if (sx >= width) sx = width - 1;
        const v = gray[y * width + sx];
        let i = y - 1;
        while (i >= 0 && column[i] > v) {
          column[i + 1] = column[i];
          i--;
        }
        column[i + 1] = v;
      }

      if (mode === 'median') {
        profile[x] = height & 1 ? column[mid] : (column[mid - 1] + column[mid]) / 2;
      } else {
        let sum = 0;
        for (let y = trim; y < height - trim; y++) sum += column[y];
        profile[x] = sum / (height - trim * 2);
      }
    }

    return profile;
  }

  // 波形を 0〜255 に伸ばす。ZXing-C++ 側は 1 行ごとにヒストグラムの山を 2 つ探し、
  // その間隔が 16 階調未満だとその行を丸ごと捨てる（GlobalHistogramBinarizer.cpp の
  // EstimateBlackPoint が -1 を返す）。集約で振幅が痩せたまま渡すとここに引っかかる
  function normalize(profile) {
    let lo = 255;
    let hi = 0;
    for (let i = 0; i < profile.length; i++) {
      const v = profile[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }

    const range = hi - lo;
    if (range < PRE_MIN_CONTRAST) return { lo, hi, range, ok: false };

    const gain = 255 / range;
    for (let i = 0; i < profile.length; i++) {
      profile[i] = (profile[i] - lo) * gain;
    }

    return { lo, hi, range, ok: true };
  }

  // 3 タップ（1:2:1）の平滑化。**既定では通さない。**
  // 縦の集約でノイズは既に落ちているので、ここで横方向に鈍らせると
  // 細バーの縁まで一緒に鈍る。実測でも median 44% が 21% まで落ちた。
  // 読み比べ用に残してあるだけで、既定で入れないこと
  function smooth(profile) {
    const out = new Float32Array(profile.length);
    out[0] = profile[0];
    out[profile.length - 1] = profile[profile.length - 1];
    for (let i = 1; i < profile.length - 1; i++) {
      out[i] = (profile[i - 1] + profile[i] * 2 + profile[i + 1]) / 4;
    }
    return out;
  }

  // 二値化のしきい値。'otsu' は（ヒストグラムから）1 本、'adaptive' は x ごとに 1 本返す
  function thresholdCurve(profile, mode) {
    if (mode === 'otsu') {
      const hist = new Int32Array(256);
      for (let i = 0; i < profile.length; i++) hist[profile[i] | 0]++;

      const total = profile.length;
      let sum = 0;
      for (let i = 0; i < 256; i++) sum += i * hist[i];

      let sumB = 0;
      let wB = 0;
      let best = 0;
      let bestVar = -1;
      for (let t = 0; t < 256; t++) {
        wB += hist[t];
        if (!wB) continue;
        const wF = total - wB;
        if (!wF) break;
        sumB += t * hist[t];
        const mB = sumB / wB;
        const mF = (sum - sumB) / wF;
        const between = wB * wF * (mB - mF) * (mB - mF);
        if (between > bestVar) {
          bestVar = between;
          best = t;
        }
      }
      return { value: best, curve: null };
    }

    if (mode === 'adaptive') {
      // 窓の中の最小値と最大値の中点。バーコードの二値化では平均より素直に効く
      // （黒と白の面積比が模様によって偏るため）
      const half = PRE_ADAPTIVE_WINDOW >> 1;
      const curve = new Float32Array(profile.length);
      for (let i = 0; i < profile.length; i++) {
        const from = Math.max(0, i - half);
        const to = Math.min(profile.length, i + half + 1);
        let lo = 255;
        let hi = 0;
        for (let j = from; j < to; j++) {
          const v = profile[j];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        curve[i] = (lo + hi) / 2;
      }
      return { value: null, curve };
    }

    return { value: null, curve: null };
  }

  // 波形を outWidth px に伸び縮みさせる。
  //
  // 伸ばすときは**線形補間でなければ意味が無い。** 集約で得られるのは「エッジが x と x+1 の
  // 間のどこにあるか」という情報で、最近傍で伸ばすとそれを捨てて整数に丸め直すことになる。
  //
  // 縮めるときは、出力の 1px が覆う入力の区間を面積で平均する（間引かない）。
  // 間引くと細バーを丸ごと飛ばすことがあるが、面積で平均すればエッジを跨ぐ画素が
  // 中間の灰色になり、エッジの位置はその濃さとして残る
  function resample(profile, outWidth) {
    const width = profile.length;
    const out = new Float32Array(outWidth);
    const step = width / outWidth;   // 出力の 1px が入力の何 px にあたるか

    if (step <= 1) {
      for (let i = 0; i < outWidth; i++) {
        const u = (i + 0.5) * step - 0.5;
        const i0 = Math.floor(u);
        const frac = u - i0;
        const a = profile[i0 < 0 ? 0 : i0 >= width ? width - 1 : i0];
        const i1 = i0 + 1;
        const b = profile[i1 < 0 ? 0 : i1 >= width ? width - 1 : i1];
        out[i] = a + (b - a) * frac;
      }
      return out;
    }

    for (let i = 0; i < outWidth; i++) {
      const from = i * step;
      const to = from + step;
      let sum = 0;
      for (let x = Math.floor(from); x < to && x < width; x++) {
        const a = x > from ? x : from;
        const b = x + 1 < to ? x + 1 : to;
        sum += profile[x] * (b - a);
      }
      out[i] = sum / step;
    }
    return out;
  }

  // 波形を黒白に割ってから run length（連続長）を数える。
  // 「最細バー／最細スペースが画像上で何 px か」を実測するためのもので、
  // 解析そのものには使わない。両端のクワイエットゾーンは長すぎるので落とす
  function measureRuns(profile, threshold) {
    const runs = [];
    let last = profile[0] <= threshold;
    let start = 0;

    for (let i = 1; i < profile.length; i++) {
      const black = profile[i] <= threshold;
      if (black !== last) {
        runs.push({ black: last, length: i - start });
        last = black;
        start = i;
      }
    }
    runs.push({ black: last, length: profile.length - start });

    // 先頭と末尾の白（クワイエットゾーン）は数えない
    const inner = runs.slice(runs[0].black ? 0 : 1, runs[runs.length - 1].black ? undefined : -1);
    if (inner.length < 3) return null;

    let minBar = Infinity;
    let minSpace = Infinity;
    for (const run of inner) {
      if (run.black) minBar = Math.min(minBar, run.length);
      else minSpace = Math.min(minSpace, run.length);
    }

    return {
      bars: inner.length,
      minBar: Number.isFinite(minBar) ? minBar : null,
      minSpace: Number.isFinite(minSpace) ? minSpace : null
    };
  }

  // 集約した波形から、解析に渡す画像を組み立てる。
  // 全行が同じ内容の PRE_OUT_ROWS 行。左右にはクワイエットゾーンぶんの白を足す
  function buildImage(profile, threshold) {
    const width = profile.length + PRE_PAD_X * 2;
    const { canvas, ctx } = output;

    if (canvas.width !== width || canvas.height !== PRE_OUT_ROWS) {
      canvas.width = width;
      canvas.height = PRE_OUT_ROWS;
    }

    const image = ctx.createImageData(width, PRE_OUT_ROWS);
    const data = image.data;

    for (let x = 0; x < width; x++) {
      const i = x - PRE_PAD_X;
      let v;
      if (i < 0 || i >= profile.length) {
        v = 255;                       // 左右の余白は白
      } else if (threshold === null) {
        v = profile[i];                // 生の輝度をそのまま渡す（既定）
      } else {
        v = profile[i] <= (threshold.length ? threshold[i] : threshold) ? 0 : 255;
      }

      const c = v < 0 ? 0 : v > 255 ? 255 : v | 0;
      for (let y = 0; y < PRE_OUT_ROWS; y++) {
        const p = (y * width + x) * 4;
        data[p] = c;
        data[p + 1] = c;
        data[p + 2] = c;
        data[p + 3] = 255;
      }
    }

    ctx.putImageData(image, 0, 0);
    return canvas;
  }

  // 前処理した 1 枚を作る。作れなければ null（呼び出し側は素通しの経路に落ちる）
  function capture(video, crop, mode) {
    copyFrame(video, crop);

    const width = frameBuffer.width;
    const height = frameBuffer.height;
    const rgba = frameBuffer.ctx.getImageData(0, 0, width, height).data;
    const gray = toGray(rgba, width * height);

    // 傾きは二値化の前の灰色で測る（割ってしまうと、段ごとのずれを突き合わせる材料が痩せる）
    const shear = config.shear ? estimateShear(gray, width, height) : 0;
    // 二値化したときの集約は常に平均（理由は binarizeRows() を参照）
    const binarize = !!config.binarize;
    const aggregateMode = binarize ? 'mean' : mode;
    let profile = aggregate(
      binarize ? binarizeRows(gray, width, height) : gray, width, height, aggregateMode, shear
    );

    const contrast = normalize(profile);
    if (!contrast.ok) {
      // 枠内にバーコードが無いか、バーが横向きで縦の集約に耐えない
      if (config.debug) {
        debugInfo = { mode, aggregateMode, binarize, width, height, shear, contrast, skipped: true };
      }
      return null;
    }

    if (config.smooth) profile = smooth(profile);

    const thresholdMode = THRESHOLD_MODES.includes(config.threshold) ? config.threshold : 'none';
    const threshold = thresholdCurve(profile, thresholdMode);

    // 伸び縮みは二値化より後ではなく先。二値化を先にすると、集約で得た
    // サブピクセルのエッジ位置をそこで捨ててしまう
    const outWidth = PRE_OUT_WIDTH - PRE_PAD_X * 2;
    const scaled = resample(profile, outWidth);
    const scaledThreshold =
      threshold.curve ? resample(threshold.curve, outWidth) : threshold.value;

    const canvas = buildImage(scaled, thresholdMode === 'none' ? null : scaledThreshold);

    if (config.debug) {
      lastOutput = {
        width: canvas.width,
        height: canvas.height,
        pad: PRE_PAD_X,
        mode,
        aggregateMode,
        binarize,
        time: performance.now()
      };

      // 最細バーの実測は元の尺（＝引き伸ばす前）で出す。
      // otsu / adaptive を選んでいなければ、測るためだけに otsu を 1 本引く
      const hasThreshold = !!threshold.curve || threshold.value !== null;
      const measureAt = hasThreshold ? threshold : thresholdCurve(profile, 'otsu');
      const runs = measureRuns(profile, measureAt.curve || measureAt.value);

      debugInfo = {
        mode,
        aggregateMode,
        binarize,
        thresholdMode,
        width,
        height,
        shear,
        contrast,
        profile,
        threshold: measureAt.curve || measureAt.value,
        // threshold が「実際に渡した画像を作るのに使ったもの」か、
        // 最細バーを測るためだけに引いたものか（thresholdMode が 'none' のとき）
        thresholdIsMeasureOnly: !hasThreshold,
        runs,
        // 集約画像 → 出力画像の横の倍率（1 未満なら縮めている）
        scale: outWidth / width,
        // 集約画像の 1px が元映像の何 px にあたるか。実機の module width はこれを掛ける
        srcScale: frameBuffer.scaleX,
        crop: frameBuffer.crop,
        out: { width: canvas.width, height: canvas.height },
        pad: PRE_PAD_X,
        skipped: false
      };
    }

    return canvas;
  }

  // --- barcode.js への差し込み口 ----------------------------------------

  // BarcodeScanner.configure({ frameFilter }) に渡す関数。1 フレームぶんの画像を作り、
  // 解析の呼び出し（frame.analyze）までを引き受ける。前処理を使わないフレーム
  // （'off'・'ab' の素通し側・振幅が足りないとき）は frame.plain() で素通しの画像を
  // もらって解析に回す。
  //
  // frame.preview が true（検出画像の表示）のときは数えず、'ab' の入れ替えもしない。
  // 'ab' でも見るときは必ず前処理ありのほうを出す
  async function filter(frame) {
    const current = currentChoice();
    const mode = frame.preview && current === 'ab' ? AB_MODE : modeForFrame();
    const canvas = mode ? capture(frame.video, frame.crop, mode) : null;
    // 検出画像の表示用に作ったもの（解析には渡していない）かどうか。getLastOutput で見分ける
    if (canvas && lastOutput) lastOutput.preview = !!frame.preview;
    const source = canvas || frame.plain();
    if (!source) return null;

    const result = await frame.analyze(source);

    if (!frame.preview) {
      recordAttempt(!!canvas, !!result);
      // 'ab' の入れ替えは解析が終わってから。途中で入れ替えると、
      // 落ちた（＝素通しに回った）フレームのぶんだけ偏る
      if (current === 'ab') useNext = !useNext;
    }

    return result;
  }

  // --- ライフサイクル ---------------------------------------------------

  function configure(options = {}) {
    Object.assign(config, options);

    // 選択の復元は初回だけ（barcode.js の configure と同じ理由）
    if (options.mode && CHOICES.includes(options.mode)) choice = options.mode;
    else if (!configured) choice = loadChoice();

    configured = true;

    // 状態を一度流しておく。呼び出し側はこれでボタンの初期表示を決められる
    emit('onChange', getState());
  }

  window.BarcodePreprocess = {
    configure,
    filter,
    setMode,
    nextMode,
    getState,
    getChoices: () => CHOICES.slice(),
    getStats,
    resetStats,
    getLastOutput
  };
})();
