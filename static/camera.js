const video = document.getElementById("video");
const canvas = document.getElementById("canvas");

navigator.mediaDevices.getUserMedia({
  video: {
    facingMode: "user",
    width: { ideal: 720 },
    height: { ideal: 960 },
    aspectRatio: 3/4
  },
  audio: false
})
.then(stream => {
  video.srcObject = stream;
});

function capture() {
    const ctx = canvas.getContext("2d");

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);   // mirror image

    ctx.drawImage(video, 0, 0);

    const data = canvas.toDataURL("image/png");
    document.getElementById("face_data").value = data;

    document.getElementById("form").submit();
}

