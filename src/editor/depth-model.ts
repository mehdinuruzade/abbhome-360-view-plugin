import { dptInputSize, rgbaToDptTensor, type DepthMap } from '../core/depth';

/**
 * Depth Anything V2 Small (quantized ONNX, about 27 MB) run in the browser with onnxruntime-web.
 * Editor only: loaded on the first "Estimate depth" click, never part of the widget bundle.
 * Preprocessing follows the model's DPT image processor: keep the aspect ratio, scale one side to
 * 518 px, round to multiples of 14, rescale to 0..1 and normalise with ImageNet mean/std. The
 * output (`predicted_depth`) is relative inverse depth: larger values are closer.
 */

export const DEFAULT_MODEL_URL =
  'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model_quantized.onnx';

export interface DepthEstimator {
  estimate(source: HTMLCanvasElement): Promise<DepthMap>;
}

export type DepthProgress = (p: { stage: 'download' | 'prepare' | 'run'; fraction?: number }) => void;

declare global {
  interface Window {
    /** Replaces the built-in estimator entirely (tests, or a host's own). */
    abb360DepthEstimator?: DepthEstimator;
    /** Loads the model from here instead of Hugging Face (e.g. a self-hosted copy). */
    abb360DepthModelUrl?: string;
  }
}

let cached: Promise<DepthEstimator> | null = null;

export function getDepthEstimator(onProgress?: DepthProgress, modelUrl = window.abb360DepthModelUrl ?? DEFAULT_MODEL_URL): Promise<DepthEstimator> {
  if (window.abb360DepthEstimator) return Promise.resolve(window.abb360DepthEstimator);
  cached ??= createOnnxEstimator(modelUrl, onProgress).catch((e: unknown) => {
    cached = null;
    throw e;
  });
  return cached;
}

async function download(url: string, onProgress?: DepthProgress): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`model download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.({ stage: 'download', fraction: total ? received / total : undefined });
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

async function createOnnxEstimator(modelUrl: string, onProgress?: DepthProgress): Promise<DepthEstimator> {
  // The runtime's WebAssembly file is part of the editor build (same origin, no third-party CDN).
  const ort = await import('onnxruntime-web');
  const model = await download(modelUrl, onProgress);
  onProgress?.({ stage: 'prepare' });
  const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
  return {
    async estimate(source) {
      onProgress?.({ stage: 'run' });
      const [w, h] = dptInputSize(source.width, source.height);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('no 2D canvas');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(source, 0, 0, w, h);
      const input = new ort.Tensor('float32', rgbaToDptTensor(ctx.getImageData(0, 0, w, h).data, w, h), [1, 3, h, w]);
      const result = await session.run({ [session.inputNames[0] ?? 'pixel_values']: input });
      const output = result[session.outputNames[0] ?? 'predicted_depth'];
      if (!output) throw new Error('the model returned no depth');
      const dims = output.dims;
      const height = Number(dims[dims.length - 2]);
      const width = Number(dims[dims.length - 1]);
      return { width, height, data: Float32Array.from(output.data as Float32Array) };
    },
  };
}
