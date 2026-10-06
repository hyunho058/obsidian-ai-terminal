"""Checks the Python test harness itself (scripts/test-python.mjs)."""
import os
import pwd
import sys
import unittest


class HarnessTest(unittest.TestCase):
    def test_python_version_supported(self):
        self.assertGreaterEqual(sys.version_info[:2], (3, 9))

    def test_home_is_isolated(self):
        real_home = pwd.getpwuid(os.getuid()).pw_dir
        self.assertNotEqual(os.path.realpath(os.environ["HOME"]), os.path.realpath(real_home))
        self.assertNotEqual(os.path.realpath(os.path.expanduser("~")), os.path.realpath(real_home))
        self.assertTrue(os.environ["XDG_CONFIG_HOME"].startswith(os.environ["HOME"]))


if __name__ == "__main__":
    unittest.main()
