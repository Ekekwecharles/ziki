/**
 * Screen capture for the inline idea box (#idea-chat): one frame of a shared
 * screen, tab or window (cropped afterwards with AreaCropper), and a short
 * screen recording kept as a handful of still frames. Attachments are images,
 * PDFs and text only (lib/attachments.ts), so a recording is saved as its
 * frames, not as a video.
 */

/** The longest a recording runs before it stops itself. */
export const MAX_RECORDING_SECONDS = 60;
/** How often a recording keeps a frame, and how many it keeps (an idea takes five attachments). */
const FRAME_EVERY_SECONDS = 3;
const MAX_FRAMES = 4;
/** Frames wider than this are scaled down, so each stays well under the 5 MB upload limit. */
const MAX_FRAME_WIDTH = 1600;

export class CaptureError extends Error {}

function displayMediaOrThrow(): MediaDevices["getDisplayMedia"] {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) {
    throw new CaptureError("Screen capture isn't supported in this browser. Use Chrome, Edge, Firefox or Safari.");
  }
  return navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
}

function friendly(error: unknown, what: string): CaptureError {
  const e = error as { name?: string; message?: string };
  if (error instanceof CaptureError) return error;
  if (e?.name === "NotAllowedError" || e?.name === "AbortError") return new CaptureError(`${what} was cancelled.`);
  return new CaptureError(e?.message || `Couldn't start the ${what.toLowerCase()}. Try again.`);
}

async function playing(stream: MediaStream): Promise<HTMLVideoElement> {
  const video = document.createElement("video");
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 1500);
    video.onloadedmetadata = () => {
      clearTimeout(timer);
      video.play().then(() => resolve(), () => resolve());
    };
  });
  // Let a first frame paint before reading it.
  await new Promise((resolve) => setTimeout(resolve, 150));
  return video;
}

function frameOf(video: HTMLVideoElement, type: "image/png" | "image/jpeg", maxWidth?: number): Promise<Blob | null> {
  const width = video.videoWidth || 1280;
  const height = video.videoHeight || 720;
  const scale = maxWidth && width > maxWidth ? maxWidth / width : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, type, 0.82));
}

/** One frame of the screen, tab or window the person picks, as a PNG to crop. */
export async function captureScreenFrame(): Promise<Blob> {
  const getDisplayMedia = displayMediaOrThrow();
  let stream: MediaStream | null = null;
  try {
    stream = await getDisplayMedia({ video: { displaySurface: "browser" } as MediaTrackConstraints, audio: false });
    const frame = await frameOf(await playing(stream), "image/png");
    if (!frame) throw new CaptureError("Couldn't read the screen. Try again.");
    return frame;
  } catch (error) {
    throw friendly(error, "Screen capture");
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
  }
}

export type ScreenRecording = {
  /** Stops the recording (if it hasn't stopped itself) and gives its frames, oldest first. */
  stop: () => Promise<Blob[]>;
};

/**
 * Records the screen the person picks, keeping a frame every few seconds and
 * the last one when it stops: by the Stop button, by the browser's own "Stop
 * sharing", or after MAX_RECORDING_SECONDS. `onTick` gets the seconds so far;
 * `onEnd` fires when it stops by itself, with the frames.
 */
export async function startScreenRecording({
  onTick,
  onEnd,
}: {
  onTick: (seconds: number) => void;
  onEnd: (frames: Blob[]) => void;
}): Promise<ScreenRecording> {
  const getDisplayMedia = displayMediaOrThrow();
  let stream: MediaStream;
  try {
    stream = await getDisplayMedia({ video: { displaySurface: "browser" } as MediaTrackConstraints, audio: false });
  } catch (error) {
    throw friendly(error, "Screen recording");
  }
  const video = await playing(stream);
  const frames: Blob[] = [];
  const keep = async () => {
    const frame = await frameOf(video, "image/jpeg", MAX_FRAME_WIDTH);
    if (!frame) return;
    // Keep the first frame and the latest ones, so the start and the end both show.
    if (frames.length >= MAX_FRAMES - 1) frames.splice(1, 1);
    frames.push(frame);
  };
  await keep();

  const started = Date.now();
  let finished: Promise<Blob[]> | null = null;
  const finish = (byItself: boolean): Promise<Blob[]> => {
    if (finished) return finished;
    clearInterval(timer);
    finished = (async () => {
      await keep();
      stream.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
      const kept = frames.slice(0, MAX_FRAMES);
      if (byItself) onEnd(kept);
      return kept;
    })();
    return finished;
  };
  const timer = setInterval(() => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    onTick(seconds);
    if (seconds > 0 && seconds % FRAME_EVERY_SECONDS === 0) void keep();
    if (seconds >= MAX_RECORDING_SECONDS) void finish(true);
  }, 1000);
  // The browser's own "Stop sharing" button ends it too.
  const track = stream.getVideoTracks()[0];
  if (track) track.onended = () => void finish(true);

  return { stop: () => finish(false) };
}
