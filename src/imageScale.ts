export const IMAGE_SCALE_MIN = 80;
export const IMAGE_SCALE_MAX = 160;

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
