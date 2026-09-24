(() => {
  'use strict';

  // バーコードの前処理。**検討中の機能**なので barcode.js から切り出してある。
  // barcode.js 側にあるのは frameFilter という差し込み口 1 つだけで、そこに
  // BarcodePreprocess.filter を渡したときだけ動く。渡さなければ（またはこのファイルを
  // 読み込まなければ）barcode.js は素通しの画像をそのまま解析する。
  //
  // 前処理は段（stage）を並べたパイプラインで、段ごとに有効・無効を切り替えられる。
  // 掛ける順は決まっていて（STAGES）、有効な段だけを上から順に通す。
  // **全部の段を無効にしたものが「前処理なし」**（素通しの画像をそのまま解析する）。
  //
  //   入力      領域検出が有効で見つかればその切り出し、縦集約だけが有効なら縦に潰した取り込み、
  //             それ以外は素通しの画像（frame.plain()）
  //   locate    領域検出。枠の中からバーコードの範囲を探し、傾きを直して切り出す
  //   contrast  コントラスト調整。'stretch'（線形に伸ばす）| 'clahe'（区画ごとに平坦化）
  //   aggregate 縦集約。高さ方向を 1 本の波形にまとめて画像を作り直す。'median' | 'mean' | 'trimmed'
  //   pad       余白。左右（と上下）に白を足して、クワイエットゾーンを作り直す
  //
  //   BarcodePreprocess.configure({
  //     stages,        // 有効にする段の名前の配列（例: ['locate', 'pad']）。既定は保存値。無ければ [] ＝ 前処理なし
  //     contrast,      // コントラスト調整の方式。'stretch'（既定）| 'clahe'
  //     aggregate,     // 縦集約の方式。'median'（既定）| 'mean' | 'trimmed'
  //     compare,       // A/B 比較。1 フレームおきに素通しと入れ替えて検出率を数える（既定 false）
  //     threshold,     // 縦集約のあとの二値化。'none'（既定）| 'otsu' | 'adaptive'
  //     smooth,        // 縦集約のあとに 3 タップの平滑化を掛ける（既定 false）
  //     shear,         // 縦集約の傾き（シアー）の補正を入れる（既定 true）
  //     debug,         // 波形などの検証用データを残す（既定 true。本番は false）
  //     storageKey,    // 選択（stages / contrast / aggregate / compare）の保存先。null で保存しない
  //     onChange(state)
  //   });
  //   BarcodeScanner.configure({ frameFilter: BarcodePreprocess.filter });  // 有効にするのはこの 1 行
  //   BarcodePreprocess.setStage(name, enabled) / setMethod(stage, method) / setCompare(enabled)
  //   BarcodePreprocess.getState() / getStages() / getMethods(stage) / getStats() / resetStats()
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
  const PRE_OUT_WIDTH = null;     // 縦集約の出力画像の横幅（余白の段で足す白は含まない）。
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
  const PRE_MAX_SHEAR = 24;       // 傾き補正で許す上下のずれ（入力側の px）。
                                  // ROI の高さが 500px なら約 2.7 度ぶん
  const PRE_TRIM = 0.25;          // trimmed mean で上下から捨てる割合
  const PRE_ADAPTIVE_WINDOW = 48; // adaptive しきい値の窓幅（集約後・伸び縮み前の px）
  const PRE_MIN_CONTRAST = 16;    // 集約した波形の振幅がこれ未満なら縦集約の段を見送る
                                  // （枠内にバーコードが無い・バーが横向きで縦集約に耐えない、のいずれか）。
                                  // コントラスト調整の stretch も、伸ばす幅がこれ未満なら見送る
  const PRE_STRETCH_CLIP = 0.01;  // コントラスト調整 'stretch' で、暗い側・明るい側それぞれ
                                  // 捨てる割合。反射や枠の端の影 1 点に伸ばし幅を引っ張られないため
  const PRE_CLAHE_TILES_X = 8;    // CLAHE の横の区画数。区画の幅（1280px 幅なら 160px）に
                                  // バーとスペースが両方入る程度に粗くしておく
  const PRE_CLAHE_TILES_Y = 1;    // CLAHE の縦の区画数（縦集約のために縦に潰した取り込みのとき）。
                                  // 取り込みが 32 段しかなく、1 段が既に元の十数ラインの平均なので縦には分けない
  const PRE_CLAHE_CLIP = 2.0;     // CLAHE のクリップ上限（1 階調あたりの平均画素数の何倍まで
                                  // 許すか）。上げるほど区画ごとの伸ばし方が強くなり、
                                  // 無地の場所のノイズも持ち上がる
  const CLAHE_TILES_Y_2D = 4;     // CLAHE の縦の区画数（それ以外。素通しの画像や領域検出の切り出しのとき）。
                                  // こちらは切り出した画像そのもの（640x150 程度）なので縦にも分ける

  // 余白の段（pad）。バーコードの左右に白を足して、クワイエットゾーンを作り直す。
  // 検出枠いっぱいにバーコードが写っていると、開始/終了記号の外側に必要な
  // 静止領域まで切り落とされて読めないため。以前は barcode.js の SCAN_PAD_X（ZXing / Quagga2 の
  // 経路だけ）と、領域検出の中（LOC_PAD_*）にそれぞれあったものを、ここに 1 つにまとめた
  const PAD_X = 40;               // 左右に足す白の最小幅（px）
  const PAD_GAPS = 8;             // 領域検出で測ったエッジの間隔の中央値の何倍を左右の余白にするか（PAD_X より
                                  // 広ければこちら）。間隔の中央値がおよそ 1.5〜2 モジュールなので、12〜16 モジュールぶん。
                                  // 領域検出が見つからなかったときは PAD_X だけになる
  const PAD_Y = 8;                // 上下に足す白（px）。1D の読み取りには要らないが、
                                  // 切り口のすぐ上下に文字や台紙が来ないようにしておく

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

  // 前処理の段。**並びがそのまま掛ける順**で、有効な段だけを上から順に通す。
  // 順番を入れ替えられるようにはしていない（どれも前の段の出力を前提にしている）:
  //   locate     一番先。映像から直接切り出すので、他の段の出力は使えない。
  //              出力はバーが縦に立った画像になる（縦集約の前提もこれで満たせる）
  //   contrast   縦集約の前。影やむらを均したほうが、縦集約の傾きの測定で上下の帯を突き合わせやすい
  //   aggregate  余白の前。白の余白まで縦に潰しても意味が無い
  //   pad        一番最後。前の段が切り詰めたぶんも含めて、解析に渡す直前に白を足す
  const STAGES = ['locate', 'contrast', 'aggregate', 'pad'];

  // 縦集約の方式。**mean ではなく median を既定にしてある。** 荒れた印字を合成して測ったところ
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
  const AGGREGATE_METHODS = ['median', 'mean', 'trimmed'];

  // コントラスト調整の方式。
  //   'stretch'  輝度の上下 PRE_STRETCH_CLIP を捨て、残りを 0〜255 に線形に伸ばす
  //   'clahe'    画像を区画に分け、区画ごとにクリップ付きのヒストグラム平坦化を掛けて、
  //              区画の間は線形補間でつなぐ
  //
  // 'stretch' は全体に同じ直線を掛けるだけなので、明るさの順番は変わらない。
  // 中央値の集約とは入れ替えても結果が同じで、集約後の normalize()（最小〜最大を
  // 0〜255 に伸ばす）との違いは「上下の外れ値に引っ張られない」ことだけになる。
  //
  // 'clahe' は場所ごとに伸ばし方を変えるので、影や照明のむらで左右の明るさが
  // 違うときに効く。その代わり階調の写し方が直線でなくなるので、ぼけた縁の
  // 「中間の濃さ」の位置がずれ、バーの太さが偏りうる（読み比べて決めること）
  const CONTRAST_METHODS = ['stretch', 'clahe'];

  // 段ごとに選べる方式（方式の無い段は持たない）
  const METHODS = {
    contrast: CONTRAST_METHODS,
    aggregate: AGGREGATE_METHODS
  };

  // 保存値が無いときの選択。**既定は全部の段が無効（＝前処理なし）**
  const DEFAULT_SETTINGS = {
    stages: [],
    contrast: 'stretch',
    aggregate: 'median',
    compare: false
  };
  const DEFAULT_STORAGE_KEY = 'barcodePreprocess';

  // 伸び縮みさせたあとの二値化（縦集約の段）。**既定は 'none'（＝ 生の輝度をそのまま渡す）。**
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

  // 段の選択（stages / contrast / aggregate / compare）はここではなく settings で持つ
  const config = {
    threshold: 'none',
    smooth: false,
    shear: true,
    debug: true,
    storageKey: DEFAULT_STORAGE_KEY,
    onChange: null
  };

  let configured = false;

  // 縦集約だけが有効なときの入力。検出枠のぶんを、横は実寸のまま・縦だけ PRE_ROWS 段に潰して取り込む。
  // barcode.js の frameBuffer とは別に持つ（寸法がまるで違うので、共用すると
  // A/B 比較のときに 1 フレームおきに canvas の再確保が走る）
  const rowsBuffer = {
    canvas: document.createElement('canvas'),
    ctx: null
  };
  // 縦に大きく縮めるので、素直に平均されるよう平滑化を効かせておく
  // （ここが最近傍になると、集約の材料が「数ラインおきの生ライン」になってしまう）
  rowsBuffer.ctx = rowsBuffer.canvas.getContext('2d', { willReadFrequently: true });
  rowsBuffer.ctx.imageSmoothingEnabled = true;
  rowsBuffer.ctx.imageSmoothingQuality = 'high';

  // 素通しの画像を読むための写し。素通しの画像は barcode.js の作業用 canvas なので、
  // 書き換えずにこちらへ写してから読む（BarcodeDetector の経路では willReadFrequently の無い
  // canvas が来るので、直接 getImageData すると GPU からの読み戻しになる）
  const plainCopy = {
    canvas: document.createElement('canvas'),
    ctx: null
  };
  plainCopy.ctx = plainCopy.canvas.getContext('2d', { willReadFrequently: true });

  // パイプラインの出力（解析に渡す画像）。どの段を通っても最後にここへ書く
  const output = {
    canvas: document.createElement('canvas'),
    ctx: null
  };
  output.ctx = output.canvas.getContext('2d', { willReadFrequently: true });

  // 領域検出の作業用。どれも getImageData される側
  //   locateInput    検出枠のぶんを LOC_MAX_SIDE まで縮めて取り込んだもの（領域を探す材料）
  //   locateExtract  見つけた領域を、元映像から傾きを直して切り出したもの（余白なし）
  const locateInput = { canvas: document.createElement('canvas'), ctx: null };
  const locateExtract = { canvas: document.createElement('canvas'), ctx: null };
  for (const target of [locateInput, locateExtract]) {
    target.ctx = target.canvas.getContext('2d', { willReadFrequently: true });
  }

  let settings = null;     // 選択（DEFAULT_SETTINGS と同じ形）。初めて要るときに保存値から復元する
  let useNext = true;      // A/B 比較のとき、次のフレームで前処理を使うか
  let debugInfo = null;    // 検証用（段ごとの結果・波形・領域検出の重ね描き）
  let lastOutput = null;   // 検証用。最後に作った画像の素性（getLastOutput）

  // 前処理あり／なしの検出率。A/B 比較のときに突き合わせる
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
  //
  // 選択は { stages, contrast, aggregate, compare } の 1 つのオブジェクトで持ち、
  // JSON にして保存する。以前の 1 つの選択値（'median' / 'ab' など）が残っていても、
  // JSON として読めないので既定（前処理なし）に戻る

  // 知らない値は既定に置き換える。stages は STAGES の並び（＝掛ける順）に揃える
  function sanitize(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
      stages: Array.isArray(source.stages)
        ? STAGES.filter((name) => source.stages.includes(name))
        : DEFAULT_SETTINGS.stages.slice(),
      contrast: CONTRAST_METHODS.includes(source.contrast) ? source.contrast : DEFAULT_SETTINGS.contrast,
      aggregate: AGGREGATE_METHODS.includes(source.aggregate) ? source.aggregate : DEFAULT_SETTINGS.aggregate,
      compare: typeof source.compare === 'boolean' ? source.compare : DEFAULT_SETTINGS.compare
    };
  }

  // camera.js / barcode.js と同じ理由で、localStorage は読み書きとも握りつぶす
  function loadSettings() {
    if (!config.storageKey) return sanitize(null);

    try {
      const saved = localStorage.getItem(config.storageKey);
      if (saved) return sanitize(JSON.parse(saved));
    } catch (err) {
      console.warn('前処理設定の読み込みに失敗しました', err);
    }
    return sanitize(null);
  }

  function saveSettings() {
    if (!config.storageKey) return;

    try {
      localStorage.setItem(config.storageKey, JSON.stringify(settings));
    } catch (err) {
      console.warn('前処理設定の保存に失敗しました', err);
    }
  }

  function currentSettings() {
    if (settings === null) settings = loadSettings();
    return settings;
  }

  // configure() で渡された選択を、保存値に上書きする（渡されなかったものは保存値のまま）
  function overrideSettings(options) {
    const next = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (options[key] !== undefined && options[key] !== null) next[key] = options[key];
    }
    if (Object.keys(next).length) settings = sanitize({ ...currentSettings(), ...next });
  }

  // 停止中でも切り替えられる。次のフレームから効く。
  // 選択が変わったら A/B の集計も検証用のデータも捨てる（前の選択のものと混ざらないように）
  function updateSettings(next) {
    settings = sanitize({ ...currentSettings(), ...next });
    saveSettings();
    useNext = true;
    debugInfo = null;
    lastOutput = null;
    resetStats();   // 中で onChange を出す
  }

  function setStage(name, enabled) {
    if (!STAGES.includes(name)) return;

    const current = currentSettings().stages;
    if (current.includes(name) === Boolean(enabled)) return;

    updateSettings({
      stages: enabled ? current.concat(name) : current.filter((stage) => stage !== name)
    });
  }

  // 方式を選べる段（METHODS）の方式を切り替える。段の有効・無効とは別に覚えておく
  function setMethod(stage, method) {
    const methods = METHODS[stage];
    if (!methods || !methods.includes(method) || currentSettings()[stage] === method) return;

    updateSettings({ [stage]: method });
  }

  function setCompare(enabled) {
    if (currentSettings().compare === Boolean(enabled)) return;

    updateSettings({ compare: Boolean(enabled) });
  }

  function getState() {
    const current = currentSettings();
    return {
      stages: current.stages.slice(),   // 有効な段（掛ける順）。空なら前処理なし
      active: current.stages.length > 0,
      contrast: current.contrast,
      aggregate: current.aggregate,
      compare: current.compare,
      threshold: config.threshold,
      smooth: Boolean(config.smooth),
      shear: Boolean(config.shear),
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
  // 返すのは { canvas, width, height, stages, pad, time, preview } | null。
  // stages は実際に効いた段（掛けた順）、pad は余白の段で足した左右の幅（足していなければ 0）。
  // preview が true なら、前回の検出画像の表示用に作ったもので、解析には渡していない。
  // time は performance.now() の時刻。どの段も効かなかったフレーム（領域が見つからない・
  // 振幅不足など）では作り直さないので、古い画像のことがある（time で見分ける）
  function getLastOutput() {
    if (!config.debug || !lastOutput) return null;

    const source = output.canvas;
    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    canvas.getContext('2d').drawImage(source, 0, 0);

    return { canvas, ...lastOutput, stages: lastOutput.stages.slice() };
  }

  // --- 検出率の集計 -----------------------------------------------------
  //
  // A/B 比較（compare）のときだけ意味がある。同じラベルを同じ端末・同じ持ち方で写しながら、
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

  // --- 画像の受け渡し ---------------------------------------------------
  //
  // 段から段へは灰色の画像 { gray, width, height, ... } で受け渡す（gray は Uint8Array。
  // 1 画素 1 バイト）。canvas に戻すのは最後の 1 回だけ（writeOutput()）。
  // 解析側（ZXing / ZXing-C++）も RGBA から同じ係数で輝度を取り直すので、灰色で渡して困ることは無い

  // RGBA から輝度へ。係数は barcode-worker.js（と ZXing 本体）と同じ
  function toGray(rgba, count) {
    const gray = new Uint8Array(count);

    for (let i = 0, j = 0; j < count; i += 4, j++) {
      gray[j] = (306 * rgba[i] + 601 * rgba[i + 1] + 117 * rgba[i + 2] + 512) >> 10;
    }

    return gray;
  }

  // --- コントラスト調整の段（contrast）---------------------------------

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
    // 伸ばす幅が無い（枠内が無地）ときは触らない（この段を見送る）
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

  // コントラスト調整の段。image.gray をその場で書き換え、掛けられたら true を返す
  // （'stretch' で伸ばす幅が無いときは触らない）。
  // 縦に潰した取り込み（squashed）は 32 段しかなく 1 段が既に十数ラインの平均なので、CLAHE を縦には分けない
  function contrastStage(image, method, trace) {
    const info = method === 'clahe'
      ? claheGray(
        image.gray, image.width, image.height,
        PRE_CLAHE_TILES_X, image.squashed ? PRE_CLAHE_TILES_Y : CLAHE_TILES_Y_2D
      )
      : stretchGray(image.gray);

    if (trace) trace.steps.contrast = info;
    return info.applied;
  }

  // --- 縦集約の段（aggregate）-------------------------------------------
  //
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
  // （PRE_MIN_CONTRAST 未満）ときはこの段を見送る（runPipeline() を参照）。

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

  // 行数を count 段に減らす（段ごとに元の行の平均を取る）。中央値の集約は段数の 2 乗で
  // 重くなるので、素通しの画像や領域検出の切り出し（最大 LOC_MAX_HEIGHT 行）はここで
  // PRE_ROWS 段まで減らしてから集約する（縦に潰した取り込みは最初から PRE_ROWS 段）
  function binRows(gray, width, height, count) {
    const out = new Uint8Array(width * count);
    const sums = new Float32Array(width);

    for (let r = 0; r < count; r++) {
      const y0 = Math.floor((r * height) / count);
      const y1 = Math.max(y0 + 1, Math.floor(((r + 1) * height) / count));
      sums.fill(0);
      for (let y = y0; y < y1; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) sums[x] += gray[row + x];
      }

      const n = y1 - y0;
      const base = r * width;
      for (let x = 0; x < width; x++) out[base + x] = Math.round(sums[x] / n);
    }

    return out;
  }

  // 集約した波形から、全行が同じ内容の PRE_OUT_ROWS 行の画像を組み立てる。
  // threshold が null なら生の輝度をそのまま渡し（既定）、そうでなければ黒白に割る
  function buildRows(profile, threshold) {
    const width = profile.length;
    const gray = new Uint8Array(width * PRE_OUT_ROWS);

    for (let x = 0; x < width; x++) {
      const v = threshold === null
        ? profile[x]
        : profile[x] <= (threshold.length ? threshold[x] : threshold) ? 0 : 255;
      gray[x] = v < 0 ? 0 : v > 255 ? 255 : v | 0;
    }
    for (let y = 1; y < PRE_OUT_ROWS; y++) gray.copyWithin(y * width, 0, width);

    return gray;
  }

  // 縦集約の段。作り直した画像を返す。振幅が足りなければ null（この段を見送る）
  function aggregateStage(image, method, trace) {
    const width = image.width;
    let gray = image.gray;
    let height = image.height;
    if (height > PRE_ROWS) {
      gray = binRows(gray, width, height, PRE_ROWS);
      height = PRE_ROWS;
    }

    const shear = config.shear ? estimateShear(gray, width, height) : 0;
    let profile = aggregate(gray, width, height, method, shear);

    const contrast = normalize(profile);
    if (!contrast.ok) {
      // 枠内にバーコードが無いか、バーが横向きで縦の集約に耐えない
      if (trace) trace.steps.aggregate = { applied: false, method, width, height, shear, contrast };
      return null;
    }

    if (config.smooth) profile = smooth(profile);

    const thresholdMode = THRESHOLD_MODES.includes(config.threshold) ? config.threshold : 'none';
    const threshold = thresholdCurve(profile, thresholdMode);

    // 伸び縮みは二値化より後ではなく先。二値化を先にすると、集約で得た
    // サブピクセルのエッジ位置をそこで捨ててしまう。
    // PRE_OUT_WIDTH が null（実寸）なら伸び縮みさせずにそのまま使う
    const outWidth = PRE_OUT_WIDTH || width;
    const fit = (values) => (outWidth === width ? values : resample(values, outWidth));
    const scaledThreshold = threshold.curve ? fit(threshold.curve) : threshold.value;
    const out = buildRows(fit(profile), thresholdMode === 'none' ? null : scaledThreshold);
    // 集約画像 → 出力画像の横の倍率（1 未満なら縮めている）
    const scale = outWidth / width;

    if (trace) {
      // 最細バーの実測は元の尺（＝引き伸ばす前）で出す。
      // otsu / adaptive を選んでいなければ、測るためだけに otsu を 1 本引く
      const hasThreshold = !!threshold.curve || threshold.value !== null;
      const measureAt = hasThreshold ? threshold : thresholdCurve(profile, 'otsu');

      trace.steps.aggregate = {
        applied: true,
        method,
        width,
        height,
        shear,
        contrast,
        thresholdMode,
        runs: measureRuns(profile, measureAt.curve || measureAt.value),
        scale,
        // 集約画像の 1px が元映像の何 px ぶんか（の逆数）。実機の module width はこれで割り戻す
        srcScale: image.srcScale || null,
        out: { width: outWidth, height: PRE_OUT_ROWS }
      };
      trace.wave = {
        profile,
        threshold: measureAt.curve || measureAt.value,
        thresholdMode,
        // threshold が「実際に渡した画像を作るのに使ったもの」か、
        // 最細バーを測るためだけに引いたものか（thresholdMode が 'none' のとき）
        thresholdIsMeasureOnly: !hasThreshold
      };
    }

    return {
      gray: out,
      width: outWidth,
      height: PRE_OUT_ROWS,
      srcScale: image.srcScale ? image.srcScale * scale : null,
      gap: image.gap ? image.gap * scale : null
    };
  }

  // --- 領域検出の段（locate）--------------------------------------------
  //
  // 検出枠の中からバーコードが写っている範囲だけを探し、傾きを直して切り出す。
  // OpenCV でよくやる「勾配 → 塊 → 回転矩形 → 切り出し」を手で書いたもの。
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
  //   6. 行ごとのエッジの量で上下も詰める
  //
  // 白の余白はこの段では足さない（余白の段の仕事）。5 で測ったエッジの間隔（gap）を
  // 出力に付けておき、余白の段はそれで余白の幅を決める。
  // 枠いっぱいにバーコードを写したときや、台紙の灰色・ラベルの縁がバーのすぐ隣に
  // 来るときに、余白の段と組み合わせてクワイエットゾーンを白で作り直せるのが狙い。
  // 傾きは 4 で直すので、ZXing（zxing-js）の 1 フレームおきの 90 度回転も要らない。
  // 見つからなければ null を返し、パイプラインは素通しの画像を入力にして残りの段を通す。
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

  // 領域検出の段。見つかれば切り出した画像（余白なし・バーが縦に立っている）を返す。
  // 見つからなければ null（パイプラインは素通しの画像を入力にする）
  function locateStage(video, crop, trace) {
    const input = copyForLocate(video, crop);
    const region = findRegion(input.gray, input.width, input.height);

    // 検証用。取り込んだ画像（view）の上に、拾った区画と切り出した矩形を重ねて見せる。
    // view は作業用 canvas をそのまま指すので、次のフレームで書き換わる
    // （app.js は capturePreview() の直後に読むので、同じフレームのものが見える）
    const cellsOf = (list, cols) =>
      list.map((c) => ({ x: (c % cols) * LOC_CELL, y: ((c / cols) | 0) * LOC_CELL }));
    const view = {
      view: locateInput.canvas,
      width: input.width,
      height: input.height,
      cellSize: LOC_CELL
    };

    if (!region.found) {
      if (trace) {
        trace.steps.locate = { applied: false, reason: region.reason };
        trace.locate = { ...view, cells: [] };
      }
      return null;
    }

    const cells = trace ? cellsOf(region.cells, region.cols) : null;

    // 区画から測った向きは、取り込みで 2px 前後まで細ったバーの階段状のギザギザに
    // 引っ張られて水平・垂直寄りに出る（合成画像で 12° が 10.2° になった。高さ 110px の
    // バーなら上下で 3.5px、1 モジュールを超えてずれる）。
    // そこで一度切り出してから、上下の帯のずれ（縦集約の estimateShear と同じもの）で
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
    const searchBox = trace ? corners(0, 0, extract.width, extract.height) : null;

    const columns = trimColumns(extract.gray, extract.width, extract.height);
    if (!columns.found) {
      if (trace) {
        trace.steps.locate = { applied: false, reason: 'edges', angle, edges: columns.edges };
        trace.locate = { ...view, cells, searchBox };
      }
      return null;
    }

    const { top, bottom } = trimRows(
      extract.gray, extract.width, extract.height, columns.left, columns.right
    );

    const width = columns.right - columns.left + 1;
    const height = bottom - top + 1;
    const gray = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      const from = (top + y) * extract.width + columns.left;
      gray.set(extract.gray.subarray(from, from + width), y * width);
    }

    if (trace) {
      trace.steps.locate = {
        applied: true,
        angle,
        edges: columns.edges,
        gap: columns.gap,
        // 切り出した画像の横 1px が元映像の何 px にあたるか（1 なら実寸）
        srcScale: extract.su,
        cut: { width, height }
      };
      trace.locate = {
        ...view,
        cells,
        searchBox,
        box: corners(columns.left, top, columns.right + 1, bottom + 1)
      };
    }

    return { gray, width, height, srcScale: extract.su, gap: columns.gap };
  }

  // --- 余白の段（pad）----------------------------------------------------
  //
  // 画像の周りに白を足して、クワイエットゾーンを作り直す。左右は PAD_X（領域検出が
  // エッジの間隔を測っていれば、その PAD_GAPS 倍のほうが広ければそちら）、上下は PAD_Y。
  // 以前は barcode.js（SCAN_PAD_X。同梱ライブラリの経路だけ）と領域検出の中にあったものを、
  // どのエンジンに渡すときでも同じように掛かる 1 つの段にまとめた。
  //
  // 縦集約と組み合わせるときは注意。以前、縦集約の出力に白の余白（40px）を足していた頃は、
  // 背景が暗い灰色だと読めなくなった（「真っ白な余白の隣に灰色が来る」組み合わせで、
  // ZXing-C++ のヒストグラムの山の割り方が変わったためと推測。確かめてはいない）。
  // 領域検出と組み合わせれば、台紙や背景を切り落としてから白を足すのでこの問題は起きない
  function padStage(image, trace) {
    const padX = Math.max(PAD_X, image.gap ? Math.round(image.gap * PAD_GAPS) : 0);
    const padY = PAD_Y;
    const width = image.width + padX * 2;
    const height = image.height + padY * 2;

    const gray = new Uint8Array(width * height).fill(255);
    for (let y = 0; y < image.height; y++) {
      const from = y * image.width;
      gray.set(image.gray.subarray(from, from + image.width), (y + padY) * width + padX);
    }

    if (trace) trace.steps.pad = { applied: true, padX, padY, out: { width, height } };
    return { gray, width, height, srcScale: image.srcScale, gap: image.gap, pad: padX };
  }

  // --- パイプライン -----------------------------------------------------

  // 縦集約が有効で、領域検出が無効（または見つからなかった）ときの入力。
  // 検出枠のぶんを、横は実寸のまま・縦だけ PRE_ROWS 段に潰して取り込む。
  // 縦の縮小は drawImage（＝ブラウザ側のフィルタ）に任せる。1 段が元の
  // 十数ライン分の平均になるので、この時点で既に印字ムラはかなり均されている。
  // 素通しの画像（barcode.js が MAX_SCAN_SIDE = 640 まで縮めてある）を使わないのは、
  // 細バーの太さが横の解像度でしか決まらないため
  function captureRows(video, crop) {
    const { sx, sy, sw, sh } = crop;

    const dw = Math.max(3, Math.min(sw, PRE_MAX_WIDTH));
    const dh = Math.max(2, Math.min(sh, PRE_ROWS));

    const { canvas, ctx } = rowsBuffer;
    if (canvas.width !== dw || canvas.height !== dh) {
      canvas.width = dw;
      canvas.height = dh;
      // width/height への代入で 2d コンテキストの状態は戻るので、入れ直す
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
    }

    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh);
    const rgba = ctx.getImageData(0, 0, dw, dh).data;

    return {
      gray: toGray(rgba, dw * dh),
      width: dw,
      height: dh,
      squashed: true,
      // 元映像の何分の一の幅で見ているか。最細バーの実測値を元の尺に戻すのに使う
      srcScale: dw / sw
    };
  }

  // 素通しの画像（frame.plain()。回転込み・余白なし）を灰色にする。
  // canvas には素通しの画像そのものを残しておき、どの段も効かなかったときはそれを解析に渡す。
  // plain() は ZXing 経路で呼ぶたびに回転を入れ替えるので、1 フレームに 1 回しか呼ばないこと
  function plainImage(frame) {
    const plain = frame.plain();
    if (!plain || !plain.width || !plain.height) return null;

    const width = plain.width;
    const height = plain.height;
    const { canvas, ctx } = plainCopy;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.drawImage(plain, 0, 0);
    const rgba = ctx.getImageData(0, 0, width, height).data;

    return {
      gray: toGray(rgba, width * height),
      width,
      height,
      canvas: plain,
      // barcode.js は縦横同じ比率で縮めている（回転していても比率は同じ）
      srcScale: Math.max(width, height) / Math.max(frame.crop.sw, frame.crop.sh)
    };
  }

  // 灰色の画像を output.canvas に書き戻す。解析に渡すのはこの canvas
  function writeOutput(image) {
    const { width, height, gray } = image;
    const { canvas, ctx } = output;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const data = ctx.createImageData(width, height);
    const rgba = data.data;
    for (let i = 0, j = 0; j < gray.length; i += 4, j++) {
      rgba[i] = gray[j];
      rgba[i + 1] = gray[j];
      rgba[i + 2] = gray[j];
      rgba[i + 3] = 255;
    }
    ctx.putImageData(data, 0, 0);

    return canvas;
  }

  // 有効な段を STAGES の順に通して、解析に渡す画像を作る。
  // 返すのは { canvas, applied } | null（素通しの画像も作れないときだけ null）。
  // applied は実際に効いた段（掛けた順）。見送った段は入らない:
  //   locate     見つからなければ見送り、素通しの画像（縦集約が有効なら縦に潰した取り込み）を入力にする
  //   contrast   stretch で伸ばす幅が無ければ見送り
  //   aggregate  振幅が足りなければ見送り。入力が縦に潰した取り込みだったときは、それでは解析に
  //              使えないので、素通しの画像から組み直してコントラスト調整を掛け直す
  //   pad        常に効く
  // applied が空なら、canvas は素通しの画像そのもの（書き戻しを省く）
  function runPipeline(frame, current, trace) {
    const on = (name) => current.stages.includes(name);
    const applied = [];
    let image = null;
    let input = 'plain';

    const record = () => {
      if (trace) trace.input = { kind: input, width: image.width, height: image.height };
    };

    if (on('locate')) {
      image = locateStage(frame.video, frame.crop, trace);
      if (image) {
        input = 'locate';
        applied.push('locate');
      }
    }
    if (!image) {
      input = on('aggregate') ? 'rows' : 'plain';
      image = input === 'rows' ? captureRows(frame.video, frame.crop) : plainImage(frame);
      if (!image) return null;
    }
    record();

    if (on('contrast') && contrastStage(image, current.contrast, trace)) applied.push('contrast');

    if (on('aggregate')) {
      const aggregated = aggregateStage(image, current.aggregate, trace);
      if (aggregated) {
        image = aggregated;
        applied.push('aggregate');
      } else if (input === 'rows') {
        // ここまでに効いたのは縦に潰した取り込みへのコントラスト調整だけなので、数え直す
        applied.length = 0;
        input = 'plain';
        image = plainImage(frame);
        if (!image) return null;
        record();
        if (on('contrast') && contrastStage(image, current.contrast, trace)) applied.push('contrast');
      }
    }

    if (on('pad')) {
      image = padStage(image, trace);
      applied.push('pad');
    }

    if (!applied.length) return { canvas: image.canvas, applied };

    const canvas = writeOutput(image);
    if (config.debug) {
      lastOutput = {
        width: canvas.width,
        height: canvas.height,
        stages: applied.slice(),
        pad: image.pad || 0,
        time: performance.now(),
        // 検出画像の表示用に作ったもの（解析には渡していない）かどうか
        preview: Boolean(frame.preview)
      };
    }

    return { canvas, applied };
  }

  // --- barcode.js への差し込み口 ----------------------------------------

  // BarcodeScanner.configure({ frameFilter }) に渡す関数。1 フレームぶんの画像を作り、
  // 解析の呼び出し（frame.analyze）までを引き受ける。前処理を使わないフレーム
  // （全部の段が無効・A/B 比較の素通し側）は frame.plain() の素通しの画像をそのまま解析に回す。
  //
  // frame.preview が true（検出画像の表示）のときは数えず、A/B の入れ替えもしない。
  // A/B 比較でも見るときは必ず前処理ありのほうを出す
  async function filter(frame) {
    const current = currentSettings();
    const usePipeline =
      current.stages.length > 0 && (frame.preview || !current.compare || useNext);

    let canvas = null;
    let applied = [];
    if (usePipeline) {
      const trace = config.debug ? { steps: {}, input: null, locate: null, wave: null } : null;
      const built = runPipeline(frame, current, trace);
      if (built) ({ canvas, applied } = built);
      if (trace) debugInfo = { ...trace, stages: current.stages.slice(), applied: applied.slice() };
    } else {
      canvas = frame.plain();
    }
    if (!canvas) return null;

    const result = await frame.analyze(canvas);

    if (!frame.preview) {
      // どの段も効かなかったフレームは、素通しの画像を解析したものとして数える
      recordAttempt(applied.length > 0, !!result);
      // A/B の入れ替えは解析が終わってから。途中で入れ替えると、
      // 落ちた（＝素通しに回った）フレームのぶんだけ偏る
      if (current.compare) useNext = !useNext;
    }

    return result;
  }

  // --- ライフサイクル ---------------------------------------------------

  function configure(options = {}) {
    // 選択（stages / contrast / aggregate / compare）は config には入れず、settings で持つ
    const rest = { ...options };
    for (const key of Object.keys(DEFAULT_SETTINGS)) delete rest[key];
    Object.assign(config, rest);

    // 保存値の復元は初回だけ（barcode.js の configure と同じ理由）。
    // 渡された選択はその上に重ねる（保存はしない。保存するのは画面から切り替えたときだけ）
    if (!configured) settings = loadSettings();
    overrideSettings(options);

    configured = true;

    // 状態を一度流しておく。呼び出し側はこれでボタンの初期表示を決められる
    emit('onChange', getState());
  }

  window.BarcodePreprocess = {
    configure,
    filter,
    setStage,
    setMethod,
    setCompare,
    getState,
    getStages: () => STAGES.slice(),
    getMethods: (stage) => (METHODS[stage] || []).slice(),
    getStats,
    resetStats,
    getLastOutput
  };
})();
