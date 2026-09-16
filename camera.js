(() => {
  'use strict';

  const video = document.getElementById('video');
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const switchBtn = document.getElementById('switchBtn');
  const status = document.getElementById('status');

  let stream = null;
  let facingMode = 'user'; // 'user' = インカメラ, 'environment' = アウトカメラ

  function setStatus(message) {
    status.textContent = message;
  }

  function setRunning(running) {
    startBtn.disabled = running;
    stopBtn.disabled = !running;
    switchBtn.disabled = !running;
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('このブラウザはカメラに対応していません。');
      return;
    }

    stopCamera();
    setStatus('カメラを起動中...');

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: facingMode,
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });

      video.srcObject = stream;
      await video.play();

      // インカメラのときだけ鏡像表示にする
      video.style.transform = facingMode === 'user' ? 'scaleX(-1)' : 'none';

      setRunning(true);

      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings();
      setStatus(`起動中: ${track.label || 'カメラ'} (${settings.width}x${settings.height})`);
    } catch (err) {
      handleError(err);
    }
  }

  function stopCamera() {
    if (!stream) return;

    stream.getTracks().forEach((track) => track.stop());
    stream = null;
    video.srcObject = null;

    setRunning(false);
    setStatus('カメラを停止しました。');
  }

  async function switchCamera() {
    facingMode = facingMode === 'user' ? 'environment' : 'user';
    await startCamera();
  }

  function handleError(err) {
    setRunning(false);

    switch (err.name) {
      case 'NotAllowedError':
        setStatus('カメラの使用が拒否されました。ブラウザの権限設定を確認してください。');
        break;
      case 'NotFoundError':
      case 'OverconstrainedError':
        setStatus('利用できるカメラが見つかりませんでした。');
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
  stopBtn.addEventListener('click', stopCamera);
  switchBtn.addEventListener('click', switchCamera);

  // ページを離れるときにカメラを確実に解放する
  window.addEventListener('pagehide', stopCamera);
})();
