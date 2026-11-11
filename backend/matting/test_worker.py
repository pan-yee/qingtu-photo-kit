"""Worker regression tests. Requires MODNET_MODEL_PATH and requirements.txt."""
import concurrent.futures
import io
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from PIL import Image
import server
from framing import detect_faces, portrait_region


class WorkerTests(unittest.TestCase):
    def test_blank_has_no_face(self):
        self.assertEqual(detect_faces(Image.new('RGB', (640, 480), 'white')), [])

    def test_face_region_keeps_context_and_stays_in_source_bounds(self):
        image = Image.new('RGB', (1000, 500), 'white')
        roi, region = portrait_region(image, [{'x': .01, 'y': .05, 'width': .1, 'height': .2}])
        self.assertLess(roi.width, image.width)
        self.assertGreaterEqual(region['x'], 0)
        self.assertGreaterEqual(region['y'], 0)
        self.assertLessEqual(region['x'] + region['width'], 1)
        self.assertLessEqual(region['y'] + region['height'], 1)
        self.assertEqual(portrait_region(image, []), (image, None))

    def test_invalid_image_is_rejected(self):
        with self.assertRaises(Exception):
            server.matte_image(b'not an image')
        raw = io.BytesIO()
        Image.new('RGB', (20, 20), 'white').save(raw, 'GIF')
        with self.assertRaisesRegex(ValueError, 'Unsupported'):
            server.matte_image(raw.getvalue())

    def test_serial_inference_with_two_waiters_and_overflow_rejection(self):
        worker = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        thread = threading.Thread(target=worker.serve_forever, daemon=True)
        thread.start()
        release = threading.Event()
        started = threading.Event()
        lock = threading.Lock()
        active = 0
        peak = 0

        def slow_matte(raw):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
            started.set()
            release.wait(4)
            with lock:
                active -= 1
            return {'ok': True}

        def post():
            request = Request(f'http://127.0.0.1:{worker.server_port}/matte', data=b'image')
            try:
                with urlopen(request, timeout=6) as response:
                    return response.status
            except HTTPError as error:
                return error.code

        try:
            with patch.object(server, 'matte_image', slow_matte), concurrent.futures.ThreadPoolExecutor(4) as pool:
                futures = [pool.submit(post)]
                self.assertTrue(started.wait(2))
                futures.extend(pool.submit(post) for _ in range(3))
                # Overflow responds before the first inference is released.
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline and not any(f.done() for f in futures):
                    release.wait(.01)
                overflow = [f.result() for f in futures if f.done()]
                release.set()
                statuses = [f.result() for f in futures]
                self.assertEqual(overflow, [429])
                self.assertEqual(sorted(statuses), [200, 200, 200, 429])
                self.assertEqual(peak, 1)
            # After completion/error, permits are returned and the next request works.
            with patch.object(server, 'matte_image', side_effect=ValueError('invalid')):
                self.assertEqual(post(), 422)
            with patch.object(server, 'matte_image', return_value={'ok': True}):
                self.assertEqual(post(), 200)
        finally:
            release.set()
            worker.shutdown()
            worker.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
