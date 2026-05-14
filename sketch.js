/**
 * Change this to match the file you place in assets/video/
 * (e.g. record.webm, record.mov)
 */
const VIDEO_FILENAME = "vinyl 1_1.webm";

let video;
let videoReady = false;

function setup() {
  createCanvas(windowWidth, windowHeight);
  const path = `assets/video/${encodeURIComponent(VIDEO_FILENAME)}`;
  video = createVideo(path, onVideoLoaded);
  video.hide();
  video.volume(0);
}

function onVideoLoaded() {
  videoReady = true;
  video.loop();
}

function draw() {
  background(30, 58, 138);

  if (videoReady && video.width > 0) {
    containImage(video, 0, 0, width, height);
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

/** Scale image to fit within rect (letterbox/pillarbox). */
function containImage(img, rx, ry, rw, rh) {
  const iw = img.width;
  const ih = img.height;
  const scale = min(rw / iw, rh / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const x = rx + (rw - dw) * 0.5;
  const y = ry + (rh - dh) * 0.5;
  image(img, x, y, dw, dh);
}
