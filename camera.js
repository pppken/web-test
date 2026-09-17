(() => {
  'use strict';

  const frame = document.getElementById('frame');
  const video = document.getElementById('video');
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const switchBtn = document.getElementById('switchBtn');
  const status = document.getElementById('status');

  let stream = null;
  let facingMode = 'environment'; // 既定はリアカメラ ('user' = フロント)

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

      setRunning(true);
      updateStatus();
    } catch (err) {
      handleError(err);
    }
  }

  function stopCamera(options = {}) {
    if (!stream) return;

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

  startBtn.addEventListener('click', startCamera);
  stopBtn.addEventListener('click', () => stopCamera());
  switchBtn.addEventListener('click', switchCamera);

  // 解像度が確定／変化したタイミングで表示を更新する
  video.addEventListener('loadedmetadata', updateStatus);
  video.addEventListener('resize', updateStatus);

  // ページを離れるときにカメラを確実に解放する
  window.addEventListener('pagehide', () => stopCamera({ silent: true }));

  setRunning(false);
})();
