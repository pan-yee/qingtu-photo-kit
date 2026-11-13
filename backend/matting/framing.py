"""Small YuNet face detector and conservative portrait-input checks.

Landmarks only guide crop/pose checks; never identify a person or certify an ID.
"""
import hashlib
from pathlib import Path
import threading
import cv2
import numpy as np

cv2.setNumThreads(1)
FACE_DETECTOR = 'yunet-2023mar'
model = Path(__file__).parent / 'assets/face_detection_yunet_2023mar.onnx'
if hashlib.sha256(model.read_bytes()).hexdigest() != '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4':
    raise RuntimeError('Face detector checksum mismatch')
detector = cv2.FaceDetectorYN.create(str(model), '', (640, 640), .9, .3, 5000)
detect_lock = threading.Lock()


class PortraitInputError(ValueError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def detect_faces(image):
    # Keep detector CPU/memory bounded; coordinates refer to the complete input.
    width, height = image.size
    scale = min(1, 640 / max(width, height))
    size = (max(1, round(width * scale)), max(1, round(height * scale)))
    pixels = cv2.cvtColor(np.asarray(image.resize(size)), cv2.COLOR_RGB2BGR)
    with detect_lock:
        detector.setInputSize(size)
        _, faces = detector.detect(pixels)
    boxes = sorted([] if faces is None else faces, key=lambda box: float(box[2] * box[3]), reverse=True)
    # Ignore tiny background detections relative to the main subject.
    if len(boxes):
        largest = float(boxes[0][2] * boxes[0][3])
        boxes = [box for box in boxes if float(box[2] * box[3]) >= largest * .3]
    return [{'x': max(0., float(box[0] / size[0])), 'y': max(0., float(box[1] / size[1])),
             'width': min(1., float((box[0] + box[2]) / size[0])) - max(0., float(box[0] / size[0])),
             'height': min(1., float((box[1] + box[3]) / size[1])) - max(0., float(box[1] / size[1])),
             'confidence': float(box[14]),
             'clipped': bool(box[0] < 0 or box[1] < 0 or box[0] + box[2] > size[0] or box[1] + box[3] > size[1]),
             'landmarks': [[float(box[i] / size[0]), float(box[i + 1] / size[1])] for i in range(4, 14, 2)]}
            for box in boxes]


def validate_face(image, faces):
    if not faces:
        raise PortraitInputError('MATTING_NO_FACE')
    if len(faces) != 1:
        raise PortraitInputError('MATTING_MULTIPLE_FACES')
    face = faces[0]
    if face['clipped'] or face['y'] < face['height'] * .2:
        raise PortraitInputError('MATTING_INCOMPLETE_HEAD')
    if min(face['width'] * image.width, face['height'] * image.height) < 80:
        raise PortraitInputError('MATTING_IMAGE_TOO_SMALL')
    points = face['landmarks']
    left, right = sorted(points[:2], key=lambda point: point[0])
    eye_width = right[0] - left[0]
    nose_ratio = (points[2][0] - left[0]) / max(eye_width, .00001)
    tilt = abs(right[1] - left[1]) * image.height / max(eye_width * image.width, .00001)
    # Geometry gates reject strong yaw/roll, not a biometric pose estimator.
    if eye_width < face['width'] * .2 or not .05 <= nose_ratio <= .95 or tilt > .35:
        raise PortraitInputError('MATTING_FACE_POSE')


def validate_matte(mask, face, region):
    def local(x, y):
        if region:
            x = (x - region['x']) / region['width']
            y = (y - region['y']) / region['height']
        return round(x * (mask.shape[1] - 1)), round(y * (mask.shape[0] - 1))

    # Inspect inner face, excluding hair/background. Never paint missing pixels back.
    x0, y0 = local(face['x'] + face['width'] * .2, face['y'] + face['height'] * .2)
    x1, y1 = local(face['x'] + face['width'] * .8, face['y'] + face['height'] * .8)
    inner = mask[max(0, y0):min(mask.shape[0], y1 + 1), max(0, x0):min(mask.shape[1], x1 + 1)]
    if not inner.size or float(inner.mean()) < .85 or float((inner > .5).mean()) < .95:
        raise PortraitInputError('MATTING_INCOMPLETE_SUBJECT')
    # Inspect both original and regional top edges. A regional crop can cut hair.
    x0, _ = local(face['x'], 0)
    x1, _ = local(face['x'] + face['width'], 0)
    top = mask[:2, max(0, x0):min(mask.shape[1], x1 + 1)]
    if top.size and float((top > .5).mean()) > .15:
        raise PortraitInputError('MATTING_INCOMPLETE_HEAD')



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
