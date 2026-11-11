"""Low-cost frontal face hints, not biometric or ID-standard certification."""
import cv2
import numpy as np

cv2.setNumThreads(1)
detector = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
if detector.empty():
    raise RuntimeError('Face detector unavailable')


def detect_faces(image):
    # Keep detector CPU/memory bounded; coordinates refer to the complete input.
    width, height = image.size
    scale = min(1, 640 / max(width, height))
    size = (max(1, round(width * scale)), max(1, round(height * scale)))
    gray = cv2.cvtColor(np.asarray(image.resize(size)), cv2.COLOR_RGB2GRAY)
    faces = detector.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=6, minSize=(32, 32))
    boxes = sorted(faces, key=lambda box: int(box[2]) * int(box[3]), reverse=True)
    # Ignore tiny background detections relative to the main subject.
    if len(boxes):
        largest = int(boxes[0][2]) * int(boxes[0][3])
        boxes = [box for box in boxes if int(box[2]) * int(box[3]) >= largest * .3]
    return [{'x': float(x / size[0]), 'y': float(y / size[1]),
             'width': float(w / size[0]), 'height': float(h / size[1])}
            for x, y, w, h in boxes]


def portrait_region(image, faces):
    """Use one face to focus the single matte inference, retaining hair context.

    This avoids spending most model pixels on a wide photo's background. It is
    not the final ID crop; the client refines that using the resulting alpha.
    """
    if len(faces) != 1:
        return image, None
    face = faces[0]
    width, height = image.size
    region_h = min(height, max(32, round(face['height'] * height * 3.5)))
    region_w = min(width, max(32, round(max(face['width'] * width * 3, region_h * .75))))
    left = max(0, min(width - region_w, round((face['x'] + face['width'] / 2) * width - region_w / 2)))
    top = max(0, min(height - region_h, round((face['y'] - face['height'] * .8) * height)))
    return image.crop((left, top, left + region_w, top + region_h)), {
        'x': left / width, 'y': top / height, 'width': region_w / width, 'height': region_h / height}
