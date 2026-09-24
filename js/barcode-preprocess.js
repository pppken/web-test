(() => {
  'use strict';

  // バーコードの前処理（縦方向の集約）。**検討中の機能**なので barcode.js から切り出してある。
  // barcode.js 側にあるのは frameFilter という差し込み口 1 つだけで、そこに
  // BarcodePreprocess.filter を渡したときだけ動く。渡さなければ（またはこのファイルを
  // 読み込まなければ）barcode.js は従来どおり素通しの画像を解析する。
  //
  //   BarcodePreprocess.configure({
  //     mode,          // 'off' | 'mean' | 'median' | 'trimmed' | 'contrast-stretch' | 'contrast-clahe'
  //                    // | 'locate' | 'ab' | 'ab-locate'
  //                    // （既定は保存値。無ければ 'median'。'contrast-*' は集約せずコントラスト正規化だけ。
  //                    // 'locate' はバーコードの領域を探して切り出し、白の余白を足す）
  //     contrastNormalize, // 灰色にした直後のコントラスト正規化。'off'（既定）| 'stretch' | 'clahe'
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
  const PRE_OUT_WIDTH = null;     // 出力画像の横幅（左右の余白 PRE_PAD_X があればそれ込み）。
                                  // **null なら実寸**（＝検出枠を元映像の px で取り込んだ幅。
                                  // PRE_MAX_WIDTH を超える枠だけはそこまで縮まっている）で、伸び縮みしない。
                                  // 数値を入れると、波形をその幅に合わせて伸び縮みさせる（resample()）。
                                  // 経緯: 最初は常に 2 倍（1280px 幅の枠なら 2640px）→ 600px 固定 →
                                  // 実寸。600px 固定では実機の枠（約 860px 幅）を約 0.7 倍に縮めることになり、
                                  // そのぶん最細バーが細っていた
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
  const PRE_MIN_CONTRAST = 16;    // 集約した波形の振幅がこれ未満なら前処理を諦めて
                                  // 素通しの経路に落ちる（枠内にバーコードが無い・
                                  // バーが横向きで縦集約に耐えない、のいずれか）
  const PRE_STRETCH_CLIP = 0.01;  // コントラスト正規化 'stretch' で、暗い側・明るい側それぞれ
                                  // 捨てる割合。反射や枠の端の影 1 点に伸ばし幅を引っ張られないため
  const PRE_CLAHE_TILES_X = 8;    // CLAHE の横の区画数。区画の幅（1280px 幅なら 160px）に
                                  // バーとスペースが両方入る程度に粗くしておく
  const PRE_CLAHE_TILES_Y = 1;    // CLAHE の縦の区画数。取り込みが 32 段しかなく、1 段が既に
                                  // 元の十数ラインの平均なので縦には分けない
  const PRE_CLAHE_CLIP = 2.0;     // CLAHE のクリップ上限（1 階調あたりの平均画素数の何倍まで
                                  // 許すか）。上げるほど区画ごとの伸ばし方が強くなり、
                                  // 無地の場所のノイズも持ち上がる
  const CONTRAST_ONLY_TILES_Y = 4;// 'contrast-clahe' モード（集約しない）の CLAHE の縦の区画数。
                                  // こちらは切り出した画像そのもの（640x570 程度）なので縦にも分ける

  // 'locate'（領域の検出と切り出し）。流れは「領域の検出と切り出し」の節を参照
  const LOC_MAX_SIDE = 640;       // 領域を探すときに取り込む大きさ（長辺）。barcode.js の MAX_SCAN_SIDE と同じ。
                                  // 320 まで落とすと、実機の細バー（元映像で 3px 前後）が 1px を切って
                                  // 勾配が出なくなる
  const LOC_CELL = 16;            // 勾配を集計する区画の一辺（取り込み側の px）。
                                  // 1 区画にバーとスペースが何本か入る程度にする
  const LOC_MIN_ENERGY = 100;     // 区画の勾配の 2 乗平均（輝度/px の 2 乗）がこれ未満なら無地とみなす。
                                  // 10 階調/px 程度。ノイズだけの区画は 1 桁小さい
  const LOC_MIN_COHERENCE = 0.6;  // 勾配の向きの揃い具合（0〜1）。バーコードは 1 方向に揃うのでほぼ 1、
                                  // 文字や模様は向きがばらけて下がる
  const LOC_MAX_ANGLE = 20;       // 隣の区画と同じ塊とみなす勾配の向きの差（度）
  const LOC_MIN_CELLS = 4;        // 塊がこれより小さければバーコードではないとみなす
  const LOC_MIN_WIDTH_CELLS = 3;  // 塊のバーと直交する方向の幅（区画数）。ラベルの縁のような
                                  // 1 本の強いエッジは細長い塊になるので、ここで落とす
  const LOC_SEARCH_MARGIN = 1;    // 切り出すとき、塊の外側にバーと直交する方向へ何区画ぶん広げるか。
                                  // 区画の粒度では端のバーを取りこぼすので広めに取り、あとでエッジの並びで詰める
  const LOC_MAX_WIDTH = 1280;     // 切り出した画像の横幅の上限。細バーの太さは横の解像度でしか
                                  // 決まらないので、元映像の実寸まではそのまま使う（前処理の PRE_MAX_WIDTH と同じ）
  const LOC_MAX_HEIGHT = 160;     // 切り出した画像の高さの上限。バーの向きに沿って縮めるだけなので
                                  // バーは細らない（縦の平均になり、印字ムラが少し均される）
  const LOC_EDGE_MIN = 8;         // エッジとみなす輝度の段差の下限（2px あたり）
  const LOC_EDGE_REL = 0.25;      // エッジとみなす段差の下限（段差の大きいほうから 1 割の値に対する割合）
  const LOC_GAP_FACTOR = 4;       // エッジの間隔の中央値の何倍を超えたら、バーコードの外（クワイエットゾーン）とみなすか。
                                  // 規格の余白は 7〜10 モジュール、要素の最大幅は 4 モジュール（CODE128 / JAN）で、
                                  // 間隔の中央値はおよそ 1.5〜2 モジュール
  const LOC_MIN_EDGES = 20;       // バーコードとみなすエッジの本数の下限。最短の CODE39 / CODE128 でも 25 本以上ある
  const LOC_PAD_X = 40;           // 左右に足す白の余白の最小幅（出力側の px）。barcode.js の SCAN_PAD_X と同じ
  const LOC_PAD_GAPS = 8;         // 左右の余白を、エッジの間隔の中央値の何倍にするか（LOC_PAD_X より広ければこちら）。
                                  // 間隔の中央値がおよそ 1.5〜2 モジュールなので、12〜16 モジュールぶんになる
  const LOC_PAD_Y = 8;            // 上下に足す白の余白（出力側の px）。1D の読み取りには要らないが、
                                  // 切り口のすぐ上下に文字や台紙が来ないようにしておく

  // 集約の仕方。'off' は前処理なし、'ab' / 'ab-locate' は 1 フレームおきに off と
  // AB_CHOICES の前処理を入れ替えて検出率を比べる計測用。
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
  //
  // 'contrast-stretch' / 'contrast-clahe' は縦の集約をせず、素通しの画像（frame.plain()）に
  // コントラスト正規化だけを掛けて渡す。方式はモードごとに決まっていて、
  // contrastNormalize の設定（集約するモード用）には左右されない。
  // 集約とコントラスト正規化のどちらが効いているかを切り分けるためのもの
  //
  // 'locate' は集約もコントラスト正規化もせず、検出枠の中からバーコードの領域だけを探して
  // 切り出し、傾きを直して白の余白を足してから渡す（下の「領域の検出と切り出し」を参照）
  const CHOICES = [
    'off', 'mean', 'median', 'trimmed', 'contrast-stretch', 'contrast-clahe', 'locate', 'ab', 'ab-locate'
  ];
  const CONTRAST_ONLY_MODES = {    // モード -> コントラスト正規化の方式
    'contrast-stretch': 'stretch',
    'contrast-clahe': 'clahe'
  };
  const DEFAULT_CHOICE = 'median';
  const AB_CHOICES = {             // A/B の選択値 -> 素通しと交互に回す前処理
    ab: 'median',
    'ab-locate': 'locate'
  };
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

  // 灰色にした直後（傾きの測定・集約より前）に掛けるコントラスト正規化。
  //   'off'      何もしない（集約後の normalize() だけ）
  //   'stretch'  ROI の輝度の上下 PRE_STRETCH_CLIP を捨て、残りを 0〜255 に線形に伸ばす
  //   'clahe'    ROI を横に PRE_CLAHE_TILES_X 区画に分け、区画ごとにクリップ付きの
  //              ヒストグラム平坦化を掛けて、区画の間は線形補間でつなぐ
  //
  // 'stretch' は全体に同じ直線を掛けるだけなので、明るさの順番は変わらない。
  // 中央値の集約とは入れ替えても結果が同じで、集約後の normalize()（最小〜最大を
  // 0〜255 に伸ばす）との違いは「上下の外れ値に引っ張られない」ことだけになる。
  //
  // 'clahe' は場所ごとに伸ばし方を変えるので、影や照明のむらで ROI の左右の明るさが
  // 違うときに効く。その代わり階調の写し方が直線でなくなるので、ぼけた縁の
  // 「中間の濃さ」の位置がずれ、バーの太さが偏りうる（読み比べて決めること）
  const CONTRAST_MODES = ['off', 'stretch', 'clahe'];

  const config = {
    mode: null,
    contrastNormalize: 'off',
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

  // 'contrast-*' モードで、素通しの画像にコントラスト正規化を掛けた画像。
  // 素通しの画像は barcode.js の作業用 canvas なので、書き換えずにこちらへ写してから触る
  const contrastOutput = {
    canvas: document.createElement('canvas'),
    ctx: null
  };
  contrastOutput.ctx = contrastOutput.canvas.getContext('2d', { willReadFrequently: true });

  // 'locate' の作業用。どれも getImageData される側
  //   locateInput    検出枠のぶんを LOC_MAX_SIDE まで縮めて取り込んだもの（領域を探す材料）
  //   locateExtract  見つけた領域を、元映像から傾きを直して切り出したもの（余白なし）
  //   locateOutput   左右の端を詰めて白の余白を足したもの（解析に渡す画像）
  const locateInput = { canvas: document.createElement('canvas'), ctx: null };
  const locateExtract = { canvas: document.createElement('canvas'), ctx: null };
  const locateOutput = { canvas: document.createElement('canvas'), ctx: null };
  for (const target of [locateInput, locateExtract, locateOutput]) {
    target.ctx = target.canvas.getContext('2d', { willReadFrequently: true });
  }

  let choice = null;       // 選択値。初めて要るときに保存値から復元する
  let useNext = true;      // 'ab' のとき、次のフレームで前処理を使うか
  let debugInfo = null;    // 検証用（波形・しきい値・最細バーの実測）
  let lastOutput = null;   // 検証用。最後に作った画像の素性（getLastOutput）
  let lastOutputCanvas = null; // その画像が入っている canvas（output / contrastOutput / locateOutput）

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

  // このフレームを前処理経路で解析するか。'ab' / 'ab-locate' は 1 フレームおきに入れ替える
  function modeForFrame() {
    const current = currentChoice();
    if (current === 'off') return null;
    const ab = AB_CHOICES[current];
    if (!ab) return current;
    return useNext ? ab : null;
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
      mode: AB_CHOICES[current] || current,
      contrastNormalize: contrastMode(),
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
    if (!config.debug || !lastOutput || !lastOutputCanvas) return null;

    const source = lastOutputCanvas;
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

  function contrastMode() {
    return CONTRAST_MODES.includes(config.contrastNormalize) ? config.contrastNormalize : 'off';
  }

  // ヒストグラムで、暗い方から数えて rank 個目の画素がある階調
  function histogramRank(hist, rank) {
    let sum = 0;
    for (let v = 0; v < 256; v++) {
      sum += hist[v];
      if (sum > rank) return v;
    }
    return 255;
  }

  // 'stretch'。ROI の輝度の上下 PRE_STRETCH_CLIP を捨て、残りを 0〜255 に線形に伸ばす。
  // 例えば黒バー 50〜100・白 170〜220 なら、50 付近を 0、220 付近を 255 に写す。
  // gray をその場で書き換える
  function stretchGray(gray) {
    const hist = new Int32Array(256);
    for (let i = 0; i < gray.length; i++) hist[gray[i]]++;

    const lo = histogramRank(hist, gray.length * PRE_STRETCH_CLIP);
    const hi = histogramRank(hist, gray.length * (1 - PRE_STRETCH_CLIP));
    // 伸ばす幅が無い（枠内が無地）ときは触らない。集約後の normalize() が前処理を見送る
    if (hi - lo < PRE_MIN_CONTRAST) return { mode: 'stretch', lo, hi, applied: false };

    const lut = new Uint8Array(256);
    const gain = 255 / (hi - lo);
    for (let v = 0; v < 256; v++) {
      const c = Math.round((v - lo) * gain);
      lut[v] = c < 0 ? 0 : c > 255 ? 255 : c;
    }
    for (let i = 0; i < gray.length; i++) gray[i] = lut[gray[i]];

    return { mode: 'stretch', lo, hi, applied: true };
  }

  // 'clahe'（Contrast Limited Adaptive Histogram Equalization）。
  // ROI を tilesX x tilesY の区画に分けて、区画ごとに
  //   1. ヒストグラムを取り、PRE_CLAHE_CLIP を超えた分を切り取って全階調に配り直す
  //      （これが無いと、無地の区画のわずかなノイズが 0〜255 いっぱいに伸びる）
  //   2. 累積分布を階調の対応表にする（ヒストグラム平坦化）
  // を作り、各画素は周りの区画の中心からの距離で対応表を線形補間する
  // （区画の境目で明るさが段になるのを防ぐ）。gray をその場で書き換える
  function claheGray(gray, width, height, maxTilesX, maxTilesY) {
    // 区画が細すぎる・低すぎると 1 区画にバーとスペースが両方入らないので、減らす
    const tilesX = Math.max(1, Math.min(maxTilesX, Math.floor(width / 32)));
    const tilesY = Math.max(1, Math.min(maxTilesY, Math.floor(height / 8)));
    const tileW = width / tilesX;
    const tileH = height / tilesY;

    const luts = [];
    const hist = new Float32Array(256);
    for (let ty = 0; ty < tilesY; ty++) {
      const y0 = Math.round(ty * tileH);
      const y1 = Math.round((ty + 1) * tileH);
      for (let tx = 0; tx < tilesX; tx++) {
        const x0 = Math.round(tx * tileW);
        const x1 = Math.round((tx + 1) * tileW);
        const count = (x1 - x0) * (y1 - y0);

        hist.fill(0);
        for (let y = y0; y < y1; y++) {
          const row = y * width;
          for (let x = x0; x < x1; x++) hist[gray[row + x]]++;
        }

        // 切り取った分は全階調に均等に配り直す（総数は変わらない）
        const limit = Math.max(1, (PRE_CLAHE_CLIP * count) / 256);
        let excess = 0;
        for (let v = 0; v < 256; v++) {
          if (hist[v] > limit) {
            excess += hist[v] - limit;
            hist[v] = limit;
          }
        }
        const share = excess / 256;

        const lut = new Uint8Array(256);
        let cdf = 0;
        for (let v = 0; v < 256; v++) {
          cdf += hist[v] + share;
          const c = Math.round((cdf * 255) / count);
          lut[v] = c > 255 ? 255 : c;
        }
        luts.push(lut);
      }
    }

    // 区画の中心の間を線形補間する。端の半区画ぶんは一番近い区画の表をそのまま使う
    const at = (pos, tile, tiles) => {
      const f = pos / tile - 0.5;
      const i0 = Math.floor(f);
      const w = f - i0;
      const a = i0 < 0 ? 0 : i0 >= tiles ? tiles - 1 : i0;
      const b = i0 + 1 < 0 ? 0 : i0 + 1 >= tiles ? tiles - 1 : i0 + 1;
      return { a, b, w };
    };

    for (let y = 0; y < height; y++) {
      const vy = at(y + 0.5, tileH, tilesY);
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const vx = at(x + 0.5, tileW, tilesX);
        const v = gray[row + x];
        const top = luts[vy.a * tilesX + vx.a][v] * (1 - vx.w) + luts[vy.a * tilesX + vx.b][v] * vx.w;
        const bottom = luts[vy.b * tilesX + vx.a][v] * (1 - vx.w) + luts[vy.b * tilesX + vx.b][v] * vx.w;
        gray[row + x] = Math.round(top * (1 - vy.w) + bottom * vy.w);
      }
    }

    return { mode: 'clahe', tilesX, tilesY, clip: PRE_CLAHE_CLIP, applied: true };
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
  // threshold は 1 本（数値。otsu）でも x ごと（配列。adaptive）でもよい
  function measureRuns(profile, threshold) {
    const at = typeof threshold === 'number' ? () => threshold : (i) => threshold[i];
    const runs = [];
    let last = profile[0] <= at(0);
    let start = 0;

    for (let i = 1; i < profile.length; i++) {
      const black = profile[i] <= at(i);
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

    // コントラスト正規化は傾きの測定より先。影やむらを均したほうが上下の帯を突き合わせやすい
    const contrastModeNow = contrastMode();
    const contrastNormalize =
      contrastModeNow === 'stretch' ? stretchGray(gray)
        : contrastModeNow === 'clahe' ? claheGray(gray, width, height, PRE_CLAHE_TILES_X, PRE_CLAHE_TILES_Y)
          : { mode: 'off', applied: false };

    const shear = config.shear ? estimateShear(gray, width, height) : 0;
    let profile = aggregate(gray, width, height, mode, shear);

    const contrast = normalize(profile);
    if (!contrast.ok) {
      // 枠内にバーコードが無いか、バーが横向きで縦の集約に耐えない
      if (config.debug) {
        debugInfo = { mode, contrastNormalize, width, height, shear, contrast, skipped: true };
      }
      return null;
    }

    if (config.smooth) profile = smooth(profile);

    const thresholdMode = THRESHOLD_MODES.includes(config.threshold) ? config.threshold : 'none';
    const threshold = thresholdCurve(profile, thresholdMode);

    // 伸び縮みは二値化より後ではなく先。二値化を先にすると、集約で得た
    // サブピクセルのエッジ位置をそこで捨ててしまう
    // PRE_OUT_WIDTH が null（実寸）なら伸び縮みさせずにそのまま使う
    const outWidth = PRE_OUT_WIDTH ? PRE_OUT_WIDTH - PRE_PAD_X * 2 : width;
    const fit = (values) => (outWidth === width ? values : resample(values, outWidth));
    const scaled = fit(profile);
    const scaledThreshold = threshold.curve ? fit(threshold.curve) : threshold.value;

    const canvas = buildImage(scaled, thresholdMode === 'none' ? null : scaledThreshold);

    if (config.debug) {
      lastOutputCanvas = canvas;
      lastOutput = {
        width: canvas.width,
        height: canvas.height,
        pad: PRE_PAD_X,
        mode,
        contrastNormalize: contrastModeNow,
        time: performance.now()
      };

      // 最細バーの実測は元の尺（＝引き伸ばす前）で出す。
      // otsu / adaptive を選んでいなければ、測るためだけに otsu を 1 本引く
      const hasThreshold = !!threshold.curve || threshold.value !== null;
      const measureAt = hasThreshold ? threshold : thresholdCurve(profile, 'otsu');
      const runs = measureRuns(profile, measureAt.curve || measureAt.value);

      debugInfo = {
        mode,
        contrastNormalize,
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

  // 'contrast-*' モード。素通しの画像（余白・回転込み。2 次元のまま）にコントラスト正規化だけを
  // 掛けて返す。方式はモードで決まる（CONTRAST_ONLY_MODES）。
  // 掛けられなかった（伸ばす幅が無い）ときは null（呼び出し側は素通しの画像をそのまま使う）
  function captureContrastOnly(source, mode) {
    const width = source.width;
    const height = source.height;
    const { canvas, ctx } = contrastOutput;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.drawImage(source, 0, 0);

    const image = ctx.getImageData(0, 0, width, height);
    const data = image.data;
    const gray = toGray(data, width * height);

    const method = CONTRAST_ONLY_MODES[mode];
    const info = method === 'clahe'
      ? claheGray(gray, width, height, PRE_CLAHE_TILES_X, CONTRAST_ONLY_TILES_Y)
      : stretchGray(gray);

    if (config.debug) {
      debugInfo = {
        mode,
        contrastOnly: true,
        contrastNormalize: info,
        width,
        height,
        skipped: !info.applied
      };
    }
    if (!info.applied) return null;

    // 解析側（ZXing / ZXing-C++）は RGBA から同じ係数で輝度を取り直すので、灰色で書き戻す
    for (let i = 0, j = 0; j < gray.length; i += 4, j++) {
      data[i] = gray[j];
      data[i + 1] = gray[j];
      data[i + 2] = gray[j];
      data[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);

    if (config.debug) {
      lastOutputCanvas = canvas;
      lastOutput = {
        width,
        height,
        pad: null,   // 素通しの画像の余白は barcode.js が決めるので、ここでは分からない
        mode,
        contrastNormalize: method,
        time: performance.now()
      };
    }

    return canvas;
  }

  // --- 領域の検出と切り出し（'locate'）---------------------------------
  //
  // 検出枠の中からバーコードが写っている範囲だけを探して切り出し、白の余白を足してから
  // 解析に渡す。OpenCV でよくやる「勾配 → 塊 → 回転矩形 → 切り出し」を手で書いたもの。
  //
  //   1. 検出枠を LOC_MAX_SIDE まで縮めて取り込み、Sobel で勾配を取る
  //   2. LOC_CELL 四方の区画ごとに勾配の構造テンソルを集計し、「勾配が強い」かつ
  //      「向きが 1 方向に揃っている」区画を拾う（＝バーが並んでいる所）
  //   3. 向きの近い隣の区画どうしをつないで塊にし、勾配の総量が一番大きい塊を選ぶ
  //   4. 塊の向き（＝バーと直交する方向）を横軸にした回転矩形を、元映像から
  //      傾きを直して切り出す（バーが縦に立った画像になる）
  //   5. 列ごとの輝度からエッジを拾い、間隔が詰まって並んでいる所（＝バーコード本体）の
  //      最初と最後のエッジで左右を詰める。クワイエットゾーンを越えた先にある
  //      ラベルの縁・台紙・文字はここで落ちる
  //   6. 行ごとのエッジの量で上下も詰め、周りに白の余白を足す
  //
  // 枠いっぱいにバーコードを写したときや、台紙の灰色・ラベルの縁がバーのすぐ隣に
  // 来るときに、クワイエットゾーンを白で作り直せるのが狙い。
  // 傾きは 4 で直すので、ZXing（zxing-js）の 1 フレームおきの 90 度回転も要らない。
  // 見つからなければ null を返し、呼び出し側は素通しの経路に落ちる。
  //
  // 映像を読むのは 1 と 4 の 2 回で、どちらも検出枠（crop）の範囲だけ

  // 1. 検出枠のぶんを縮めて取り込み、灰色にする
  function copyForLocate(video, crop) {
    const { sx, sy, sw, sh } = crop;
    const ratio = Math.min(1, LOC_MAX_SIDE / Math.max(sw, sh));
    const width = Math.max(1, Math.round(sw * ratio));
    const height = Math.max(1, Math.round(sh * ratio));

    const { canvas, ctx } = locateInput;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, width, height);

    const rgba = ctx.getImageData(0, 0, width, height).data;
    // scale は取り込み側の 1px が元映像の何 px にあたるか
    return { gray: toGray(rgba, width * height), width, height, scale: sw / width };
  }

  // 2〜3. バーコードらしい区画の塊を探し、その向きと広がりを返す。
  //
  // 区画ごとの構造テンソル J = Σ[gx², gxgy; gxgy, gy²] から
  //   強さ      (Jxx + Jyy) / 画素数               （勾配の 2 乗平均）
  //   揃い具合  √((Jxx − Jyy)² + 4Jxy²) / (Jxx + Jyy)（1 なら全画素の勾配が同じ向き）
  //   向き      φ = atan2(2Jxy, Jxx − Jyy)          （勾配の角度の 2 倍。θ と θ+180° を同じに扱う）
  // を出す。バーコードはどの区画も「強く・揃っていて・同じ向き」になる
  function findRegion(gray, width, height) {
    const cell = LOC_CELL;
    const cols = Math.floor(width / cell);
    const rows = Math.floor(height / cell);
    if (cols < 2 || rows < 2) return { found: false, reason: 'small', cells: [] };

    const count = cols * rows;
    const jxx = new Float32Array(count);
    const jyy = new Float32Array(count);
    const jxy = new Float32Array(count);

    const xEnd = Math.min(cols * cell, width - 1);
    const yEnd = Math.min(rows * cell, height - 1);
    for (let y = 1; y < yEnd; y++) {
      const base = ((y / cell) | 0) * cols;
      const row = y * width;
      for (let x = 1; x < xEnd; x++) {
        const i = row + x;
        const tl = gray[i - width - 1];
        const tr = gray[i - width + 1];
        const bl = gray[i + width - 1];
        const br = gray[i + width + 1];
        // Sobel を 8 で割って「輝度/px」の尺にしておく（しきい値を読みやすくするため）
        const gx = (tr + 2 * gray[i + 1] + br - tl - 2 * gray[i - 1] - bl) / 8;
        const gy = (bl + 2 * gray[i + width] + br - tl - 2 * gray[i - width] - tr) / 8;
        const c = base + ((x / cell) | 0);
        jxx[c] += gx * gx;
        jyy[c] += gy * gy;
        jxy[c] += gx * gy;
      }
    }

    const area = cell * cell;
    const energy = new Float32Array(count);
    const phi = new Float32Array(count);
    const candidate = new Uint8Array(count);
    for (let c = 0; c < count; c++) {
      const sum = jxx[c] + jyy[c];
      energy[c] = sum / area;
      if (energy[c] < LOC_MIN_ENERGY) continue;
      const diff = jxx[c] - jyy[c];
      const coherence = Math.sqrt(diff * diff + 4 * jxy[c] * jxy[c]) / sum;
      if (coherence < LOC_MIN_COHERENCE) continue;
      phi[c] = Math.atan2(2 * jxy[c], diff);
      candidate[c] = 1;
    }

    // 向きの近い隣（8 近傍）どうしをつなぐ。φ は角度の 2 倍なので、差も 2 倍で比べる
    const maxDiff = (LOC_MAX_ANGLE * 2 * Math.PI) / 180;
    const similar = (a, b) => {
      let d = Math.abs(phi[a] - phi[b]);
      if (d > Math.PI) d = Math.PI * 2 - d;
      return d <= maxDiff;
    };

    const label = new Int32Array(count).fill(-1);
    const stack = [];
    let best = null;
    let anyCandidate = false;

    for (let start = 0; start < count; start++) {
      if (!candidate[start] || label[start] >= 0) continue;
      anyCandidate = true;

      const cells = [];
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      let total = 0;
      label[start] = start;
      stack.push(start);
      while (stack.length) {
        const c = stack.pop();
        cells.push(c);
        sxx += jxx[c];
        syy += jyy[c];
        sxy += jxy[c];
        total += energy[c];

        const cx = c % cols;
        const cy = (c / cols) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = cy + dy;
          if (ny < 0 || ny >= rows) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            if ((!dx && !dy) || nx < 0 || nx >= cols) continue;
            const n = ny * cols + nx;
            if (!candidate[n] || label[n] >= 0 || !similar(c, n)) continue;
            label[n] = start;
            stack.push(n);
          }
        }
      }

      if (cells.length < LOC_MIN_CELLS) continue;
      if (best && total <= best.total) continue;

      // 塊全体の向き。θ は勾配の向き（＝バーと直交する方向）
      const theta = Math.atan2(2 * sxy, sxx - syy) / 2;
      const region = measureRegion(cells, cols, theta);
      // ラベルの縁のような 1 本の強いエッジは、バーと直交する方向に薄い塊になる
      if ((region.uMax - region.uMin) / cell < LOC_MIN_WIDTH_CELLS) continue;

      best = { ...region, cells, total, theta };
    }

    if (!best) {
      return { found: false, reason: anyCandidate ? 'small' : 'none', cells: [], cols };
    }
    return { found: true, cols, ...best };
  }

  // 塊を、向き theta の回転矩形として測る。
  // 返すのは取り込み側の座標で、中心 (cx, cy) と、そこからの u（バーと直交）・v（バーに沿う）
  // 方向の広がり。区画の中心の広がりに、区画そのものの半幅を足してある
  function measureRegion(cells, cols, theta) {
    const cell = LOC_CELL;
    const u = { x: Math.cos(theta), y: Math.sin(theta) };
    const v = { x: -u.y, y: u.x };

    let cx = 0;
    let cy = 0;
    for (const c of cells) {
      cx += ((c % cols) + 0.5) * cell;
      cy += (((c / cols) | 0) + 0.5) * cell;
    }
    cx /= cells.length;
    cy /= cells.length;

    let uMin = Infinity;
    let uMax = -Infinity;
    let vMin = Infinity;
    let vMax = -Infinity;
    for (const c of cells) {
      const dx = ((c % cols) + 0.5) * cell - cx;
      const dy = (((c / cols) | 0) + 0.5) * cell - cy;
      const pu = dx * u.x + dy * u.y;
      const pv = dx * v.x + dy * v.y;
      if (pu < uMin) uMin = pu;
      if (pu > uMax) uMax = pu;
      if (pv < vMin) vMin = pv;
      if (pv > vMax) vMax = pv;
    }

    const half = (cell / 2) * (Math.abs(u.x) + Math.abs(u.y));
    return {
      cx,
      cy,
      u,
      v,
      uMin: uMin - half,
      uMax: uMax + half,
      vMin: vMin - half,
      vMax: vMax + half
    };
  }

  // 4. 回転矩形を元映像から切り出す。バーと直交する方向（u）が横になるように置くので、
  // 出てくる画像はバーが縦に立っている。横（u）は LOC_MAX_WIDTH まで実寸、
  // 縦（v）は LOC_MAX_HEIGHT まで縮める（バーに沿って縮めるだけなので細らない）。
  // 左右は LOC_SEARCH_MARGIN 区画ぶん広めに取る（5 で詰める）
  function extractRegion(video, crop, region, scale) {
    const margin = LOC_SEARCH_MARGIN * LOC_CELL;
    const uMin = region.uMin - margin;
    const uMax = region.uMax + margin;
    const { u, v } = region;

    // 矩形の中心（元映像の座標）
    const mu = (uMin + uMax) / 2;
    const mv = (region.vMin + region.vMax) / 2;
    const centerX = crop.sx + (region.cx + mu * u.x + mv * v.x) * scale;
    const centerY = crop.sy + (region.cy + mu * u.y + mv * v.y) * scale;

    const uLen = (uMax - uMin) * scale;
    const vLen = (region.vMax - region.vMin) * scale;
    const su = Math.min(1, LOC_MAX_WIDTH / uLen);
    const sv = Math.min(su, LOC_MAX_HEIGHT / vLen);
    const width = Math.max(3, Math.round(uLen * su));
    const height = Math.max(3, Math.round(vLen * sv));

    const { canvas, ctx } = locateExtract;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    // 検出枠の外にはみ出したところは白のままにする（映像は crop の範囲しか読まない）
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);

    // 元映像の点 P を、出力の (su·(P−C)·u + W/2, sv·(P−C)·v + H/2) に写す
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.setTransform(
      su * u.x, sv * v.x,
      su * u.y, sv * v.y,
      width / 2 - su * (centerX * u.x + centerY * u.y),
      height / 2 - sv * (centerX * v.x + centerY * v.y)
    );
    ctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, crop.sx, crop.sy, crop.sw, crop.sh);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const rgba = ctx.getImageData(0, 0, width, height).data;

    // 切り出した画像の点 (x, y) を取り込み側の座標に戻す（検証用の枠を描くため）
    const k = scale;
    const inputCx = region.cx + mu * u.x + mv * v.x;
    const inputCy = region.cy + mu * u.y + mv * v.y;
    const toInput = (x, y) => {
      const du = (x - width / 2) / (su * k);
      const dv = (y - height / 2) / (sv * k);
      return { x: inputCx + du * u.x + dv * v.x, y: inputCy + du * u.y + dv * v.y };
    };

    return { gray: toGray(rgba, width * height), width, height, su, sv, toInput };
  }

  // 5. 左右を詰める。列ごとの輝度（上下の端を避けて真ん中の半分の平均）の段差から
  // エッジを拾い、エッジの間隔が LOC_GAP_FACTOR x 中央値を超えたところで区切る。
  // バーコードの中の間隔は要素の幅（1〜4 モジュール）までだが、外側にはクワイエットゾーン
  // （7〜10 モジュール以上）があるので、エッジが一番多く詰まっている区切りがバーコード本体になる
  function trimColumns(gray, width, height) {
    const y0 = Math.floor(height / 4);
    const y1 = Math.max(y0 + 1, Math.ceil((height * 3) / 4));
    const profile = new Float32Array(width);
    for (let y = y0; y < y1; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) profile[x] += gray[row + x];
    }
    for (let x = 0; x < width; x++) profile[x] /= y1 - y0;

    // 2px あたりの段差。しきい値は段差の大きいほうから 1 割の値を基準にする
    const diff = new Float32Array(width);
    for (let x = 1; x < width - 1; x++) diff[x] = profile[x + 1] - profile[x - 1];
    const sorted = Array.from(diff, Math.abs).sort((a, b) => a - b);
    const threshold = Math.max(LOC_EDGE_MIN, LOC_EDGE_REL * sorted[Math.floor(sorted.length * 0.9)]);

    // しきい値を超えた同じ向きの段差の連なりを 1 本のエッジとし、一番急なところに置く。
    // 向き（signs）は、左から見て明→暗が -1、暗→明が +1
    const edges = [];
    const signs = [];
    let runSign = 0;
    let runPeak = 0;
    let runAt = 0;
    for (let x = 1; x < width; x++) {
      const d = x < width - 1 ? diff[x] : 0;
      const sign = Math.abs(d) >= threshold ? Math.sign(d) : 0;
      if (sign !== runSign) {
        if (runSign) {
          edges.push(runAt);
          signs.push(runSign);
        }
        runSign = sign;
        runPeak = 0;
      }
      if (sign && Math.abs(d) > runPeak) {
        runPeak = Math.abs(d);
        runAt = x;
      }
    }

    if (edges.length < LOC_MIN_EDGES) return { found: false, edges: edges.length, threshold };

    const gaps = [];
    for (let i = 1; i < edges.length; i++) gaps.push(edges[i] - edges[i - 1]);
    const gap = gaps.slice().sort((a, b) => a - b)[gaps.length >> 1];
    const limit = Math.max(3, gap * LOC_GAP_FACTOR);

    // エッジが一番多く詰まっている区切りを選ぶ
    let bestFrom = 0;
    let bestTo = 0;
    let from = 0;
    for (let i = 1; i <= edges.length; i++) {
      if (i < edges.length && edges[i] - edges[i - 1] <= limit) continue;
      if (i - from > bestTo - bestFrom) {
        bestFrom = from;
        bestTo = i;
      }
      from = i;
    }

    // バーコードは必ずバーで始まりバーで終わるので、最初のエッジは明→暗、最後は暗→明になる。
    // そうでない端のエッジは外側のもの（余白が狭いときの、ラベルの縁と暗い背景の境目など）なので削る。
    // 削ったエッジがあれば、切る位置はそのエッジとの中点より外へは出さない
    let first = bestFrom;
    let last = bestTo - 1;
    while (first < last && signs[first] > 0) first++;
    while (last > first && signs[last] < 0) last--;

    const found = last - first + 1;
    if (found < LOC_MIN_EDGES) return { found: false, edges: found, threshold, gap };

    // 端のバーのぼけた裾を削らないよう、最初と最後のエッジから間隔 1 つぶん外で切る
    const margin = Math.max(2, Math.round(gap));
    let left = edges[first] - margin;
    let right = edges[last] + margin;
    if (first > bestFrom) left = Math.max(left, Math.ceil((edges[first - 1] + edges[first]) / 2));
    if (last < bestTo - 1) right = Math.min(right, Math.floor((edges[last] + edges[last + 1]) / 2));

    return {
      found: true,
      left: Math.max(0, left),
      right: Math.min(width - 1, right),
      edges: found,
      threshold,
      gap
    };
  }

  // 6. 上下を詰める。left〜right の範囲で行ごとに横の段差の総量を取り、
  // 多い行（上位 1 割の値の半分以上）が一番長く続いているところを残す。
  // バーの上下にある文字や台紙はここで落ちる（2 行までの途切れは続いているとみなす）
  function trimRows(gray, width, height, left, right) {
    const span = Math.max(1, right - left);
    const score = new Float32Array(height);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      let sum = 0;
      for (let x = left; x < right; x++) sum += Math.abs(gray[row + x + 1] - gray[row + x]);
      score[y] = sum / span;
    }

    const sorted = Array.from(score).sort((a, b) => a - b);
    const threshold = sorted[Math.floor(sorted.length * 0.9)] * 0.5;

    let best = { top: 0, bottom: height - 1, length: 0 };
    let top = -1;
    let last = -1;
    for (let y = 0; y <= height; y++) {
      const hit = y < height && score[y] >= threshold;
      if (hit) {
        if (top < 0 || y - last > 3) top = y;
        last = y;
        if (last - top + 1 > best.length) best = { top, bottom: last, length: last - top + 1 };
      }
    }

    // 残る行が少なすぎるときは詰めない（読み取りには何行かあったほうがよい）
    if (best.length < 3) return { top: 0, bottom: height - 1 };
    return { top: best.top, bottom: best.bottom };
  }

  // 'locate' の 1 枚を作る。見つからなければ null（呼び出し側は素通しの経路に落ちる）
  function captureLocated(video, crop) {
    const input = copyForLocate(video, crop);
    const region = findRegion(input.gray, input.width, input.height);

    // 検証用。取り込んだ画像（view）の上に、拾った区画と切り出した矩形を重ねて見せる。
    // view は作業用 canvas をそのまま指すので、次のフレームで書き換わる
    // （app.js は capturePreview() の直後に読むので、同じフレームのものが見える）
    const cellsOf = (list, cols) =>
      list.map((c) => ({ x: (c % cols) * LOC_CELL, y: ((c / cols) | 0) * LOC_CELL }));
    const base = {
      mode: 'locate',
      locate: true,
      view: locateInput.canvas,
      width: input.width,
      height: input.height,
      cellSize: LOC_CELL
    };

    if (!region.found) {
      if (config.debug) debugInfo = { ...base, skipped: true, reason: region.reason, cells: [] };
      return null;
    }

    const cells = config.debug ? cellsOf(region.cells, region.cols) : null;

    // 区画から測った向きは、取り込みで 2px 前後まで細ったバーの階段状のギザギザに
    // 引っ張られて水平・垂直寄りに出る（合成画像で 12° が 10.2° になった。高さ 110px の
    // バーなら上下で 3.5px、1 モジュールを超えてずれる）。
    // そこで一度切り出してから、上下の帯のずれ（前処理の estimateShear と同じもの）で
    // 残った傾きを測り、向きを直して切り出し直す
    let extract = extractRegion(video, crop, region, input.scale);
    const shear = estimateShear(extract.gray, extract.width, extract.height);
    if (shear) {
      // 上下の帯（それぞれ高さの 1/4）の中心どうしの間隔
      const span = extract.height - (extract.height >> 2);
      // 下へ行くほどバーが右（+u）へずれているなら、バーの向き v を u 側へ δ だけ倒す ＝ θ から δ を引く
      const delta = Math.atan2(shear / extract.su, span / extract.sv);
      const theta = region.theta - delta;
      const u = { x: Math.cos(theta), y: Math.sin(theta) };
      region.theta = theta;
      region.u = u;
      region.v = { x: -u.y, y: u.x };
      extract = extractRegion(video, crop, region, input.scale);
    }
    const angle = (region.theta * 180) / Math.PI;
    const corners = (x0, y0, x1, y1) => [
      extract.toInput(x0, y0), extract.toInput(x1, y0),
      extract.toInput(x1, y1), extract.toInput(x0, y1)
    ];
    const searchBox = config.debug ? corners(0, 0, extract.width, extract.height) : null;

    const columns = trimColumns(extract.gray, extract.width, extract.height);
    if (!columns.found) {
      if (config.debug) {
        debugInfo = {
          ...base, skipped: true, reason: 'edges', cells, searchBox, angle, edges: columns.edges
        };
      }
      return null;
    }

    const { top, bottom } = trimRows(
      extract.gray, extract.width, extract.height, columns.left, columns.right
    );

    const w = columns.right - columns.left + 1;
    const h = bottom - top + 1;
    const pad = Math.max(LOC_PAD_X, Math.round(columns.gap * LOC_PAD_GAPS));
    const { canvas, ctx } = locateOutput;
    const outWidth = w + pad * 2;
    const outHeight = h + LOC_PAD_Y * 2;
    if (canvas.width !== outWidth || canvas.height !== outHeight) {
      canvas.width = outWidth;
      canvas.height = outHeight;
    }
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, outWidth, outHeight);
    ctx.drawImage(locateExtract.canvas, columns.left, top, w, h, pad, LOC_PAD_Y, w, h);

    if (config.debug) {
      lastOutputCanvas = canvas;
      lastOutput = {
        width: outWidth,
        height: outHeight,
        pad,
        mode: 'locate',
        time: performance.now()
      };
      debugInfo = {
        ...base,
        skipped: false,
        cells,
        searchBox,
        box: corners(columns.left, top, columns.right + 1, bottom + 1),
        angle,
        edges: columns.edges,
        gap: columns.gap,
        // 切り出した画像の横 1px が元映像の何 px にあたるか（1 なら実寸）
        srcScale: extract.su,
        cut: { width: w, height: h },
        pad,
        padY: LOC_PAD_Y,
        out: { width: outWidth, height: outHeight }
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
  // 'ab' / 'ab-locate' でも見るときは必ず前処理ありのほうを出す
  async function filter(frame) {
    const current = currentChoice();
    const mode = frame.preview && AB_CHOICES[current] ? AB_CHOICES[current] : modeForFrame();

    let canvas = null;
    let source = null;
    if (CONTRAST_ONLY_MODES[mode]) {
      // plain() は呼ぶたびに回転の向きを入れ替えるので、1 フレームにつき 1 回だけ呼ぶ
      const plain = frame.plain();
      canvas = plain ? captureContrastOnly(plain, mode) : null;
      source = canvas || plain;
    } else if (mode === 'locate') {
      canvas = captureLocated(frame.video, frame.crop);
      source = canvas || frame.plain();
    } else {
      canvas = mode ? capture(frame.video, frame.crop, mode) : null;
      source = canvas || frame.plain();
    }
    // 検出画像の表示用に作ったもの（解析には渡していない）かどうか。getLastOutput で見分ける
    if (canvas && lastOutput) lastOutput.preview = !!frame.preview;
    if (!source) return null;

    const result = await frame.analyze(source);

    if (!frame.preview) {
      recordAttempt(!!canvas, !!result);
      // 'ab' の入れ替えは解析が終わってから。途中で入れ替えると、
      // 落ちた（＝素通しに回った）フレームのぶんだけ偏る
      if (AB_CHOICES[current]) useNext = !useNext;
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
