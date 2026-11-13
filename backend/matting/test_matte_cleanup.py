"""Connectivity cleanup must not erode the attached subject or harden hair."""
import unittest
import numpy as np
from matte_cleanup import clean_matte


class MatteCleanupTests(unittest.TestCase):
    def fixture(self):
        alpha = np.zeros((80, 100), dtype=np.float32)
        alpha[10:75, 30:70] = .99
        face = {'x': .4, 'y': .2, 'width': .2, 'height': .25}
        return alpha, face

    def test_removes_detached_opaque_islands_and_far_background_haze(self):
        alpha, face = self.fixture()
        alpha[25:30, 5:10] = .9
        alpha[5, 90] = .04
        result = clean_matte(alpha, face, None)
        self.assertEqual(float(result[26, 6]), 0)
        self.assertEqual(float(result[5, 90]), 0)
        np.testing.assert_array_equal(result[10:75, 30:70], alpha[10:75, 30:70])

    def test_keeps_translucent_fine_hair_in_subject_margin_without_binarizing(self):
        alpha, face = self.fixture()
        alpha[20, 27:30] = [.02, .05, .2]
        result = clean_matte(alpha, face, None)
        np.testing.assert_array_equal(result[20, 27:30], alpha[20, 27:30])

    def test_selects_face_component_not_larger_background_object(self):
        alpha, face = self.fixture()
        alpha[1:79, :24] = 1
        result = clean_matte(alpha, face, None)
        self.assertEqual(float(result[20, 10]), 0)
        self.assertGreater(result[30, 50], .98)

    def test_region_coordinates_are_mapped_to_model_space(self):
        alpha, _ = self.fixture()
        face = {'x': .45, 'y': .3, 'width': .1, 'height': .125}
        region = {'x': .25, 'y': .2, 'width': .5, 'height': .5}
        alpha[2:4, 90:95] = 1
        result = clean_matte(alpha, face, region)
        self.assertEqual(float(result[2, 91]), 0)
        np.testing.assert_array_equal(result[10:75, 30:70], alpha[10:75, 30:70])

    def test_unreliable_face_seed_does_not_delete_subject_and_source_not_mutated(self):
        alpha, _ = self.fixture()
        before = alpha.copy()
        face = {'x': 0, 'y': 0, 'width': .1, 'height': .1}
        np.testing.assert_array_equal(clean_matte(alpha, face, None), before)
        np.testing.assert_array_equal(alpha, before)


if __name__ == '__main__':
    unittest.main()
