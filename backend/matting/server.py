"""Private, memory-only MODNet ONNX worker. No request/image logging."""
import io
import json
import base64
import threading
import os
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps
from framing import detect_faces, portrait_region, validate_face, validate_matte, PortraitInputError, FACE_DETECTOR
from matte_cleanup import clean_matte

Image.MAX_IMAGE_PIXELS = 24000000
options = ort.SessionOptions()
options.intra_op_num_threads = 2
options.inter_op_num_threads = 1
model_path = os.environ.get('MODNET_MODEL_PATH', '/models/modnet.onnx')
with open(model_path, 'rb') as model_file:
    if hashlib.sha256(model_file.read()).hexdigest() != '07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9':
        raise RuntimeError('MODNet checksum mismatch')
session = ort.InferenceSession(model_path, sess_options=options, providers=['CPUExecutionProvider'])
gate = threading.BoundedSemaphore(1)
admission = threading.BoundedSemaphore(3)  # One processing + at most two waiting.

def matte_image(raw):
    with Image.open(io.BytesIO(raw)) as source:
        if source.format not in ('JPEG', 'PNG') or getattr(source, 'n_frames', 1) != 1:
            raise ValueError('Unsupported image')
        if source.width * source.height > 24000000:
            raise ValueError('Image too large')
        image = ImageOps.exif_transpose(source).convert('RGB')
    faces = detect_faces(image)
    validate_face(image, faces)
    image, region = portrait_region(image, faces)
    width, height = image.size
    # Official MODNet preprocessing: RGB [-1,1], aspect ratio, multiple of 32.
    scale = min(512 / min(width, height), 1024 / max(width, height))
    size = (max(32, int(width * scale) // 32 * 32), max(32, int(height * scale) // 32 * 32))
    values = (np.asarray(image.resize(size, Image.Resampling.BOX), dtype=np.float32) - 127.5) / 127.5
    tensor = values.transpose(2, 0, 1)[None]
    output = session.run(None, {session.get_inputs()[0].name: tensor})[0].squeeze()
    if not np.isfinite(output).all() or (output > .5).mean() < .005:
        raise PortraitInputError('MATTING_INCOMPLETE_SUBJECT')
    validate_matte(output, faces[0], region)
    output = clean_matte(output, faces[0], region)
    validate_matte(output, faces[0], region)
    mask = Image.fromarray(np.rint(np.clip(output, 0, 1) * 255).astype(np.uint8))
    # Return inference-resolution matte; client interpolates continuously, without binarizing.
    result = io.BytesIO()
    mask.save(result, format='PNG')
    return {'ok': True, 'engine': 'modnet', 'width': size[0], 'height': size[1],
            'png': base64.b64encode(result.getvalue()).decode('ascii'), 'faces': faces, 'region': region,
            'protocol': 2, 'faceDetector': FACE_DETECTOR}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.reply(200 if self.path == '/health' else 404, {'ok': self.path == '/health'})

    def do_POST(self):
        if self.path != '/matte':
            return self.reply(404, {'ok': False})
        if not admission.acquire(blocking=False):
            return self.reply(429, {'ok': False, 'code': 'MATTING_BUSY'})
        acquired = False
        try:
            acquired = gate.acquire(timeout=12)
            if not acquired:
                return self.reply(429, {'ok': False, 'code': 'MATTING_BUSY'})
            self.connection.settimeout(30)
            length = int(self.headers.get('Content-Length', 0))
            if not 0 < length <= 10 * 1024 * 1024:
                return self.reply(413, {'ok': False})
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError('Incomplete image')
            self.reply(200, matte_image(raw))
        except PortraitInputError as error:
            self.reply(422, {'ok': False, 'code': error.code})
        except Exception:
            self.reply(422, {'ok': False})
        finally:
            if acquired:
                gate.release()
            admission.release()

if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', 3002), Handler).serve_forever()
