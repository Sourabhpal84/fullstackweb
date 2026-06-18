export function formatImageBytes(bytes = 0){
  if(bytes < 1024) return `${bytes} B`;
  if(bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function loadImage(file){
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => resolve({ image, url });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Unable to read this image."));
    };
    image.src = url;
  });
}

function canvasBlob(canvas, type, quality){
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

export async function optimizeImageForUpload(file, {
  maxWidth = 1400,
  maxHeight = 1400,
  quality = .78,
  targetBytes = 700 * 1024
} = {}){
  if(!file?.type?.startsWith("image/")) throw new Error("Choose a valid image.");
  if(file.size <= targetBytes && file.type === "image/webp"){
    return { blob:file, contentType:file.type, extension:"webp", originalBytes:file.size, optimizedBytes:file.size };
  }
  const source = await loadImage(file);
  try{
    const scale = Math.min(1, maxWidth / source.image.naturalWidth, maxHeight / source.image.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(source.image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(source.image.naturalHeight * scale));
    const context = canvas.getContext("2d", { alpha:false });
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source.image, 0, 0, canvas.width, canvas.height);
    let currentQuality = quality;
    let blob = await canvasBlob(canvas, "image/webp", currentQuality);
    while(blob?.size > targetBytes && currentQuality > .46){
      currentQuality = Math.round((currentQuality - .08) * 100) / 100;
      blob = await canvasBlob(canvas, "image/webp", currentQuality);
    }
    if(!blob) throw new Error("Image optimization failed.");
    return {
      blob,
      contentType:"image/webp",
      extension:"webp",
      width:canvas.width,
      height:canvas.height,
      originalBytes:file.size,
      optimizedBytes:blob.size
    };
  }finally{
    URL.revokeObjectURL(source.url);
  }
}
