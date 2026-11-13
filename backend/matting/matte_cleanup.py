"""Remove detached background islands without thresholding fine hair alpha."""
import cv2
import numpy as np


def clean_matte(alpha, face, region):
    """Retain the face-connected subject plus a five-pixel soft-hair margin.

    This is connectivity cleanup, not color-keying, erosion or reconstruction.
    Connected background mistakes still need manual correction.
    """
    result = np.clip(np.asarray(alpha, dtype=np.float32), 0, 1).copy()
    height, width = result.shape
    if not face or not np.isfinite(result).all():
        return result
    region = region or {'x': 0, 'y': 0, 'width': 1, 'height': 1}
    x = round((face['x'] + face['width'] * .5 - region['x']) / region['width'] * (width - 1))
    y = round((face['y'] + face['height'] * .5 - region['y']) / region['height'] * (height - 1))
    if not (0 <= x < width and 0 <= y < height) or result[y, x] < .85:
        return result
    count, labels = cv2.connectedComponents((result > .1).astype(np.uint8), connectivity=8)
    if count <= 1:
        return result
    selected = labels[y, x]
    if selected == 0:
        return result
    support = cv2.dilate((labels == selected).astype(np.uint8), np.ones((11, 11), np.uint8))
    result[support == 0] = 0
    return result
