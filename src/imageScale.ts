export const IMAGE_SCALE_MIN = 80;
export const IMAGE_SCALE_MAX = 160;

export function sceneImageLayoutFor(options: {
  contentWidth: number;
  imageAspectRatio: number;
  imageScale: number;
  minimumCardHeight: number;
  maximumCardHeight: number;
  reservedHeight: number;
}) {
  const { contentWidth, imageAspectRatio, imageScale, minimumCardHeight, maximumCardHeight, reservedHeight } = options;
  // Floating social posts grow around the photo. Basing its size on the
  // original, short text area made the entire slider collapse to 80%.
  const heightAt100 = contentWidth / imageAspectRatio / (IMAGE_SCALE_MAX / 100);
  const maximumImageHeight = Math.max(0, Math.min(
    contentWidth / imageAspectRatio,
    maximumCardHeight - reservedHeight,
  ));
  const scaleLimit = Math.min(IMAGE_SCALE_MAX, Math.max(
    IMAGE_SCALE_MIN,
    Math.floor(maximumImageHeight / heightAt100 * 100),
  ));
  const height = Math.min(maximumImageHeight, heightAt100 * imageScale / 100);
  return {
    width: height * imageAspectRatio,
    height,
    cardHeight: Math.max(minimumCardHeight, reservedHeight + height),
    scaleLimit,
  };
}

export function imageScaleLimitForFrame(options: {
  contentWidth: number;
  contentHeight: number;
  imageAspectRatio: number;
  heightBasis: number;
  reservedHeight?: number;
}) {
  const { contentWidth, contentHeight, imageAspectRatio, heightBasis, reservedHeight = 0 } = options;
  if (
    contentWidth <= 0 ||
    contentHeight <= 0 ||
    imageAspectRatio <= 0 ||
    heightBasis <= 0
  ) {
    return IMAGE_SCALE_MAX;
  }

  const maximumImageHeight = Math.min(contentWidth / imageAspectRatio, contentHeight - reservedHeight);
  const imageHeightAt100 = contentHeight * (heightBasis / 100);
  const limit = Math.floor((maximumImageHeight / imageHeightAt100) * 100);
  return Math.min(IMAGE_SCALE_MAX, Math.max(IMAGE_SCALE_MIN, limit));
}
