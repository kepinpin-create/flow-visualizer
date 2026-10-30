// FR-01: turn an uploaded PNG, JPG or PDF into a background image (data URL + size).

export interface PlanImage {
  dataUrl: string;
  width: number;
  height: number;
}

/** Longest side, in pixels, a rasterized PDF page is rendered at. */
const PDF_TARGET_PX = 2000;

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function imageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('The image could not be read.'));
    img.src = dataUrl;
  });
}

async function rasterizePdf(file: File): Promise<PlanImage> {
  // Loaded on demand so pdf.js only downloads when someone uploads a PDF.
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const pdf = await task.promise;
  const page = await pdf.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: PDF_TARGET_PX / Math.max(base.width, base.height) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  await task.destroy();
  return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
}

export async function loadPlan(file: File): Promise<PlanImage> {
  const name = file.name.toLowerCase();
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return rasterizePdf(file);
  if (!/^image\/(png|jpeg)$/.test(file.type) && !/\.(png|jpe?g)$/.test(name)) {
    throw new Error('Upload a PNG, JPG or PDF floor plan.');
  }
  const dataUrl = await readAsDataUrl(file);
  return { dataUrl, ...(await imageSize(dataUrl)) };
}
