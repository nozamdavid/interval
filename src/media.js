import {
  CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH,
  StreamTarget, WebMOutputFormat, canEncodeVideo,
} from 'mediabunny';
import demoUrl from '../assets/alpine-dawn.webp';

export { demoUrl };

export async function selectEncoder({ width, height }, fps) {
  const candidates = [
    { codec: 'avc', extension: 'mp4', mimeType: 'video/mp4' },
    { codec: 'vp9', extension: 'webm', mimeType: 'video/webm' },
    { codec: 'vp8', extension: 'webm', mimeType: 'video/webm' },
  ];
  for (const candidate of candidates) {
    if (await canEncodeVideo(candidate.codec, { width, height, bitrate: QUALITY_HIGH, framerate: fps })) {
      return candidate;
    }
  }
  throw new Error('This browser cannot encode video at this size. Try a smaller crop or a browser with WebCodecs video encoding.');
}

export async function encode({ canvas, fps, repeats, images, draw, signal, onProgress, destination, codec, extension }) {
  // Mediabunny closes its target on cancellation too. Keep committing the real file
  // separate so the caller can abort it and preserve an existing destination.
  const target = new StreamTarget(new WritableStream({
    write: chunk => destination.write(chunk),
  }), { chunked: true, chunkSize: 1024 * 1024 });
  const format = extension === 'mp4'
    ? new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 2 })
    : new WebMOutputFormat();
  const output = new Output({ format, target });
  const source = new CanvasSource(canvas, { codec, bitrate: QUALITY_HIGH });
  output.addVideoTrack(source, { frameRate: fps });
  try {
    signal.throwIfAborted();
    await output.start();
    for (const [index, image] of images.entries()) {
      signal.throwIfAborted();
      await draw(image);
      for (let repeat = 0; repeat < repeats; repeat++) {
        signal.throwIfAborted();
        const frame = index * repeats + repeat;
        await source.add(frame / fps, 1 / fps);
      }
      onProgress((index + 1) / images.length);
      // Let the browser paint progress and handle cancellation.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    signal.throwIfAborted();
    source.close();
    await output.finalize();
    signal.throwIfAborted();
  } catch (error) {
    await output.cancel().catch(() => {});
    throw error;
  }
}
